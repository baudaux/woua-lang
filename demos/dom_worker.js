/**
 * dom_worker.js — Web Worker that runs a woua DOM demo WASM module and
 * posts DOM protocol lines to the main thread for rendering.
 *
 * Protocol messages sent to the main thread:
 *   { type: 'dom',   line: string }   — one DOM protocol line (no newline)
 *   { type: 'exit',  code: number }   — program exited normally
 *   { type: 'error', message: string} — runtime error
 *
 * Message received from main thread:
 *   { type: 'start', wasmUrl: string }
 */

import { makeWasi } from '../js/wasi-min.js';

let domFd  = -1;
let nextFd = 5; // 0-2 = stdio, 3 = /dev preopen, 4 reserved
let pending = '';

const wasi = makeWasi({
  preopens: ['/dev'],
  onPathOpen(_dirfd, path) {
    if (path === 'dom') {
      domFd = nextFd++;
      return domFd;
    }
    return -1;
  },
  onFdWrite(fd, text) {
    if (fd !== domFd) return false;
    // Buffer and split on newlines; post each complete line.
    pending += text;
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) self.postMessage({ type: 'dom', line });
    }
    return true;
  },
});

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  try {
    const resp = await fetch(data.wasmUrl);
    const { instance } = await WebAssembly.instantiateStreaming(resp, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    wasi.setMemory(instance.exports.memory);
    // Share the (SharedArrayBuffer-backed) memory with the main thread so it
    // can read WASM linear memory directly.  Only possible when cross-origin
    // isolation is active (COOP + COEP headers); falls back silently otherwise.
    if (instance.exports.memory?.buffer instanceof SharedArrayBuffer) {
      self.postMessage({ type: 'memory', memory: instance.exports.memory });
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
