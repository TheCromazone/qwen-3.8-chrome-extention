// Transcript retrieval, the way a watch page really works: the caption track
// URLs live in ytInitialPlayerResponse in the watch HTML, so re-fetch the page
// and parse them out. The transcript is never in the DOM until the panel is
// opened, which is why a generic text grab cannot find it.

export function isWatchPage(url) {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/watch' && u.searchParams.has('v');
  } catch {
    return false;
  }
}

export async function fetchTranscript(url) {
  if (!isWatchPage(url)) return null;
  const html = await fetch(url).then((r) => (r.ok ? r.text() : null));
  if (!html) return null;

  const marker = html.indexOf('ytInitialPlayerResponse');
  if (marker === -1) return null;
  const start = html.indexOf('{', marker);
  const player = parseBalanced(html, start);
  if (!player) return null;

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track =
    tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ?? tracks[0] ?? null;
  if (!track?.baseUrl) return null;

  const trackUrl = new URL(track.baseUrl);
  trackUrl.searchParams.set('fmt', 'json3');
  const body = await fetch(trackUrl.toString()).then((r) => (r.ok ? r.json() : null));
  if (!body) return null;

  const cues = (body.events ?? [])
    .map((e) => ({
      start: (e.tStartMs ?? 0) / 1000,
      text: (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim()
    }))
    .filter((c) => c.text);

  return cues.length ? cues : null;
}

export function formatTranscript(cues) {
  return cues.map((c) => `[${stamp(c.start)}] ${c.text}`).join('\n');
}

function stamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseBalanced(text, start) {
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
