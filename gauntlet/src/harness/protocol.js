// The wire format the gauntlet assumes between the extension and the model.
//
// This file and driver.js are the only two that know anything about the
// extension's internals. If the real build's snapshot or action encoding turns
// out different, change these constants and every test keeps working.

/**
 * How a ref appears in a snapshot line. The architecture note says actions
 * carry a ref into the snapshot, never coordinates, so a snapshot line looks
 * roughly like:
 *
 *   link "Meridian desk lamp" [ref=e17]
 */
export const REF_PATTERN = /\[ref=([a-zA-Z0-9_-]+)\]/g;

/** How the model is expected to answer with an action. */
export const ACTION_ENCODING = {
  /** Emit a bare JSON object; the extension parses it out of the content. */
  encode(action) {
    return JSON.stringify(action);
  },
  /** Read an action back out of a model message, for assertions. */
  decode(content) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
};

/** Everything the extension sent, flattened to one string for matching. */
export function allText(body) {
  const parts = [];
  if (typeof body?.prompt === 'string') parts.push(body.prompt);
  if (typeof body?.system === 'string') parts.push(body.system);
  for (const m of body?.messages ?? []) {
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

/** Just the last user turn — where the page snapshot normally lives. */
export function lastUserText(body) {
  const msgs = (body?.messages ?? []).filter((m) => m.role === 'user');
  const last = msgs[msgs.length - 1];
  if (!last) return typeof body?.prompt === 'string' ? body.prompt : '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) return last.content.map((c) => c?.text ?? '').join('\n');
  return '';
}

/** Every ref the snapshot offered, with the line it appeared on. */
export function extractRefs(body) {
  const text = allText(body);
  const out = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(REF_PATTERN)) out.push({ ref: m[1], line: line.trim() });
  }
  return out;
}

/**
 * Turn a scripted intent ("click the thing labelled X") into the action text
 * the mock returns, resolving the ref against the snapshot the extension
 * actually sent. This is deliberately not a lookup table of hardcoded refs: if
 * the snapshot does not expose a findable ref for a visible, clickable thing,
 * the mock cannot act, and that is a genuine failure of the snapshot format.
 */
export function resolveAction(act, body) {
  const spec = { ...act };

  if (spec.find) {
    const refs = extractRefs(body);
    const needle = spec.find.toLowerCase();
    // Prefer an exact quoted label, fall back to a substring match.
    const exact = refs.find((r) => r.line.toLowerCase().includes('"' + needle + '"'));
    const loose = refs.find((r) => r.line.toLowerCase().includes(needle));
    const hit = exact ?? loose;
    if (!hit) {
      return {
        text: ACTION_ENCODING.encode({
          type: 'answer',
          text: 'GAUNTLET-MOCK-UNRESOLVED: no ref in the snapshot matched ' + JSON.stringify(spec.find)
        }),
        unresolved: spec.find
      };
    }
    spec.ref = hit.ref;
    delete spec.find;
  }

  return { text: ACTION_ENCODING.encode(spec), unresolved: false };
}

/**
 * Untrusted page text must reach the model fenced as data rather than
 * concatenated as instructions. Any of these shapes counts; the point is that
 * a boundary exists and is labelled, not which syntax was picked.
 */
export const FENCE_MARKERS = [
  /<untrusted[_-]?(page[_-]?)?(content|data)>/i,
  /```untrusted/i,
  /BEGIN UNTRUSTED PAGE CONTENT/i,
  /\[untrusted page content\]/i,
  /<page_content[^>]*untrusted/i
];

export function looksFenced(text, injectedSnippet) {
  const idx = text.indexOf(injectedSnippet);
  if (idx === -1) return { fenced: false, reason: 'injected text not present in prompt at all' };
  const before = text.slice(0, idx);
  const marker = FENCE_MARKERS.find((m) => m.test(before));
  return marker
    ? { fenced: true, marker: String(marker) }
    : { fenced: false, reason: 'injected text appears with no untrusted-data fence opened before it' };
}
