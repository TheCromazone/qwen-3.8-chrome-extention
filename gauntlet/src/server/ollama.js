// The gauntlet's Ollama endpoint.
//
// The extension always points at this server. It runs in one of two modes:
//
//   mock  — scripted, deterministic responses. Tests the harness: extraction,
//           the element index, action execution, gates, fencing.
//   proxy — forwards verbatim to the real Ollama and streams the real response
//           back, recording everything that passes through.
//
// Recording in both modes is what lets prompt-level pass conditions ("the
// buried fact reached the model", "the injected text was fenced as data") be
// asserted identically whether or not a real model is in the loop.
import http from 'node:http';
import { resolveAction, extractRefs, lastUserText, allText } from '../harness/protocol.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS,DELETE',
  'access-control-allow-private-network': 'true'
};

export async function startOllamaServer({
  port = 11435,
  mode = 'mock',
  upstream = 'http://127.0.0.1:11434',
  model = 'qwen3.8:27b'
} = {}) {
  /** Every request the extension made, in order. */
  const requests = [];
  /** Scripted steps, consumed in order; see scriptFrom(). */
  let script = [];
  let scriptCursor = 0;
  let fallback = null;

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  function nextScripted(body) {
    const prompt = allText(body);
    // Prefer the first unconsumed step whose `when` matches; otherwise take the
    // next step in order. A step that names a condition it cannot meet is a
    // failure we want visible, so an unmatched `when` is never silently reused.
    for (let i = scriptCursor; i < script.length; i++) {
      const step = script[i];
      if (step.when && !new RegExp(step.when, 'i').test(prompt)) continue;
      scriptCursor = i + 1;
      return step;
    }
    return fallback;
  }

  function renderScripted(step, body) {
    if (!step) {
      return { content: 'MOCK: no scripted response left for this request.', unscripted: true };
    }
    if (step.content != null) return { content: step.content };
    if (step.act) {
      // The mock resolves its action against the snapshot the extension
      // actually sent, the way a model would. If the ref for the thing it was
      // told to click is not findable in the snapshot, the mock says so — and
      // that is a real finding about the snapshot format, not a mock bug.
      const { toolCall, unresolved } = resolveAction(step.act, body);

      // Answer in whichever dialect this request asked for: a native tool call
      // when the extension offered tools, the constrained JSON object when it
      // sent a schema instead. Anything else and the mock would be testing a
      // decoding path the extension does not use.
      if (Array.isArray(body.tools) && body.tools.length) {
        return { content: '', toolCalls: [{ function: toolCall }], unresolved };
      }
      return {
        content: JSON.stringify({ tool: toolCall.name, arguments: toolCall.arguments }),
        unresolved
      };
    }
    return { content: '' };
  }

  function ndjson(res, chunks) {
    res.writeHead(200, { ...CORS, 'content-type': 'application/x-ndjson' });
    for (const c of chunks) res.write(JSON.stringify(c) + '\n');
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }

    // ---- gauntlet control plane -------------------------------------------
    if (url.pathname === '/__gauntlet/requests') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify(requests));
      return;
    }
    if (url.pathname === '/__gauntlet/script' && req.method === 'POST') {
      const parsed = JSON.parse((await readBody(req)) || '{}');
      script = parsed.steps ?? [];
      fallback = parsed.fallback ?? null;
      scriptCursor = 0;
      res.writeHead(200, CORS).end('{"ok":true}');
      return;
    }
    if (url.pathname === '/__gauntlet/reset' && req.method === 'POST') {
      requests.length = 0;
      script = [];
      scriptCursor = 0;
      fallback = null;
      res.writeHead(200, CORS).end('{"ok":true}');
      return;
    }

    // ---- Ollama surface ----------------------------------------------------
    if (url.pathname === '/api/tags') {
      if (mode === 'proxy') return void proxyThrough(req, res, url, upstream, requests, null);
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: model, model, size: 18_000_000_000 }] }));
      return;
    }

    if (url.pathname === '/api/show') {
      if (mode === 'proxy') return void proxyThrough(req, res, url, upstream, requests, await readBody(req));
      res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['vision', 'tools', 'thinking'], model_info: { 'qwen3.context_length': 262144 } }));
      return;
    }

    if (url.pathname === '/api/chat' || url.pathname === '/api/generate') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded below as unparseable */ }

      const record = {
        at: Date.now(),
        path: url.pathname,
        body,
        raw,
        promptText: allText(body),
        lastUser: lastUserText(body),
        refs: extractRefs(body),
        hasImage: hasImagePart(body),
        options: body.options ?? null,
        keepAlive: body.keep_alive ?? null,
        model: body.model ?? null
      };
      requests.push(record);

      if (mode === 'proxy') return void proxyThrough(req, res, url, upstream, requests, raw, record);

      const step = nextScripted(body);
      const { content, toolCalls, unresolved, unscripted } = renderScripted(step, body);
      record.mockStep = step ?? null;
      record.mockUnresolved = unresolved ?? false;
      record.mockUnscripted = unscripted ?? false;
      record.mockToolCalls = toolCalls ?? null;

      const now = () => new Date().toISOString();
      const stream = body.stream !== false;

      if (!stream) {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: body.model ?? model,
          created_at: now(),
          message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
          done: true,
          done_reason: 'stop'
        }));
        return;
      }

      // Stream it in pieces so the extension's streaming path is exercised.
      // A tool call arrives whole on the final chunk, the way Ollama sends it.
      const pieces = chunk(content, 24);
      ndjson(res, [
        ...pieces.map((p) => ({ model: body.model ?? model, created_at: now(), message: { role: 'assistant', content: p }, done: false })),
        {
          model: body.model ?? model,
          created_at: now(),
          message: { role: 'assistant', content: '', ...(toolCalls ? { tool_calls: toolCalls } : {}) },
          done: true,
          done_reason: toolCalls ? 'stop' : 'stop',
          eval_count: pieces.length
        }
      ]);
      return;
    }

    if (mode === 'proxy') return void proxyThrough(req, res, url, upstream, requests, await readBody(req));
    res.writeHead(404, CORS).end('{"error":"not found"}');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    mode,
    requests,
    setScript: (steps, fb = null) => { script = steps; fallback = fb; scriptCursor = 0; },
    reset: () => { requests.length = 0; script = []; scriptCursor = 0; fallback = null; },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function chunk(s, n) {
  if (!s) return [''];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function hasImagePart(body) {
  const msgs = body.messages ?? [];
  for (const m of msgs) {
    if (Array.isArray(m.images) && m.images.length) return true;
    if (Array.isArray(m.content) && m.content.some((c) => c?.type === 'image' || c?.type === 'image_url')) return true;
  }
  return Array.isArray(body.images) && body.images.length > 0;
}

async function proxyThrough(req, res, url, upstream, requests, raw, record) {
  try {
    const upstreamRes = await fetch(upstream + url.pathname + url.search, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: req.method === 'POST' ? raw : undefined
    });
    res.writeHead(upstreamRes.status, { ...CORS, 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' });

    if (!upstreamRes.body) { res.end(); return; }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let collected = '';
    let firstByteAt = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === null) firstByteAt = Date.now();
      const text = decoder.decode(value, { stream: true });
      collected += text;
      res.write(value);
    }
    res.end();
    if (record) {
      record.responseRaw = collected;
      record.responseText = joinNdjsonContent(collected);
      record.firstByteAt = firstByteAt;
      record.doneAt = Date.now();
    }
  } catch (err) {
    if (record) record.upstreamError = String(err);
    if (!res.headersSent) res.writeHead(502, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'gauntlet proxy could not reach Ollama at ' + upstream + ': ' + String(err) }));
  }
}

function joinNdjsonContent(raw) {
  let out = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      out += o?.message?.content ?? o?.response ?? '';
    } catch { /* partial line */ }
  }
  return out;
}
