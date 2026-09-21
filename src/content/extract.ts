/** Readable-text extraction. Pure DOM work, so it is testable against a parsed document. */

const BLOCKED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO',
]);

/** Containers that usually hold chrome rather than content. */
const CHROME_SELECTORS = [
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '[aria-hidden="true"]',
];

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION', 'DD', 'DT', 'TD', 'TH', 'BR', 'HR',
]);

/**
 * Picks the densest plausible content container, falling back to body. This is
 * deliberately simpler than Readability: the model tolerates some navigation
 * noise far better than it tolerates a missing article.
 */
export function findMainContent(doc: Document): HTMLElement {
  const explicit = doc.querySelector<HTMLElement>('main, [role="main"], article');
  if (explicit && textLength(explicit) > 200) return explicit;

  let best: HTMLElement | null = null;
  let bestScore = 0;

  for (const el of doc.querySelectorAll<HTMLElement>('div, section, article, main')) {
    const length = textLength(el);
    if (length < 200) continue;
    // Prefer prose over link farms.
    const linkChars = Array.from(el.querySelectorAll('a')).reduce((sum, a) => sum + (a.textContent?.length ?? 0), 0);
    const score = length * (1 - Math.min(0.9, linkChars / Math.max(length, 1)));
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best ?? doc.body ?? doc.documentElement;
}

function textLength(el: Element): number {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

/**
 * Visibility check. `getComputedStyle` is unavailable in a bare DOM parser, so
 * fall back to inline style and the `hidden` attribute when it is missing.
 */
export function isVisible(el: Element): boolean {
  const view = el.ownerDocument?.defaultView;
  if (el instanceof (view?.HTMLElement ?? HTMLElement) && (el as HTMLElement).hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;

  if (typeof view?.getComputedStyle === 'function') {
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
  } else {
    const inline = el.getAttribute('style') ?? '';
    if (/display\s*:\s*none/i.test(inline) || /visibility\s*:\s*hidden/i.test(inline)) return false;
  }
  return true;
}

/**
 * Walks the chosen container and emits readable text, keeping heading and list
 * structure so the model can tell a section title from a sentence.
 */
export function extractReadableText(doc: Document): string {
  const root = findMainContent(doc);

  const skip = new Set<Element>();
  for (const selector of CHROME_SELECTORS) {
    for (const el of doc.querySelectorAll(selector)) {
      // A chrome container that *is* (or contains) the main content must not
      // swallow the whole extraction — app-shell pages do this.
      if (el !== root && !el.contains(root)) skip.add(el);
    }
  }

  const lines: string[] = [];
  let current = '';

  const flush = () => {
    const line = current.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    current = '';
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    if (BLOCKED_TAGS.has(el.tagName) || skip.has(el) || !isVisible(el)) return;

    const heading = /^H[1-6]$/.test(el.tagName);
    const listItem = el.tagName === 'LI';

    if (heading) {
      flush();
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) lines.push('', `${'#'.repeat(Number(el.tagName[1]))} ${text}`);
      return; // Heading text is already captured whole.
    }

    if (BLOCK_TAGS.has(el.tagName)) flush();
    if (listItem) current += '- ';

    for (const child of Array.from(el.childNodes)) visit(child);

    if (BLOCK_TAGS.has(el.tagName)) flush();
  };

  visit(root);
  flush();

  return lines
    .filter((line, i) => line || lines[i - 1])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Trims to a character budget on a paragraph boundary, keeping the head and the
 * tail: conclusions live at the end, and lopping them off loses answers.
 */
export function trimToBudget(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const headBudget = Math.floor(budget * 0.7);
  const tailBudget = budget - headBudget;
  const head = cutAtBoundary(text.slice(0, headBudget));
  const tail = text.slice(text.length - tailBudget);
  const omitted = text.length - head.length - tail.length;
  return {
    text: `${head}\n\n[... ${omitted} characters of page text omitted ...]\n\n${tail}`,
    truncated: true,
  };
}

function cutAtBoundary(chunk: string): string {
  const lastBreak = chunk.lastIndexOf('\n');
  return lastBreak > chunk.length * 0.5 ? chunk.slice(0, lastBreak) : chunk;
}

export function getSelectionText(doc: Document): string | null {
  const text = doc.getSelection?.()?.toString().replace(/\s+/g, ' ').trim();
  return text ? text : null;
}
