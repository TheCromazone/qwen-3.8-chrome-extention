// The wire format between the extension and the model.
//
// This file and driver.js are the only two that know anything about the
// extension's internals. The dialect below is the one the extension actually
// speaks, read off its own tool schema rather than imposed on it:
//
//   snapshot line   [12] link "Meridian desk lamp" [flags]
//   action          a native Ollama tool call, or — for models without tool
//                   calling — {"tool": "...", "arguments": {...}} constrained
//                   by a JSON schema.
//
// The mock speaks this so that what it exercises is the extension's real
// decoding path, not a format invented for the test.

/** Snapshot ref shapes, newest first. */
export const REF_PATTERNS = [
  /^\s*\[(\d+)\]/,                  // [12] link "…"
  /\[ref=([a-zA-Z0-9_-]+)\]/        // legacy: link "…" [ref=e12]
];

/** Generic action names the gauntlet scripts, mapped onto the extension's tools. */
export const TOOL_NAMES = {
  click: 'click',
  type: 'type_text',
  navigate: 'navigate',
  screenshot: 'take_screenshot',
  answer: 'finish',
  scroll: 'scroll',
  submit: 'press_key',
  transcript: 'get_transcript',
  observe: 'observe'
};

/** Turn a generic action into the arguments the extension's tool expects. */
export function toToolCall(action) {
  const name = TOOL_NAMES[action.type] ?? action.type;
  const ref = action.ref != null && /^\d+$/.test(String(action.ref)) ? Number(action.ref) : action.ref;
  switch (action.type) {
    case 'click': return { name, arguments: { ref } };
    case 'type': return { name, arguments: { ref, text: action.value ?? '', submit: Boolean(action.submit) } };
    case 'navigate': return { name, arguments: { url: action.url } };
    case 'screenshot': return { name, arguments: {} };
    case 'submit': return { name, arguments: { key: 'Enter' } };
    case 'answer': return { name, arguments: { summary: action.text ?? '', succeeded: true } };
    case 'scroll': return { name, arguments: { direction: action.direction ?? 'down' } };
    default: return { name, arguments: { ...action, type: undefined } };
  }
}

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
  const out = [];
  for (const line of allText(body).split('\n')) {
    for (const pattern of REF_PATTERNS) {
      const m = line.match(pattern);
      if (m) { out.push({ ref: m[1], line: line.trim() }); break; }
    }
  }
  return out;
}

/**
 * Turn a scripted intent ("click the thing labelled X") into the action the
 * mock returns, resolving the ref against the snapshot the extension actually
 * sent. This is deliberately not a lookup table of hardcoded refs: if the
 * snapshot does not expose a findable ref for a visible, clickable thing, the
 * mock cannot act, and that is a genuine failure of the snapshot format.
 */
export function resolveAction(act, body) {
  const spec = { ...act };

  if (spec.find) {
    const refs = extractRefs(body);
    const needle = spec.find.toLowerCase();
    const exact = refs.find((r) => r.line.toLowerCase().includes('"' + needle + '"'));
    const loose = refs.find((r) => r.line.toLowerCase().includes(needle));
    const hit = exact ?? loose;
    if (!hit) {
      return {
        unresolved: spec.find,
        toolCall: toToolCall({
          type: 'answer',
          text: 'GAUNTLET-MOCK-UNRESOLVED: no ref in the snapshot matched ' + JSON.stringify(spec.find)
        })
      };
    }
    spec.ref = hit.ref;
    delete spec.find;
  }

  return { toolCall: toToolCall(spec), unresolved: false };
}

/**
 * Untrusted page text must reach the model fenced as data rather than
 * concatenated as instructions. Any of these shapes counts; the point is that
 * a boundary exists and is labelled, not which syntax was picked.
 */
export const FENCE_MARKERS = [
  /<untrusted[_-]?[a-z]*[_-]?(content|data|page)?[^>]*>/i,
  /```untrusted/i,
  /BEGIN UNTRUSTED/i,
  /\[untrusted[^\]]*\]/i
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
