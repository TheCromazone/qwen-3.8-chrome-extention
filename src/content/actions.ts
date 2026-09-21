/**
 * The actions the agent can take on a page. Everything is expressed against a
 * `ref` from the element index, and every action dispatches the same event
 * sequence a real user would produce so framework-bound inputs update.
 */
import { resolveRef } from './elements.ts';

export interface ActionResult {
  ok: boolean;
  detail: string;
}

function fail(detail: string): ActionResult {
  return { ok: false, detail };
}

function missing(ref: number): ActionResult {
  return fail(
    `No element with ref ${ref} on the current page. The page may have changed — observe it again before acting.`,
  );
}

export function scrollIntoView(el: Element): void {
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
}

export function clickRef(ref: number): ActionResult {
  const el = resolveRef(ref);
  if (!el) return missing(ref);
  if ('disabled' in el && (el as { disabled?: boolean }).disabled) {
    return fail(`Element ${ref} is disabled and cannot be clicked.`);
  }

  scrollIntoView(el);
  const target = el as HTMLElement;
  target.focus?.({ preventScroll: true });

  const rect = el.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: el.ownerDocument.defaultView,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };

  target.dispatchEvent(new PointerEvent('pointerdown', { ...init, isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mousedown', init));
  target.dispatchEvent(new PointerEvent('pointerup', { ...init, isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mouseup', init));
  // click() rather than a synthetic MouseEvent so anchors and submit buttons
  // still perform their default navigation.
  target.click();

  return { ok: true, detail: `Clicked [${ref}].` };
}

export function typeIntoRef(ref: number, text: string, submit: boolean): ActionResult {
  const el = resolveRef(ref);
  if (!el) return missing(ref);

  scrollIntoView(el);
  const target = el as HTMLElement;
  target.focus?.({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, text);
  } else if (el.getAttribute('contenteditable') === 'true') {
    el.textContent = text;
  } else {
    return fail(`Element ${ref} is a ${el.tagName.toLowerCase()}, which does not accept typed text.`);
  }

  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  if (submit) {
    const enter: KeyboardEventInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 } as KeyboardEventInit;
    el.dispatchEvent(new KeyboardEvent('keydown', enter));
    el.dispatchEvent(new KeyboardEvent('keyup', enter));
    // Plain Enter does not submit every form, so ask the form directly too.
    const form = (el as HTMLInputElement).form;
    if (form) form.requestSubmit?.();
  }

  return { ok: true, detail: `Typed ${JSON.stringify(text.slice(0, 80))} into [${ref}]${submit ? ' and submitted' : ''}.` };
}

/**
 * React and other frameworks track the native value setter, so assigning
 * `el.value` directly leaves their state stale. Go through the prototype setter.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function selectOption(ref: number, value: string): ActionResult {
  const el = resolveRef(ref);
  if (!el) return missing(ref);
  if (!(el instanceof HTMLSelectElement)) return fail(`Element ${ref} is not a dropdown.`);

  const match =
    Array.from(el.options).find((o) => o.value === value) ??
    Array.from(el.options).find((o) => o.textContent?.trim().toLowerCase() === value.trim().toLowerCase()) ??
    Array.from(el.options).find((o) => o.textContent?.toLowerCase().includes(value.trim().toLowerCase()));

  if (!match) {
    const available = Array.from(el.options).map((o) => o.textContent?.trim()).filter(Boolean).slice(0, 20);
    return fail(`No option matching "${value}". Available: ${available.join(', ')}`);
  }

  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, detail: `Selected "${match.textContent?.trim()}" in [${ref}].` };
}

export function scrollPage(direction: 'up' | 'down' | 'top' | 'bottom', amount?: number): ActionResult {
  const step = amount ?? Math.round(window.innerHeight * 0.85);
  switch (direction) {
    case 'down':
      window.scrollBy({ top: step, behavior: 'instant' as ScrollBehavior });
      break;
    case 'up':
      window.scrollBy({ top: -step, behavior: 'instant' as ScrollBehavior });
      break;
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      break;
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior });
      break;
  }
  return { ok: true, detail: `Scrolled ${direction}.` };
}

export function pressKey(key: string): ActionResult {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const init: KeyboardEventInit = { bubbles: true, cancelable: true, key, code: keyToCode(key) };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, detail: `Pressed ${key}.` };
}

function keyToCode(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
  return key;
}

/** Finds visible text on the page, so the agent can confirm what it is looking at. */
export function findText(query: string, limit = 5): ActionResult {
  const needle = query.toLowerCase().trim();
  if (!needle) return fail('Empty search text.');

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits: string[] = [];
  while (walker.nextNode() && hits.length < limit) {
    const raw = walker.currentNode.textContent ?? '';
    if (!raw.toLowerCase().includes(needle)) continue;
    const context = raw.replace(/\s+/g, ' ').trim();
    if (context) hits.push(context.slice(0, 300));
  }

  return hits.length
    ? { ok: true, detail: `Found ${hits.length} match(es):\n${hits.map((h) => `- ${h}`).join('\n')}` }
    : { ok: false, detail: `"${query}" does not appear in the visible page text.` };
}

export function scrollProgress(): number {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  if (scrollable <= 0) return 1;
  return Math.min(1, Math.max(0, window.scrollY / scrollable));
}
