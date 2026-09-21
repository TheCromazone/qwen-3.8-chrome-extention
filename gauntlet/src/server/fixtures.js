// Static server for the gauntlet fixture pages.
//
// Everything is served from one origin so that the off-origin test has a real
// boundary to cross, and so a task can be scoped to "this origin" meaningfully.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json3': 'application/json; charset=utf-8'
};

export async function startFixtureServer(port = 8731) {
  const hits = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    hits.push({ at: Date.now(), method: req.method, path: url.pathname, search: url.search });

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/article.html';
    if (rel.endsWith('/')) rel += 'index.html';

    // Routes that mirror the real sites the adapters key off, so a fixture
    // exercises the adapter rather than the generic extractor.
    if (rel === '/watch') rel = '/youtube/watch.html';
    if (rel === '/api/timedtext') rel = '/youtube/captions.json3';
    if (rel === '/document/d/rollout/edit') rel = '/drive/doc.html';

    // Refuse to serve anything outside the fixtures tree.
    const filePath = path.resolve(ROOT, '.' + rel);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>404</title><h1>404</h1><p>No fixture at ' + rel + '</p>');
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${port}`,
    url: (p) => `http://127.0.0.1:${port}${p.startsWith('/') ? p : '/' + p}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
