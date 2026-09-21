/**
 * Builds the numbered element index the agent acts on. The model never sees
 * selectors or coordinates it has to invent — it picks a `ref` from this list,
 * and the content script resolves the ref back to a live node.
 */
import { isVisible } from './extract.ts';
import type { InteractiveElement } from '../lib/types.ts';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="switch"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Live ref -> element map, rebuilt on every observation. */
const registry = new Map<number, Element>();
let nextRef = 1;

export function resolveRef(ref: number): Element | null {
  const el = registry.get(ref);
  if (!el) return null;
  // A SPA re-render can detach the node between observation and action.
  return el.isConnected ? el : null;
}

export function clearRegistry(): void {
  registry.clear();
}

export function indexInteractiveElements(doc: Document, limit = 150): InteractiveElement[] {
  clearRegistry();
  nextRef = 1;

  const out: InteractiveElement[] = [];
  const seen = new Set<Element>();

  for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (out.length >= limit) break;
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el) || !isVisibleChain(el)) continue;

    const name = accessibleName(el);
    const rect = el.getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 };
    // Unlabelled zero-size controls are noise the model cannot use.
    if (!name && rect.width * rect.height === 0) continue;

    const ref = nextRef++;
    registry.set(ref, el);

    const view = doc.defaultView;
    const viewportHeight = view?.innerHeight ?? 0;
    const viewportWidth = view?.innerWidth ?? 0;

    out.push({
      ref,
      tag: el.tagName.toLowerCase(),
      role: inferRole(el),
      name: name.slice(0, 160),
      value: readValue(el),
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      inViewport:
        rect.top < viewportHeight && rect.top + rect.height > 0 && rect.left < viewportWidth && rect.left + rect.width > 0,
      disabled: isDisabled(el),
    });
  }

  return out;
}

function isVisibleChain(el: Element): boolean {
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && depth++ < 40) {
    if (!isVisible(node)) return false;
    node = node.parentElement;
  }
  return true;
}

/** Approximates the accessible-name computation: enough of it to address a control. */
export function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const id = el.getAttribute('id');
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
    const text = label?.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel) {
    const text = wrappingLabel.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }

  const own = el.textContent?.replace(/\s+/g, ' ').trim();
  if (own) return own;

  for (const attr of ['placeholder', 'title', 'alt', 'name', 'value']) {
    const value = el.getAttribute(attr)?.trim();
    if (value) return value;
  }

  const img = el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
  if (img) return img;

  return '';
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function inferRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  if (el.getAttribute('contenteditable') === 'true') return 'textbox';
  return 'generic';
}

function readValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return undefined; // never surface secrets to the model
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : 'unchecked';
    return el.value.slice(0, 120) || undefined;
  }
  if (el instanceof HTMLTextAreaElement) return el.value.slice(0, 120) || undefined;
  if (el instanceof HTMLSelectElement) return el.value || undefined;
  return undefined;
}

function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return 'disabled' in el && Boolean((el as { disabled?: boolean }).disabled);
}

/** Renders the index into the compact listing the model reads. */
export function formatElements(elements: InteractiveElement[]): string {
  if (!elements.length) return '(no interactive elements found)';
  return elements
    .map((el) => {
      const flags = [
        el.inViewport ? null : 'offscreen',
        el.disabled ? 'disabled' : null,
        el.value ? `value="${el.value}"` : null,
      ].filter(Boolean);
      const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
      return `[${el.ref}] ${el.role} "${el.name || '(unlabelled)'}"${suffix}`;
    })
    .join('\n');
}
