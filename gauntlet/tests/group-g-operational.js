// Group G — operational parity. Speed and failure messages are most of what
// makes Ask Gemini feel good; matching its features at a quarter of its speed
// is not parity.
import { check } from '../src/harness/runner.js';

export default [
  {
    id: 'G21',
    name: 'ollama-unreachable',
    group: 'G',
    modes: ['mock'],
    // Port 1 is closed, so this is a connection refusal, which is what both
    // "Ollama is not running" and "OLLAMA_ORIGINS rejected us" look like from
    // inside the extension. The latter is the single most likely first-run
    // failure on a fresh machine, so the message has to name it.
    settings: { ollamaUrl: 'http://127.0.0.1:1' },
    async run({ driver, open }) {
      await open('/article.html');
      await driver.openPanel();

      const t0 = Date.now();
      await driver.askThroughUi('What year did the observatory come online?');
      const message = await driver.visibleError({ timeout: 12000 });
      const elapsed = Date.now() - t0;

      check(elapsed < 10000, `the error took ${Math.round(elapsed / 1000)}s to appear; a user has given up by then`, { elapsed });
      check(
        /ollama/i.test(message),
        'the error does not mention Ollama, so the user cannot tell what is broken',
        message
      );
      check(
        /OLLAMA_ORIGINS|origin|not running|start ollama|serve/i.test(message),
        'the error names no likely cause — a bare failure message leaves the most common first-run problem (OLLAMA_ORIGINS not allowing the extension) undiagnosed',
        message
      );
    }
  },

  {
    id: 'G22',
    name: 'first-token-latency',
    group: 'G',
    modes: ['real'],
    async run({ driver, open, ollama }) {
      await open('/article.html');
      await driver.openPanel();

      // Warm the model so this measures generation, not an 18GB load.
      await driver.ask('Say OK.');
      ollama.reset();

      const t0 = Date.now();
      await driver.ask('What year did the observatory first come online?');
      const total = Date.now() - t0;

      const record = ollama.requests.at(-1);
      check(record != null, 'no request was recorded', ollama.requests);
      const firstToken = (record.firstByteAt ?? record.doneAt ?? Date.now()) - record.at;

      check(firstToken < 4000, `first token took ${(firstToken / 1000).toFixed(1)}s; Ask Gemini answers in about 2s`, {
        firstTokenMs: firstToken,
        totalMs: total
      });
      check(total < 20000, `the full answer took ${(total / 1000).toFixed(1)}s`, { totalMs: total });
    }
  },

  {
    id: 'G23',
    name: 'long-task-survival',
    group: 'G',
    modes: ['real'],
    async run({ driver, open, ollama, fixtures }) {
      await open('/shop/index.html');
      await driver.openPanel();

      const t0 = Date.now();
      const result = await driver.runTask(
        'Visit every department in this shop, note the price of every item you find, and then tell me the cheapest and the most expensive item in the whole shop.',
        { allowOrigins: [fixtures.origin], timeout: 900000 }
      );
      const wall = Date.now() - t0;
      const journal = result.journal ?? (await driver.journal());

      check(journal.length >= 10, `the task finished in ${journal.length} steps; it needs at least 10 to have visited every department`, journal.length);

      // keep_alive: -1 on every request. Without it an 18GB model is evicted
      // after five idle minutes and the next step pays a cold load.
      const bad = ollama.requests.filter((r) => r.keepAlive !== -1 && r.keepAlive !== '-1');
      check(bad.length === 0, `${bad.length} of ${ollama.requests.length} requests did not send keep_alive: -1`, {
        sample: bad.slice(0, 3).map((r) => r.keepAlive)
      });

      // num_ctx on every request, or Ollama silently caps at 4096.
      const noCtx = ollama.requests.filter((r) => !r.options?.num_ctx);
      check(noCtx.length === 0, `${noCtx.length} requests omitted options.num_ctx, so Ollama capped the context at 4096`, {
        sample: noCtx.slice(0, 3).map((r) => r.options)
      });

      check(/\$38|\$145/.test(result.answer), 'the answer did not name the cheapest and dearest items', result.answer);
      check(wall > 60000, `the run took only ${Math.round(wall / 1000)}s, which is too short to have tested survival`, wall);
    }
  }
];
