import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPlayerResponse,
  formatTimestamp,
  formatTranscript,
  isYouTubeWatchPage,
  parseJson3,
  pickCaptionTrack,
  videoIdFrom,
} from '../src/content/youtube.ts';

describe('isYouTubeWatchPage', () => {
  test('accepts watch URLs on youtube.com and its subdomains', () => {
    assert.equal(isYouTubeWatchPage('https://www.youtube.com/watch?v=abc123'), true);
    assert.equal(isYouTubeWatchPage('https://m.youtube.com/watch?v=abc123'), true);
  });

  test('rejects other YouTube pages and lookalike hosts', () => {
    assert.equal(isYouTubeWatchPage('https://www.youtube.com/feed/subscriptions'), false);
    assert.equal(isYouTubeWatchPage('https://www.youtube.com/watch'), false, 'no video id');
    assert.equal(isYouTubeWatchPage('https://notyoutube.com/watch?v=abc'), false);
    assert.equal(isYouTubeWatchPage('https://youtube.com.evil.test/watch?v=abc'), false);
    assert.equal(isYouTubeWatchPage('not a url'), false);
  });

  test('reads the video id', () => {
    assert.equal(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  });
});

describe('extractPlayerResponse', () => {
  test('pulls the balanced object out of the watch page', () => {
    const html = `<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"A talk"},"nested":{"a":{"b":1}}};var x=1;</script>`;
    assert.equal((extractPlayerResponse(html) as any)?.videoDetails?.title, 'A talk');
  });

  test('is not confused by braces inside strings', () => {
    const html = `<script>ytInitialPlayerResponse = {"videoDetails":{"title":"Braces } everywhere {"}};</script>`;
    assert.equal((extractPlayerResponse(html) as any)?.videoDetails?.title, 'Braces } everywhere {');
  });

  test('returns null when the marker is absent', () => {
    assert.equal(extractPlayerResponse('<html><body>no player here</body></html>'), null);
  });
});

describe('pickCaptionTrack', () => {
  const player = (tracks: unknown[]) => ({
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  });

  test('prefers manual English captions over auto-generated ones', () => {
    const chosen = pickCaptionTrack(
      player([
        { baseUrl: 'auto', languageCode: 'en', kind: 'asr' },
        { baseUrl: 'manual', languageCode: 'en' },
      ]),
    );
    assert.equal(chosen?.baseUrl, 'manual');
  });

  test('falls back to auto-generated when that is all there is', () => {
    const chosen = pickCaptionTrack(player([{ baseUrl: 'auto', languageCode: 'en', kind: 'asr' }]));
    assert.equal(chosen?.baseUrl, 'auto');
  });

  test('falls back to another language rather than nothing', () => {
    const chosen = pickCaptionTrack(player([{ baseUrl: 'de', languageCode: 'de' }]));
    assert.equal(chosen?.baseUrl, 'de');
  });

  test('returns null when the video has no captions', () => {
    assert.equal(pickCaptionTrack({}), null);
  });
});

describe('parseJson3', () => {
  test('joins segments into cues and drops empty ones', () => {
    const cues = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
        { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: 'Second line' }] },
        { tStartMs: 9000, aAppend: 1 },
      ],
    });

    assert.deepEqual(cues, [
      { start: 0, duration: 2, text: 'Hello world' },
      { start: 3, duration: 1.5, text: 'Second line' },
    ]);
  });
});

describe('formatTimestamp', () => {
  test('uses m:ss under an hour and h:mm:ss over', () => {
    assert.equal(formatTimestamp(0), '0:00');
    assert.equal(formatTimestamp(65), '1:05');
    assert.equal(formatTimestamp(3725), '1:02:05');
  });
});

describe('formatTranscript', () => {
  test('prefixes every line with a timestamp the model can cite', () => {
    const out = formatTranscript([
      { start: 0, duration: 2, text: 'Intro' },
      { start: 754, duration: 2, text: 'The answer is B' },
    ]);
    assert.equal(out, '[0:00] Intro\n[12:34] The answer is B');
  });

  test('thins a long transcript instead of cutting its ending off', () => {
    const cues = Array.from({ length: 4000 }, (_, i) => ({ start: i * 5, duration: 5, text: `line number ${i}` }));
    const out = formatTranscript(cues, 20000);

    assert.ok(out.length <= 20000 + 40, `expected it to fit the budget, got ${out.length}`);
    assert.match(out, /\[0:00\]/, 'the start should survive');
    assert.match(out, /line number 39\d\d/, 'the end should survive too');
  });
});
