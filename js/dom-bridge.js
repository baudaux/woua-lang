/**
 * dom-bridge.js — virtual /dev/dom device for WASI WebAssembly modules.
 *
 * Usage:
 *   import { mountDom } from './dom-bridge.js';
 *
 *   const wasmImports = { wasi_snapshot_preview1: { ...wasi.wasiImport } };
 *   const bridge = mountDom(wasmImports, '#app-container');
 *   // Then instantiate your WASM module with wasmImports.
 *   bridge.connectInstance(instance);
 *
 * The bridge patches the WASI imports to expose a virtual '/dev' preopened
 * directory (fd 3).  When the WASM program opens '/dev/dom' via path_open the
 * bridge assigns a fresh fd and intercepts all fd_write calls on it, parsing
 * each newline-terminated write as a DOM protocol message and applying it to
 * the live container element.  All other fds are forwarded to the original
 * handlers.
 *
 * Protocol (each message is newline-terminated):
 *   <tag id="ID" attr="val".../>     — upsert element (self-closing)
 *   <tag id="ID" attr="val"...>TEXT</tag>  — upsert element with text content
 *   <!remove ID>                     — remove element with id ID
 *   <!clear>                         — remove all children from root container
 *   <!parent ID>                     — set insertion context to element ID
 *   <!parent-root>                   — reset insertion context to root
 *   <!style ID CSS>                  — setAttribute('style', CSS) on element ID
 *   <!class ID CLASSNAME>            — element.className = CLASSNAME
 *   <!text ID TEXT>                  — element.textContent = TEXT
 *   <!attr ID NAME VALUE>            — setAttribute(NAME, VALUE) on element ID
 *   <!blob BLOB-ID PTR LEN MIME>     — create Blob from WASM memory[PTR..PTR+LEN], register ObjectURL under BLOB-ID
 *
 * Attribute values matching 'blob:BLOB-ID' are resolved to the ObjectURL on element upsert.
 */

import { makeDomProcessor } from './dom-processor.js';

const DEV_FD   = 3;        // preopened fd advertised as the virtual '/dev' directory
const DEV_NAME = '/dev';   // name returned by fd_prestat_dir_name for DEV_FD

/**
 * mountDom(wasmImports, selector)
 *
 * @param {object} wasmImports   - The imports object passed to WebAssembly.instantiate.
 *                                 Must contain wasi_snapshot_preview1.fd_write.
 * @param {string} selector      - CSS selector for the host element where the container
 *                                 div is mounted.
 * @returns {{ container: HTMLElement, setMemory: Function, connectInstance: Function }}
 */
export function mountDom(wasmImports, selector) {
  const host = document.querySelector(selector);
  if (!host) throw new Error(`dom-bridge: no element matches '${selector}'`);

  // Create or reuse a container div
  let container = host.querySelector('div.woua-dom');
  if (!container) {
    container = document.createElement('div');
    container.className = 'woua-dom';
    host.appendChild(container);
  }

  // Accumulate bytes from fd_write calls (may arrive in fragments).
  let pending = '';

  const processMessage = makeDomProcessor(container, () => memory);

  // ── fd_write interceptor ───────────────────────────────────────────────────

  let memory = null;        // set when WASM memory is available
  let domFdAssigned = null; // fd returned when path_open('/dev/dom') is called
  let nextFd = 5;           // allocate fresh fds starting here

  function setMemory(mem) {
    memory = mem;
  }

  // ── Virtual /dev preopen ───────────────────────────────────────────────────
  // Advertise a preopened directory fd DEV_FD whose name is '/dev'.
  // When path_open(DEV_FD, ..., 'dom', ...) is called the bridge allocates a
  // fresh fd, records it as domFdAssigned, and intercepts fd_write on it.

  const origFdPrestatGet     = wasmImports.wasi_snapshot_preview1.fd_prestat_get;
  const origFdPrestatDirName = wasmImports.wasi_snapshot_preview1.fd_prestat_dir_name;
  const origPathOpen         = wasmImports.wasi_snapshot_preview1.path_open;

  wasmImports.wasi_snapshot_preview1.fd_prestat_get = function (fd, buf) {
    if (fd === DEV_FD && memory) {
      // wasi_prestat_t: u8 pr_type (1=dir), 3 bytes pad, u32 pr_name_len
      const dv = new DataView(memory.buffer);
      dv.setUint8(buf,     1);                          // PREOPENTYPE_DIR
      dv.setUint32(buf + 4, DEV_NAME.length, true);    // pr_name_len
      return 0; // ESUCCESS
    }
    return origFdPrestatGet ? origFdPrestatGet(fd, buf) : 8; // EBADF
  };

  wasmImports.wasi_snapshot_preview1.fd_prestat_dir_name = function (fd, pathPtr, pathLen) {
    if (fd === DEV_FD && memory) {
      const mem = new Uint8Array(memory.buffer);
      for (let i = 0; i < DEV_NAME.length && i < pathLen; i++) {
        mem[pathPtr + i] = DEV_NAME.charCodeAt(i);
      }
      return 0; // ESUCCESS
    }
    return origFdPrestatDirName ? origFdPrestatDirName(fd, pathPtr, pathLen) : 8; // EBADF
  };

  wasmImports.wasi_snapshot_preview1.path_open = function (
    dirfd, dirflags, pathPtr, pathLen, oflags,
    rightsBaseLo, rightsBaseHi, rightsInhLo, rightsInhHi,
    fdflags, fdOut
  ) {
    // WASI i64 rights values arrive as BigInt; positional args after i64 shift by 1.
    // arguments: [0]=dirfd [1]=dirflags [2]=pathPtr [3]=pathLen [4]=oflags
    //            [5]=rights_base(i64) [6]=rights_inh(i64) [7]=fdflags [8]=fd_out
    if (dirfd === DEV_FD && memory) {
      const actualPathPtr  = arguments[2];
      const actualPathLen  = arguments[3];
      const actualFdOutPtr = arguments[8];
      const bytes = new Uint8Array(memory.buffer, actualPathPtr, actualPathLen);
      const pathCopy = new Uint8Array(actualPathLen);
      pathCopy.set(bytes);
      const path = new TextDecoder().decode(pathCopy);
      if (path === 'dom') {
        const fd = nextFd++;
        domFdAssigned = fd;
        new DataView(memory.buffer).setUint32(actualFdOutPtr, fd, true);
        return 0; // ESUCCESS
      }
    }
    return origPathOpen ? origPathOpen(...arguments) : 58; // ENOTSUP
  };

  const originalFdWrite = wasmImports.wasi_snapshot_preview1.fd_write;

  wasmImports.wasi_snapshot_preview1.fd_write = function (fd, iovs, iovsLen, nwrittenPtr) {
    if (fd !== domFdAssigned || !memory) {
      return originalFdWrite(fd, iovs, iovsLen, nwrittenPtr);
    }

    const mem = new DataView(memory.buffer);
    let totalWritten = 0;

    for (let i = 0; i < iovsLen; i++) {
      const iovBase = mem.getUint32(iovs + i * 8,     true);
      const iovLen  = mem.getUint32(iovs + i * 8 + 4, true);
      const bytes   = new Uint8Array(memory.buffer, iovBase, iovLen);
      const bytesCopy = new Uint8Array(iovLen);
      bytesCopy.set(bytes);
      const chunk   = new TextDecoder().decode(bytesCopy);
      pending += chunk;
      totalWritten += iovLen;
    }

    // Process complete lines
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      processMessage(line);
    }

    // Write nwritten
    mem.setUint32(nwrittenPtr, totalWritten, true);
    return 0; // ESUCCESS
  };

  // ── Public bridge API ──────────────────────────────────────────────────────
  const bridge = { container, setMemory };

  // Convenience: auto-capture memory from a WASM instance
  bridge.connectInstance = function (instance) {
    if (instance.exports.memory) {
      setMemory(instance.exports.memory);
    }
  };

  return bridge;
}
