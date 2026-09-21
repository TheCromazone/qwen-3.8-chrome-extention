// Static server for the gauntlet fixture pages.
//
// Everything is served from one origin so that the off-origin test has a real
// boundary to cross, and so a task can be scoped to "this origin" meaningfully.
import https from 'node:https';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Hostnames the fixtures answer to. The adapters key off these exactly —
 * the YouTube adapter matches /(^|\.)youtube\.com$/ and nothing else — so the
 * fixture has to be reachable under the real name or it tests the generic
 * extractor while claiming to test the adapter.
 */
export const FIXTURE_HOSTS = ['www.youtube.com', 'youtube.com', 'docs.google.com', 'drive.google.com'];

/**
 * Fixtures are served over TLS, with a self-signed certificate generated at
 * startup. Not for realism: youtube.com and google.com are in Chrome's HSTS
 * preload list, so a plain-http fixture under those names is upgraded to https
 * by the browser and fails to connect. Older Chromium builds let it through,
 * which is exactly the kind of difference that passes locally and fails in CI.
 */
function selfSignedCert() {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const altNames = ['DNS:localhost', 'IP:127.0.0.1', ...FIXTURE_HOSTS.map((h) => `DNS:${h}`)].join(',');

  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '2', '-subj', '/CN=gauntlet-fixtures',
        '-addext', `subjectAltName=${altNames}`
      ],
      { stdio: 'pipe' }
    );
  } catch (err) {
    throw new Error(
      'The gauntlet serves its fixtures over TLS and needs openssl to make a throwaway certificate. ' +
      'Install openssl, or set GAUNTLET_TLS_CERT and GAUNTLET_TLS_KEY to a certificate covering ' +
      FIXTURE_HOSTS.join(', ') + '. Underlying error: ' + (err.stderr?.toString() || err.message)
    );
  }

  return { key: fsSync.readFileSync(keyPath), cert: fsSync.readFileSync(certPath), dir };
}

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
  const tls =
    process.env.GAUNTLET_TLS_CERT && process.env.GAUNTLET_TLS_KEY
      ? { cert: fsSync.readFileSync(process.env.GAUNTLET_TLS_CERT), key: fsSync.readFileSync(process.env.GAUNTLET_TLS_KEY), dir: null }
      : selfSignedCert();

  const server = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const url = new URL(req.url, `https://127.0.0.1:${port}`);
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
    origin: `https://127.0.0.1:${port}`,
    url: (p) => `https://127.0.0.1:${port}${p.startsWith('/') ? p : '/' + p}`,
    hosts: FIXTURE_HOSTS,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          if (tls.dir) fsSync.rmSync(tls.dir, { recursive: true, force: true });
          resolve();
        });
      })
  };
}
