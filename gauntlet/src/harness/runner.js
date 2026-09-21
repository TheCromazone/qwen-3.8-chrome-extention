// The gauntlet runner.
//
// Deliberately not @playwright/test: the output that matters here is a
// scoreboard of named tasks with the observation that falsified each failing
// pass condition, not a test report. A task that cannot run in the current mode
// is reported as skipped and never counted as a pass.
import { startFixtureServer } from '../server/fixtures.js';
import { startOllamaServer } from '../server/ollama.js';
import { launchWithExtension } from './browser.js';
import { ExtensionDriver } from './driver.js';
import { environment, slugFor } from './scoreboard.js';

export class CheckFailed extends Error {
  constructor(message, observed) {
    super(message);
    this.name = 'CheckFailed';
    this.observed = observed;
  }
}

/** Assert a pass condition. The observed value is what lands in the scoreboard. */
export function check(condition, message, observed) {
  if (!condition) throw new CheckFailed(message, observed);
}

export function checkIncludes(haystack, needle, what, { limit = 400 } = {}) {
  const ok = String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
  check(ok, `${what} should contain ${JSON.stringify(needle)}`, snippet(haystack, limit));
}

export function checkExcludes(haystack, needle, what, { limit = 400 } = {}) {
  const ok = !String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
  check(ok, `${what} must not contain ${JSON.stringify(needle)}`, snippet(haystack, limit));
}

function snippet(v, limit) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (s == null) return String(v);
  return s.length > limit ? s.slice(0, limit) + ` …[${s.length} chars total]` : s;
}

const DEFAULT_SETTINGS = {
  model: 'qwen3.8:27b',
  numCtx: 65536,
  reasoningEffort: 'medium',
  keepAlive: -1
};

export async function runGauntlet({
  tasks,
  mode = 'mock',
  extensionPath,
  headless = true,
  only = null,
  upstream = 'http://127.0.0.1:11434',
  fixturePort = 8731,
  ollamaPort = 11435,
  onResult = () => {}
}) {
  const fixtures = await startFixtureServer(fixturePort);
  const ollama = await startOllamaServer({
    port: ollamaPort,
    mode: mode === 'real' ? 'proxy' : 'mock',
    upstream
  });

  const results = [];
  const startedAt = Date.now();

  const selected = tasks.filter((t) => (only ? only.includes(t.id) : true));

  for (const task of selected) {
    if (!task.modes.includes(mode)) {
      const r = { id: task.id, name: task.name, group: task.group, mode, status: 'skip', reason: `not meaningful in ${mode} mode`, ms: 0 };
      results.push(r);
      onResult(r);
      continue;
    }

    const t0 = Date.now();
    let browser = null;
    try {
      ollama.reset();
      browser = await launchWithExtension({ extensionPath, headless, fixturePort });
      const driver = new ExtensionDriver(browser.context, browser);
      await driver.seedSettings({ ...DEFAULT_SETTINGS, ollamaUrl: ollama.url, ...(task.settings ?? {}) });

      await task.run({
        mode,
        driver,
        browser,
        fixtures,
        ollama,
        context: browser.context,
        open: async (p, { host } = {}) => {
          const page = await browser.context.newPage();
          const url = host ? `https://${host}${p.startsWith('/') ? p : '/' + p}` : fixtures.url(p);
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          return page;
        }
      });

      const r = { id: task.id, name: task.name, group: task.group, mode, status: 'pass', ms: Date.now() - t0 };
      results.push(r);
      onResult(r);
    } catch (err) {
      const r = {
        id: task.id,
        name: task.name,
        group: task.group,
        mode,
        status: 'fail',
        ms: Date.now() - t0,
        why: err instanceof CheckFailed ? err.message : `${err.name}: ${err.message}`,
        observed: err instanceof CheckFailed ? err.observed : (err.stack ?? '').split('\n').slice(0, 4).join('\n')
      };
      results.push(r);
      onResult(r);
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  await ollama.close();
  await fixtures.close();

  return {
    mode,
    startedAt,
    finishedAt: Date.now(),
    extension: slugFor(extensionPath),
    environment: environment(),
    results
  };
}
