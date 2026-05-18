/**
 * svg-bridge.js — intercepts WASI fd_write to SVG_FD and upserts SVG elements
 * into a live DOM <svg> element.
 *
 * Usage:
 *   import { mountSvg } from './svg-bridge.js';
 *
 *   const wasmImports = { wasi_snapshot_preview1: { ...wasi.wasiImport } };
 *   mountSvg(wasmImports, '#canvas', 800, 600, '0 0 800 600');
 *   // Then instantiate your WASM module with wasmImports.
 *
 * The bridge patches wasmImports.wasi_snapshot_preview1.fd_write so that
 * writes to fd SVG_FD (default 4) are intercepted and processed as SVG
 * protocol messages.  All other fds are forwarded to the original fd_write.
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

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_FD = 4;

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

  // Insertion context: new elements are appended here.
  let insertionParent = svg;

  // Accumulate bytes from fd_write calls (may arrive in fragments).
  let pending = '';

  // ── Message processor ──────────────────────────────────────────────────────

  function processMessage(line) {
    line = line.trim();
    if (!line) return;

    // Directive messages: <!...>
    if (line.startsWith('<!')) {
      const inner = line.slice(2, -1).trim(); // strip <! and >
      if (inner === 'clear') {
        // Remove all non-defs children
        for (const child of [...svg.childNodes]) {
          if (child !== defs) svg.removeChild(child);
        }
        insertionParent = svg;
        return;
      }
      if (inner === 'parent-root') {
        insertionParent = svg;
        return;
      }
      if (inner.startsWith('remove ')) {
        const id = inner.slice(7).trim();
        const el = document.getElementById(id);
        if (el) el.parentNode.removeChild(el);
        return;
      }
      if (inner.startsWith('parent ')) {
        const id = inner.slice(7).trim();
        const el = document.getElementById(id) || svg;
        insertionParent = el;
        return;
      }
      if (inner.startsWith('style ')) {
        const rest = inner.slice(6);
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const css = rest.slice(sp + 1);
          const el = document.getElementById(id);
          if (el) el.setAttribute('style', css);
        }
        return;
      }
      if (inner.startsWith('transform ')) {
        const rest = inner.slice(10);
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const t = rest.slice(sp + 1);
          const el = document.getElementById(id);
          if (el) el.setAttribute('transform', t);
        }
        return;
      }
      if (inner.startsWith('attr ')) {
        // <!attr ID NAME VALUE>
        const rest = inner.slice(5);
        const sp1 = rest.indexOf(' ');
        if (sp1 !== -1) {
          const id = rest.slice(0, sp1);
          const rest2 = rest.slice(sp1 + 1);
          const sp2 = rest2.indexOf(' ');
          if (sp2 !== -1) {
            const name = rest2.slice(0, sp2);
            const value = rest2.slice(sp2 + 1);
            const el = document.getElementById(id);
            if (el) el.setAttribute(name, value);
          }
        }
        return;
      }
      // Unknown directive — ignore
      return;
    }

    // SVG element message: parse the tag name and attributes
    // Accept both self-closing (<tag .../>) and element-with-text (<tag...>TEXT</tag>)
    let tagName, attrsStr, textContent = null;

    // Check for element-with-text: <tag ...>TEXT</tag>
    const fullMatch = line.match(/^<([a-zA-Z][a-zA-Z0-9]*)\s+([^>]*)>([^<]*)<\/[a-zA-Z][a-zA-Z0-9]*>$/);
    if (fullMatch) {
      tagName = fullMatch[1];
      attrsStr = fullMatch[2];
      textContent = fullMatch[3];
    } else {
      // Self-closing: <tag .../>
      const selfMatch = line.match(/^<([a-zA-Z][a-zA-Z0-9]*)\s*(.*?)\s*\/>$/);
      if (!selfMatch) return; // unrecognized format
      tagName = selfMatch[1];
      attrsStr = selfMatch[2];
    }

    // Parse attributes: name="value" pairs
    const attrRe = /([a-zA-Z][a-zA-Z0-9_:-]*)="([^"]*)"/g;
    const attrs = {};
    let m;
    while ((m = attrRe.exec(attrsStr)) !== null) {
      attrs[m[1]] = m[2];
    }

    const id = attrs['id'];
    if (!id) return; // id is required by protocol

    // Upsert: update existing element or create a new one
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElementNS(SVG_NS, tagName);
      insertionParent.appendChild(el);
    }

    // Apply all attributes
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value);
    }

    // Set text content if present
    if (textContent !== null) {
      el.textContent = textContent;
    }
  }

  // ── fd_write interceptor ───────────────────────────────────────────────────

  let memory = null; // set when WASM memory is available

  /**
   * Provide a memory accessor. Call this after instantiation:
   *   bridge.setMemory(instance.exports.memory);
   * Or pass memory in wasmImports.__bridge = bridge and call from WASM glue.
   */
  function setMemory(mem) {
    memory = mem;
  }

  const originalFdWrite = wasmImports.wasi_snapshot_preview1.fd_write;

  wasmImports.wasi_snapshot_preview1.fd_write = function (fd, iovs, iovsLen, nwrittenPtr) {
    if (fd !== SVG_FD || !memory) {
      return originalFdWrite(fd, iovs, iovsLen, nwrittenPtr);
    }

    const mem = new DataView(memory.buffer);
    let totalWritten = 0;

    for (let i = 0; i < iovsLen; i++) {
      const iovBase = mem.getUint32(iovs + i * 8,     true);
      const iovLen  = mem.getUint32(iovs + i * 8 + 4, true);
      const bytes   = new Uint8Array(memory.buffer, iovBase, iovLen);
      const chunk   = new TextDecoder().decode(bytes);
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
