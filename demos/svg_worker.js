/**
 * svg_worker.js — Web Worker that runs a woua SVG demo WASM module and
 * posts SVG protocol lines to the main thread for DOM rendering.
 *
 * Protocol messages sent to the main thread:
 *   { type: 'svg',   line: string }   — one SVG protocol line (no newline)
 *   { type: 'exit',  code: number }   — program exited normally
 *   { type: 'error', message: string} — runtime error
 *
 * Message received from main thread:
 *   { type: 'start', wasmUrl: string }
 */

import { makeWasi } from '../js/wasi-min.js';

const SVG_FD = 4;

let pending = '';

const wasi = makeWasi({
  onFdWrite(fd, text) {
    if (fd !== SVG_FD) return false;
    // Buffer and split on newlines; post each complete line.
    pending += text;
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) self.postMessage({ type: 'svg', line });
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
