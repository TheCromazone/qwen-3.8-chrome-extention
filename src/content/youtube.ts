/**
 * YouTube transcript retrieval. The caption track URLs live in the watch page's
 * `ytInitialPlayerResponse`, which the isolated world cannot read as a variable,
 * so we re-fetch the watch HTML (same origin, cached) and parse it out.
 */
import type { TranscriptCue } from '../lib/types.ts';

export function isYouTubeWatchPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(parsed.hostname)) return false;
    return parsed.pathname === '/watch' && parsed.searchParams.has('v');
  } catch {
    return false;
  }
}

export function videoIdFrom(url: string): string | null {
  try {
    return new URL(url).searchParams.get('v');
  } catch {
    return null;
  }
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string };
}

/** Pulls the balanced JSON object that follows `ytInitialPlayerResponse =`. */
export function extractPlayerResponse(html: string): Record<string, unknown> | null {
  const marker = 'ytInitialPlayerResponse';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = html.indexOf('{', markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function pickCaptionTrack(player: Record<string, any>, preferred = 'en'): CaptionTrack | null {
  const tracks: CaptionTrack[] =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) return null;

  // Manual captions in the preferred language beat auto-generated ones, which
  // beat anything else that exists.
  return (
    tracks.find((t) => t.languageCode?.startsWith(preferred) && t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode?.startsWith(preferred)) ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0] ??
    null
  );
}

export function parseJson3(body: unknown): TranscriptCue[] {
  const events = (body as { events?: Array<Record<string, any>> })?.events ?? [];
  const cues: TranscriptCue[] = [];
  for (const event of events) {
    const segments = event.segs as Array<{ utf8?: string }> | undefined;
    if (!segments) continue;
    const text = segments
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text === '\n') continue;
    cues.push({
      start: Math.round((event.tStartMs ?? 0) / 100) / 10,
      duration: Math.round((event.dDurationMs ?? 0) / 100) / 10,
      text,
    });
  }
  return cues;
}

export async function fetchTranscript(url: string, preferred = 'en'): Promise<TranscriptCue[] | null> {
  if (!isYouTubeWatchPage(url)) return null;
  const html = await fetch(url, { credentials: 'include' }).then((r) => (r.ok ? r.text() : null));
  if (!html) return null;

  const player = extractPlayerResponse(html);
  if (!player) return null;

  const track = pickCaptionTrack(player, preferred);
  if (!track?.baseUrl) return null;

  const trackUrl = new URL(track.baseUrl);
  trackUrl.searchParams.set('fmt', 'json3');
  const body = await fetch(trackUrl.toString(), { credentials: 'include' }).then((r) => (r.ok ? r.json() : null));
  if (!body) return null;

  const cues = parseJson3(body);
  return cues.length ? cues : null;
}

/**
 * Renders cues as timestamped lines. Timestamps matter: quiz questions are
 * usually answerable only if the model can point at where something was said.
 */
export function formatTranscript(cues: TranscriptCue[], budget = 40000): string {
  const lines = cues.map((cue) => `[${formatTimestamp(cue.start)}] ${cue.text}`);
  let out = lines.join('\n');
  if (out.length > budget) {
    // Drop every other cue until it fits rather than truncating the ending.
    let step = 2;
    while (out.length > budget && step < 16) {
      out = lines.filter((_, i) => i % step === 0).join('\n');
      step *= 2;
    }
    if (out.length > budget) out = `${out.slice(0, budget)}\n[... transcript truncated ...]`;
  }
  return out;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
