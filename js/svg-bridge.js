/**
 * svg-bridge.js — virtual /dev/svg device for WASI WebAssembly modules.
 *
 * Usage:
 *   import { mountSvg } from './svg-bridge.js';
 *
 *   const wasmImports = { wasi_snapshot_preview1: { ...wasi.wasiImport } };
 *   mountSvg(wasmImports, '#canvas', 800, 600, '0 0 800 600');
 *   // Then instantiate your WASM module with wasmImports.
 *
 * The bridge patches the WASI imports to expose a virtual '/dev' preopened
 * directory (fd 3).  When the WASM program opens '/dev/svg' via path_open the
 * bridge assigns a fresh fd and intercepts all fd_write calls on it, parsing
 * each newline-terminated write as an SVG protocol message and applying it to
 * the live DOM <svg>.  All other fds are forwarded to the original handlers.
 *
 * Protocol (each message is newline-terminated):
 *   <tag id="ID" attr="val".../>     — upsert element (self-closing)
 *   <tag id="ID" attr="val"...>TEXT</tag>  — upsert element with text content
 *   <!remove ID>                     — remove element with id ID
 *   <!clear>                         — remove all non-defs children from svg root
 *   <!parent ID>                     — set insertion context to element ID
 *   <!parent-root>                   — reset insertion context to svg root
 *   <!style ID CSS>                  — setAttribute('style', CSS) on element ID
 *   <!transform ID T>                — setAttribute('transform', T) on element ID
 *   <!attr ID NAME VALUE>            — setAttribute(NAME, VALUE) on element ID
 */

import { makeSvgProcessor } from './svg-processor.js';

const SVG_NS  = 'http://www.w3.org/2000/svg';
const DEV_FD   = 3;        // preopened fd advertised as the virtual '/dev' directory
const DEV_NAME = '/dev';   // name returned by fd_prestat_dir_name for DEV_FD

/**
 * mountSvg(wasmImports, selector, width, height, viewBox)
 *
 * @param {object} wasmImports   - The imports object passed to WebAssembly.instantiate.
 *                                 Must contain wasi_snapshot_preview1.fd_write.
 * @param {string} selector      - CSS selector for the host element where the <svg> is mounted.
 * @param {number} width         - SVG width in pixels.
 * @param {number} height        - SVG height in pixels.
 * @param {string} [viewBox]     - SVG viewBox attribute (default: "0 0 <width> <height>").
 * @returns {SVGSVGElement}      - The mounted <svg> element.
 */
export function mountSvg(wasmImports, selector, width, height, viewBox) {
  const host = document.querySelector(selector);
  if (!host) throw new Error(`svg-bridge: no element matches '${selector}'`);

  // Create or reuse an existing <svg>
  let svg = host.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    host.appendChild(svg);
  }
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', viewBox || `0 0 ${width} ${height}`);
  svg.setAttribute('xmlns', SVG_NS);

  // Ensure a <defs> child exists
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }

  // Accumulate bytes from fd_write calls (may arrive in fragments).
  let pending = '';

  const processMessage = makeSvgProcessor(svg, defs);

  // ── fd_write interceptor ───────────────────────────────────────────────────

  let memory = null;        // set when WASM memory is available
  let svgFdAssigned = null;  // fd returned when path_open('/dev/svg') is called
  let nextFd = 5;            // allocate fresh fds starting here

  /**
   * Provide a memory accessor. Call this after instantiation:
   *   bridge.setMemory(instance.exports.memory);
   * Or pass memory in wasmImports.__bridge = bridge and call from WASM glue.
   */
  function setMemory(mem) {
    memory = mem;
  }

  // ── Virtual /dev preopen ───────────────────────────────────────────────────
  // Advertise a preopened directory fd DEV_FD whose name is '/dev'.
  // When path_open(DEV_FD, ..., 'svg', ...) is called the bridge allocates a
  // fresh fd, records it as svgFdAssigned, and intercepts fd_write on it.

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
    // WASI i64 rights values arrive as BigInt; positional args after i64 shift by 1
    // because each i64 occupies one JS argument slot as a BigInt.
    // Detect the actual fdOut slot by inspecting argument count.
    if (dirfd === DEV_FD && memory) {
      const actualPathPtr  = arguments[2];
      const actualPathLen  = arguments[3];
      // i64 fs_rights_base and fs_rights_inheriting each occupy one slot
      // arguments: [0]=dirfd [1]=dirflags [2]=pathPtr [3]=pathLen [4]=oflags
      //            [5]=rights_base(i64) [6]=rights_inh(i64) [7]=fdflags [8]=fd_out
      const actualFdOutPtr = arguments[8];
      const bytes = new Uint8Array(memory.buffer, actualPathPtr, actualPathLen);
      const pathCopy = new Uint8Array(actualPathLen);
      pathCopy.set(bytes);
      const path  = new TextDecoder().decode(pathCopy);
      if (path === 'svg') {
        const fd = nextFd++;
        svgFdAssigned = fd;
        new DataView(memory.buffer).setUint32(actualFdOutPtr, fd, true);
        return 0; // ESUCCESS
      }
    }
    return origPathOpen ? origPathOpen(...arguments) : 58; // ENOTSUP
  };

  const originalFdWrite = wasmImports.wasi_snapshot_preview1.fd_write;

  wasmImports.wasi_snapshot_preview1.fd_write = function (fd, iovs, iovsLen, nwrittenPtr) {
    if (fd !== svgFdAssigned || !memory) {
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
  const bridge = { svg, setMemory };

  // Convenience: auto-capture memory from a WASM instance
  bridge.connectInstance = function (instance) {
    if (instance.exports.memory) {
      setMemory(instance.exports.memory);
    }
  };

  return bridge;
}
