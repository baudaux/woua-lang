/**
 * dom_worker.js — Web Worker that runs a woua DOM demo WASM module and
 * posts DOM protocol lines to the main thread for rendering.
 *
 * Protocol messages sent to the main thread:
 *   { type: 'dom',    line: string }   — one DOM protocol line (no newline)
 *   { type: 'blob',   blobId, mime, buffer } — binary asset bytes (transferable ArrayBuffer)
 *   { type: 'css',    text: string }   — raw CSS text to inject into <style id="__wasm-css">
 *   { type: 'ring',   sab: SharedArrayBuffer } — event ring buffer (sent once at startup)
 *   { type: 'listen', elemId, eventType } — attach event listener on DOM element
 *   { type: 'unlisten', elemId, eventType } — remove event listener
 *   { type: 'canvas', id, w, h, ptr }  — create canvas element (ptr=0 manual, ptr≠0 auto)
 *   { type: 'canvas-put', id, buffer, w, h } — transferable RGBA frame for canvas
 *   { type: 'exit',   code: number }   — program exited normally
 *   { type: 'error',  message: string} — runtime error
 *
 * Message received from main thread:
 *   { type: 'start', wasmUrl: string }
 *
 * Ring buffer layout (SharedArrayBuffer, 8 + 4096 bytes):
 *   Int32[0] = write-idx (updated by main thread)
 *   Int32[1] = read-idx  (updated by worker)
 *   Uint8[8..4103] = ring data; event records are tab-separated, newline-terminated
 */

import { makeWasi } from '../js/wasi-min.js';

let domFd      = -1;
let nextFd     = 5; // 0-2 = stdio, 3 = /dev preopen, 4 reserved
let pending    = '';
let wasmMemory = null; // set after WASM instantiation

const canvasMap = new Map(); // id → { ptr, w, h, auto }

// ── Event ring buffer (SPSC: main thread writes, worker reads) ────────────────
const RING_DATA = 4096;
const ringBuf  = new SharedArrayBuffer(8 + RING_DATA);
const ringHdr  = new Int32Array(ringBuf, 0, 2);  // [0]=write-idx, [1]=read-idx
const ringData = new Uint8Array(ringBuf, 8);

// Non-blocking read: copy one record into WASM memory; return 0 if ring empty.
function readFromRing(ptr, maxLen) {
  const N    = RING_DATA;
  const wIdx = Atomics.load(ringHdr, 0);
  const rIdx = Atomics.load(ringHdr, 1);
  if (wIdx === rIdx) return 0; // empty
  const mem = new Uint8Array(wasmMemory.buffer, ptr, maxLen);
  let n = 0;
  let cur = rIdx;
  while (n < maxLen && cur !== wIdx) {
    const byte = ringData[cur % N];
    cur++;
    mem[n++] = byte;
    if (byte === 10) break; // newline = end of record
  }
  Atomics.store(ringHdr, 1, cur);
  return n;
}

// Blocking variant: waits via Atomics.wait until a record is available.
// Used by poll_oneoff fd_read subscriptions; not called by onFdRead directly.
function readFromRingBlocking(ptr, maxLen) {
  while (true) {
    const n = readFromRing(ptr, maxLen);
    if (n > 0) return n;
    Atomics.wait(ringHdr, 0, Atomics.load(ringHdr, 0));
  }
}

const wasi = makeWasi({
  preopens: ['/dev'],
  onFdRead(fd, ptr, len) {
    if (fd !== domFd || !wasmMemory) return 0;
    while (Atomics.load(ringHdr, 0) === Atomics.load(ringHdr, 1)) {
      Atomics.wait(ringHdr, 0, Atomics.load(ringHdr, 0));
    }
    return readFromRing(ptr, len);
  },
  onPollFdRead(fd, timeoutMs) {
    if (fd !== domFd) return 0;
    // Return immediately if data already in the ring.
    if (Atomics.load(ringHdr, 0) !== Atomics.load(ringHdr, 1)) return 1;
    // Block until write-idx changes or timeout elapses.
    const cur = Atomics.load(ringHdr, 0);
    Atomics.wait(ringHdr, 0, cur, timeoutMs < 0 ? Infinity : timeoutMs);
    return Atomics.load(ringHdr, 0) !== Atomics.load(ringHdr, 1) ? 1 : 0;
  },
  onPathOpen(_dirfd, path) {
    if (path === 'dom') {
      domFd = nextFd++;
      return domFd;
    }
    return -1;
  },
  onFdWrite(fd, text) {
    if (fd !== domFd) return false;
    pending += text;
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;

      // <!getval ID> — ask main thread to push element's .value into the ring.
      if (line.startsWith('<!getval ')) {
        self.postMessage({ type: 'getval', elemId: line.slice(9, -1) });
        continue;
      }

      // <!canvas-put ID PTR W H> — copy pixels from WASM memory, post transferable.
      if (line.startsWith('<!canvas-put ') && wasmMemory) {
        const inner = line.slice(13, -1);
        const parts = inner.split(' ');
        if (parts.length === 4) {
          const id  = parts[0];
          const ptr = parseInt(parts[1], 10);
          const w   = parseInt(parts[2], 10);
          const h   = parseInt(parts[3], 10);
          const bytes = new Uint8Array(w * h * 4);
          bytes.set(new Uint8Array(wasmMemory.buffer, ptr, w * h * 4));
          self.postMessage({ type: 'canvas-put', id, buffer: bytes.buffer, w, h }, [bytes.buffer]);
        }
        continue;
      }

      // <!canvas ID W H PTR> — ask main thread to create the canvas element.
      if (line.startsWith('<!canvas ')) {
        const inner = line.slice(9, -1);
        const parts = inner.split(' ');
        if (parts.length === 4) {
          const id  = parts[0];
          const w   = parseInt(parts[1], 10);
          const h   = parseInt(parts[2], 10);
          const ptr = parseInt(parts[3], 10);
          canvasMap.set(id, { ptr, w, h, auto: ptr !== 0 });
          self.postMessage({ type: 'canvas', id, w, h, ptr });
        }
        continue;
      }

      // <!listen ID CODE> / <!unlisten ID CODE> — relay to main thread.
      if (line.startsWith('<!listen ') || line.startsWith('<!unlisten ')) {
        const isListen = line.startsWith('<!listen ');
        const inner    = line.slice(isListen ? 9 : 11, -1);
        const sp       = inner.indexOf(' ');
        if (sp >= 0) {
          self.postMessage({
            type:    isListen ? 'listen' : 'unlisten',
            elemId:  inner.slice(0, sp),
            evtCode: parseInt(inner.slice(sp + 1), 10),
          });
        }
        continue;
      }

      // <!css-raw PTR LEN> — read bytes from WASM memory, decode as UTF-8, send as CSS.
      if (line.startsWith('<!css-raw ') && wasmMemory) {
        const parts = line.slice(10, -1).split(' ');
        if (parts.length === 2) {
          const ptr  = parseInt(parts[0], 10);
          const len  = parseInt(parts[1], 10);
          const copy = new Uint8Array(len);
          copy.set(new Uint8Array(wasmMemory.buffer, ptr, len));
          self.postMessage({ type: 'css', text: new TextDecoder().decode(copy) });
          continue;
        }
      }

      // <!blob BLOB-ID PTR LEN MIME> — read bytes from WASM memory here in the
      // worker (direct access) and send them as a transferable ArrayBuffer.
      if (line.startsWith('<!blob ') && wasmMemory) {
        const inner = line.slice(7, -1); // strip '<!blob ' and trailing '>'
        const sp1   = inner.indexOf(' ');
        if (sp1 >= 0) {
          const blobId = inner.slice(0, sp1);
          const rest1  = inner.slice(sp1 + 1);
          const sp2    = rest1.indexOf(' ');
          if (sp2 >= 0) {
            const ptr   = parseInt(rest1.slice(0, sp2), 10);
            const rest2 = rest1.slice(sp2 + 1);
            const sp3   = rest2.indexOf(' ');
            if (sp3 >= 0) {
              const len  = parseInt(rest2.slice(0, sp3), 10);
              const mime = rest2.slice(sp3 + 1);
              const bytes = new Uint8Array(len);
              bytes.set(new Uint8Array(wasmMemory.buffer, ptr, len));
              self.postMessage({ type: 'blob', blobId, mime, buffer: bytes.buffer }, [bytes.buffer]);
              continue;
            }
          }
        }
      }

      self.postMessage({ type: 'dom', line });
    }
    return true;
  },
});

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  self.postMessage({ type: 'ring', sab: ringBuf }); // send SAB before WASM starts
  try {
    const resp = await fetch(data.wasmUrl);
    const { instance } = await WebAssembly.instantiateStreaming(resp, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    wasi.setMemory(instance.exports.memory);
    wasmMemory = instance.exports.memory; // used by <!blob> and <!canvas-put> handlers
    // Share memory buffer with main thread for auto-mode canvas rAF refresh.
    // When (shared-memory) is used, memory.buffer is a SharedArrayBuffer.
    if (wasmMemory.buffer instanceof SharedArrayBuffer) {
      self.postMessage({ type: 'wasm-memory', buffer: wasmMemory.buffer });
    }
    instance.exports._start();
    self.postMessage({ type: 'exit', code: 0 });
  } catch (e) {
    if (e?.type === 'wasi_exit') {
      self.postMessage({ type: 'exit', code: e.code });
    } else {
      self.postMessage({ type: 'error', message: String(e) });
    }
  }
};
