/**
 * svg-processor.js — SVG protocol message processor.
 *
 * Parses the text-based SVG protocol produced by woua programs and applies
 * each message to a live DOM <svg> element.
 *
 * Protocol (each message is a single newline-terminated line):
 *   <tag id="ID" attr="val".../>              — upsert element (self-closing)
 *   <tag id="ID" attr="val"...>TEXT</tag>     — upsert element with text content
 *   <!clear>                                  — remove all non-defs children
 *   <!parent ID>                              — set insertion context to element ID
 *   <!parent-root>                            — reset insertion context to svg root
 *   <!remove ID>                              — remove element with id ID
 *   <!style ID CSS>                           — setAttribute('style', CSS)
 *   <!transform ID T>                         — setAttribute('transform', T)
 *   <!attr ID NAME VALUE>                     — setAttribute(NAME, VALUE)
 *   <!title TEXT>                             — document.title = TEXT
 *
 * The special id "__root" in <!style>, <!transform> and <!attr> refers to the
 * root <svg> element itself, allowing WASM code to set width/height/viewBox/style.
 *
 * Usage:
 *   import { makeSvgProcessor } from './svg-processor.js';
 *
 *   const process = makeSvgProcessor(svgElement, defsElement);
 *   process(line);   // call for each complete protocol line
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create a stateful processor bound to a specific <svg> and its <defs>.
 *
 * @param {SVGSVGElement}   svg   - The root <svg> element to operate on.
 * @param {SVGDefsElement}  defs  - The <defs> child of svg.
 * @returns {(line: string) => void}
 */
export function makeSvgProcessor(svg, defs) {
  let insertionParent = svg;

  return function processMessage(line) {
    line = line.trim();
    if (!line) return;

    // ── Directives: <!...> ────────────────────────────────────────────────
    if (line.startsWith('<!')) {
      const inner = line.slice(2, -1).trim();

      if (inner === 'clear') {
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
        const el = document.getElementById(inner.slice(7).trim());
        if (el) el.parentNode.removeChild(el);
        return;
      }

      if (inner.startsWith('parent ')) {
        insertionParent = document.getElementById(inner.slice(7).trim()) ?? svg;
        return;
      }

      if (inner.startsWith('style ')) {
        const rest = inner.slice(6);
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const el = id === '__root' ? svg : document.getElementById(id);
          el?.setAttribute('style', rest.slice(sp + 1));
        }
        return;
      }

      if (inner.startsWith('transform ')) {
        const rest = inner.slice(10);
        const sp = rest.indexOf(' ');
        if (sp !== -1) {
          const id = rest.slice(0, sp);
          const el = id === '__root' ? svg : document.getElementById(id);
          el?.setAttribute('transform', rest.slice(sp + 1));
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
            const el = id === '__root' ? svg : document.getElementById(id);
            el?.setAttribute(rest2.slice(0, sp2), rest2.slice(sp2 + 1));
          }
        }
        return;
      }

      if (inner.startsWith('title ')) {
        document.title = inner.slice(6);
        return;
      }

      return; // unknown directive — ignore
    }

    // ── SVG elements ──────────────────────────────────────────────────────
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
      el = document.createElementNS(SVG_NS, tagName);
      insertionParent.appendChild(el);
    }

    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (textContent !== null) el.textContent = textContent;
  };
}
