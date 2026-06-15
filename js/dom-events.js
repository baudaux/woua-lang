/**
 * dom-events.js — EVT_CODES / EVT_NAMES tables and event-listener helpers.
 *
 * Shared by all HTML pages that use the Woua DOM event system.
 * Keeps the EVT-* integer codes (defined in lib/dom.woua) in sync with the
 * browser event names used for addEventListener / removeEventListener.
 */

export const EVT_CODES = {
  click: 1, dblclick: 2, mousedown: 3, mouseup: 4, mousemove: 5,
  keydown: 6, keyup: 7, keypress: 8,
  input: 9, change: 10, focus: 11, blur: 12, submit: 13, reset: 14, scroll: 15,
};

/** Reverse map: integer code → browser event name. */
export const EVT_NAMES = Object.fromEntries(
  Object.entries(EVT_CODES).map(([k, v]) => [v, k])
);

/** EVT_VAL — synthetic code for <!getval> responses (no browser event name). */
export const EVT_VAL = 16;

/**
 * makeHandler(elemId, evtCode, writeEventToRing) — create a DOM event listener.
 * The handler writes a tab-separated ring-buffer record when the event fires.
 */
export function makeHandler(elemId, evtCode, writeEventToRing) {
  return (e) => {
    const cx  = Math.round(e.clientX   ?? 0);
    const cy  = Math.round(e.clientY   ?? 0);
    const kc  = e.keyCode ?? e.button ?? e.pointerId ?? 0;
    const val = encodeURIComponent(e.target?.value ?? e.key ?? '');
    writeEventToRing(`${elemId}\t${evtCode}\t${cx}\t${cy}\t${kc}\t${val}\n`);
  };
}

/**
 * applyListenMessage(data, listenerMap, writeEventToRing)
 * Handle a { type:'listen'|'unlisten', elemId, evtCode } message from the worker.
 */
export function applyListenMessage(data, listenerMap, writeEventToRing) {
  const { type, elemId, evtCode } = data;
  const eventType = EVT_NAMES[evtCode];
  if (!eventType) return;

  if (type === 'listen') {
    const el = document.getElementById(elemId);
    if (!el) return;
    if (!listenerMap.has(elemId)) listenerMap.set(elemId, new Map());
    const handler = makeHandler(elemId, evtCode, writeEventToRing);
    listenerMap.get(elemId).set(evtCode, handler);
    el.addEventListener(eventType, handler);
  } else {
    const handlers = listenerMap.get(elemId);
    if (!handlers) return;
    const handler = handlers.get(evtCode);
    if (!handler) return;
    document.getElementById(elemId)?.removeEventListener(eventType, handler);
    handlers.delete(evtCode);
  }
}
