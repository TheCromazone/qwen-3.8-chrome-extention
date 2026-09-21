/** Installs a jsdom document as the globals the content-script modules expect. */
import { JSDOM, VirtualConsole } from 'jsdom';

export interface DomHandle {
  dom: JSDOM;
  document: Document;
  restore: () => void;
}

const GLOBAL_KEYS = [
  'window', 'document', 'location', 'Node', 'NodeFilter', 'Element', 'HTMLElement',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement',
  'Event', 'InputEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle',
] as const;

export function withDom(html: string, url = 'https://example.test/article'): DomHandle {
  // jsdom logs "Not implemented: navigation" whenever a link is clicked; the
  // fake tab handles navigation itself, so that noise is expected.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, virtualConsole });
  // jsdom implements neither of these, and the content script calls both.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  dom.window.HTMLFormElement.prototype.requestSubmit = function requestSubmit() {};

  const saved = new Map<string, unknown>();

  for (const key of GLOBAL_KEYS) {
    saved.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] =
      key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
  }

  return {
    dom,
    document: dom.window.document,
    restore() {
      for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
      dom.window.close();
    },
  };
}
