/**
 * dom-processor.js — DOM protocol message processor.
 *
 * Parses the text-based DOM protocol produced by woua programs and applies
 * each message to a live HTML container element.
 *
 * Protocol (each message is a single newline-terminated line):
 *   <tag id="ID" attr="val".../>              — upsert element (self-closing)
 *   <tag id="ID" attr="val"...>TEXT</tag>     — upsert element with text content
 *   <!clear>                                  — remove all children from root
 *   <!parent ID>                              — set insertion context to element ID
 *   <!parent-root>                            — reset insertion context to root
 *   <!remove ID>                              — remove element with id ID
 *   <!style ID CSS>                           — element.setAttribute('style', CSS)
 *   <!class ID CLASSNAME>                     — element.className = CLASSNAME
 *   <!text ID TEXT>                           — element.textContent = TEXT
 *   <!attr ID NAME VALUE>                     — element.setAttribute(NAME, VALUE)
 *   <!title TEXT>                             — document.title = TEXT
 *   <!css TEXT>                               — append TEXT to a <style id="__wasm-css"> in <head>
 *   <!css-raw PTR LEN>                        — worker reads LEN bytes from WASM memory at PTR, decodes UTF-8, appends to same <style>
 *   <!blob BLOB-ID PTR LEN MIME>              — create Blob from WASM memory[PTR..PTR+LEN], store ObjectURL under BLOB-ID
 *   <!canvas ID W H PTR>                      — (intercepted by worker) create <canvas>; PTR=0 manual, PTR≠0 auto
 *   <!canvas-put ID PTR W H>                  — (intercepted by worker) push RGBA frame to canvas
 *   <!listen ID EVENT>                        — (intercepted by worker) attach event listener on element ID
 *   <!unlisten ID EVENT>                      — (intercepted by worker) remove event listener
 *
 * Attribute values matching 'blob:BLOB-ID' (without '://') are automatically
 * resolved to the registered ObjectURL when the element is upserted.
 *
 * The special id "__root" in directives refers to the root container element.
 *
 * Usage:
 *   import { makeDomProcessor, makeWorkerHandler } from './dom-processor.js';
 */

import { applyListenMessage, EVT_VAL } from './dom-events.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function makeDomProcessor(root, getMemory = null) {
  let insertionParent = root;
  const blobRegistry  = new Map(); // blob-id → ObjectURL
  let styleEl = null; // <style id="__wasm-css"> created on first <!css>

  function resolveAttrValue(val) {
    if (val.startsWith('blob:') && !val.includes('://')) {
      const id = val.slice(5);
      if (blobRegistry.has(id)) return blobRegistry.get(id);
      console.warn(`dom-blob: blob '${id}' not yet registered`);
    }
    return val;
  }

  const processMessage = function processMessage(line) {
    line = line.trim();
    if (!line) return;

    // ── Directives: <!...> ────────────────────────────────────────────────
    if (line.startsWith('<!')) {
      const inner = line.slice(2, -1).trim();

      if (inner === 'clear') {
        root.innerHTML = '';
        insertionParent = root;
        return;
      }

      if (inner === 'parent-root') {
        insertionParent = root;
        return;
      }

      if (inner.startsWith('remove ')) {
        const el = document.getElementById(inner.slice(7).trim());
        if (el) el.parentNode.removeChild(el);
        return;
      }

      if (inner.startsWith('parent ')) {
        insertionParent = document.getElementById(inner.slice(7).trim()) ?? root;
        return;
      }

      if (inner.startsWith('style ')) {
        const rest = inner.slice(6);
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const el = id === '__root' ? root : document.getElementById(id);
          el?.setAttribute('style', rest.slice(sp + 1));
        }
        return;
      }

      if (inner.startsWith('class ')) {
        const rest = inner.slice(6);
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const el = id === '__root' ? root : document.getElementById(id);
          if (el) el.className = rest.slice(sp + 1);
        }
        return;
      }

      if (inner.startsWith('text ')) {
        const rest = inner.slice(5);
        const sp   = rest.indexOf(' ');
        const id   = sp !== -1 ? rest.slice(0, sp) : rest;
        const text = sp !== -1 ? rest.slice(sp + 1) : '';
        const el   = id === '__root' ? root : document.getElementById(id);
        if (el) el.textContent = text;
        return;
      }

      if (inner.startsWith('attr ')) {
        // <!attr ID NAME VALUE>
        const rest = inner.slice(5);
        const sp1 = rest.indexOf(' ');
        if (sp1 !== -1) {
          const id    = rest.slice(0, sp1);
          const rest2 = rest.slice(sp1 + 1);
          const sp2   = rest2.indexOf(' ');
          if (sp2 !== -1) {
            const el = id === '__root' ? root : document.getElementById(id);
            el?.setAttribute(rest2.slice(0, sp2), rest2.slice(sp2 + 1));
          }
        }
        return;
      }

      if (inner.startsWith('title ')) {
        document.title = inner.slice(6);
        return;
      }

      if (inner.startsWith('css ')) {
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = '__wasm-css';
          document.head.appendChild(styleEl);
        }
        styleEl.textContent += inner.slice(4) + '\n';
        return;
      }

      if (inner.startsWith('blob ')) {
        // <!blob BLOB-ID PTR LEN MIME>
        const rest = inner.slice(5);
        const sp1  = rest.indexOf(' ');
        if (sp1 === -1) return;
        const blobId = rest.slice(0, sp1);
        const rest2  = rest.slice(sp1 + 1);
        const sp2    = rest2.indexOf(' ');
        if (sp2 === -1) return;
        const ptr   = parseInt(rest2.slice(0, sp2), 10);
        const rest3 = rest2.slice(sp2 + 1);
        const sp3   = rest3.indexOf(' ');
        if (sp3 === -1) return;
        const len  = parseInt(rest3.slice(0, sp3), 10);
        const mime = rest3.slice(sp3 + 1);
        const mem  = getMemory ? getMemory() : null;
        if (!mem) { console.warn(`dom-blob: memory not available for blob '${blobId}'`); return; }
        const bytes = new Uint8Array(len);
        bytes.set(new Uint8Array(mem.buffer, ptr, len));
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        blobRegistry.set(blobId, url);
        return;
      }

      return; // unknown directive — ignore
    }

    // ── HTML elements ─────────────────────────────────────────────────────
    let tagName, attrsStr, textContent = null;

    const fullMatch = line.match(
      /^<([a-zA-Z][a-zA-Z0-9]*)\s+([^>]*)>([^<]*)<\/[a-zA-Z][a-zA-Z0-9]*>$/
    );
    if (fullMatch) {
      [, tagName, attrsStr, textContent] = fullMatch;
    } else {
      const selfMatch = line.match(/^<([a-zA-Z][a-zA-Z0-9]*)\s*(.*?)\s*\/>$/);
      if (!selfMatch) return;
      [, tagName, attrsStr] = selfMatch;
    }

    const attrRe = /([a-zA-Z][a-zA-Z0-9_:-]*)="([^"]*)"/g;
    const attrs  = {};
    let m;
    while ((m = attrRe.exec(attrsStr)) !== null) attrs[m[1]] = m[2];

    const id = attrs['id'];
    if (!id) return; // id is required by protocol

    let el = document.getElementById(id);
    if (!el) {
      const inSvg = insertionParent instanceof SVGElement;
      el = (inSvg || tagName === 'svg')
        ? document.createElementNS(SVG_NS, tagName)
        : document.createElement(tagName);
      insertionParent.appendChild(el);
    }

    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, resolveAttrValue(value));
    if (textContent !== null) el.textContent = textContent;
  };

  processMessage.registerBlob = function(id, url) { blobRegistry.set(id, url); };
  processMessage.injectCss     = function(text) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = '__wasm-css';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent += text;
  };

  return processMessage;
}

/**
 * makeWorkerHandler(root, statusEl)
 *
 * Creates the full worker message handler for a Woua DOM page.
 * Manages the ring buffer, event listeners, and DOM updates in one place.
 *
 * @param {HTMLElement} root      - Container element for DOM output.
 * @param {HTMLElement} statusEl  - Element to display exit/error status.
 * @returns {(event: MessageEvent) => void} Assign to worker.onmessage.
 */
export function makeWorkerHandler(root, statusEl) {
  const RING_DATA   = 4096;
  let   sabHeader   = null;
  let   sabData     = null;
  const listenerMap = new Map();
  const canvasMap   = new Map(); // id → { ctx, w, h, ptr, auto }
  let   wasmMemBuf  = null;     // SharedArrayBuffer from worker (shared-memory modules only)
  let   rafRunning  = false;
  const processMessage = makeDomProcessor(root);

  function startRaf() {
    if (rafRunning) return;
    rafRunning = true;
    function rafLoop() {
      for (const c of canvasMap.values()) {
        if (!c.auto || !wasmMemBuf) continue;
        // ImageData doesn't accept SAB-backed TypedArrays (not detachable),
        // so we pre-allocate a regular ImageData once and .set() from SAB each frame.
        if (!c.imageData) c.imageData = new ImageData(c.w, c.h);
        c.imageData.data.set(new Uint8ClampedArray(wasmMemBuf, c.ptr, c.w * c.h * 4));
        c.ctx.putImageData(c.imageData, 0, 0);
      }
      requestAnimationFrame(rafLoop);
    }
    requestAnimationFrame(rafLoop);
  }

  function writeEventToRing(text) {
    if (!sabHeader) return;
    const bytes = new TextEncoder().encode(text);
    const N     = RING_DATA;
    const wIdx  = Atomics.load(sabHeader, 0);
    const rIdx  = Atomics.load(sabHeader, 1);
    if (N - (wIdx - rIdx) < bytes.length) return;
    for (let i = 0; i < bytes.length; i++) sabData[(wIdx + i) % N] = bytes[i];
    Atomics.store(sabHeader, 0, wIdx + bytes.length);
    Atomics.notify(sabHeader, 0);
  }

  return function onWorkerMessage({ data }) {
    switch (data.type) {
      case 'ring':
        sabHeader = new Int32Array(data.sab, 0, 2);
        sabData   = new Uint8Array(data.sab, 8);
        break;
      case 'listen':
      case 'unlisten':
        applyListenMessage(data, listenerMap, writeEventToRing);
        break;
      case 'getval': {
        const val = encodeURIComponent(document.getElementById(data.elemId)?.value ?? '');
        writeEventToRing(`${data.elemId}\t${EVT_VAL}\t0\t0\t0\t${val}\n`);
        break;
      }
      case 'css':
        processMessage.injectCss(data.text);
        break;
      case 'blob': {
        const url = URL.createObjectURL(new Blob([data.buffer], { type: data.mime }));
        processMessage.registerBlob(data.blobId, url);
        break;
      }
      case 'wasm-memory':
        wasmMemBuf = data.buffer; // SharedArrayBuffer — enables auto-mode rAF
        startRaf();
        break;
      case 'canvas': {
        let el = document.getElementById(data.id);
        if (!el) {
          el = document.createElement('canvas');
          el.id = data.id;
          root.appendChild(el);
        }
        el.width  = data.w;
        el.height = data.h;
        canvasMap.set(data.id, { ctx: el.getContext('2d'), w: data.w, h: data.h, ptr: data.ptr, auto: data.ptr !== 0 });
        if (data.ptr !== 0) startRaf();
        break;
      }
      case 'canvas-put': {
        const c = canvasMap.get(data.id);
        if (!c) break;
        c.ctx.putImageData(
          new ImageData(new Uint8ClampedArray(data.buffer), data.w, data.h), 0, 0
        );
        break;
      }
      case 'dom':
        processMessage(data.line);
        break;
      case 'exit':
        if (statusEl) statusEl.textContent = `Done (exit ${data.code}).`;
        break;
      case 'error':
        if (statusEl) statusEl.textContent = `Error: ${data.message}`;
        break;
    }
  };
}
