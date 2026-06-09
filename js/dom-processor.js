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
 *
 * The special id "__root" in directives refers to the root container element.
 *
 * Usage:
 *   import { makeDomProcessor } from './dom-processor.js';
 *
 *   const process = makeDomProcessor(containerElement);
 *   process(line);   // call for each complete protocol line
 */

/**
 * Create a stateful processor bound to a specific container element.
 *
 * @param {HTMLElement} root - The root container element to operate on.
 * @returns {(line: string) => void}
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function makeDomProcessor(root) {
  let insertionParent = root;

  return function processMessage(line) {
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
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const el = id === '__root' ? root : document.getElementById(id);
          if (el) el.textContent = rest.slice(sp + 1);
        }
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

    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (textContent !== null) el.textContent = textContent;
  };
}
