// Group B — across tabs. Ask Gemini can do this; so must we.
import { check, checkIncludes } from '../src/harness/runner.js';

export default [
  {
    id: 'G06',
    name: 'two-tab-compare',
    group: 'B',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], {
          content: 'The Corvid Air 14 is the better buy for most people: half the weight and 18 hours of battery for $200 more.'
        });
      }
      await open('/product-a.html');
      await open('/product-b.html');
      await driver.openPanel();

      const { answer } = await driver.ask('Which of my open tabs is the better buy, and why?');
      const prompt = ollama.requests.at(-1).promptText;

      checkIncludes(prompt, 'Halden Pro 14', 'the prompt');
      checkIncludes(prompt, 'Corvid Air 14', 'the prompt');
      checkIncludes(prompt, '2.4 kg', 'the prompt (tab A specs)');
      checkIncludes(prompt, '1.2 kg', 'the prompt (tab B specs)');

      // Without attribution the model is comparing two undifferentiated blobs.
      const attributed =
        /Halden Pro 14[^\n]{0,200}(product-a|tab)/i.test(prompt) ||
        /(tab|title|url)[^\n]{0,80}Halden Pro 14/i.test(prompt);
      check(attributed, 'tab content reached the model with no attribution to which tab it came from', {
        promptChars: prompt.length
      });

      check(/halden|corvid/i.test(answer), 'the answer named neither product', answer);
    }
  },

  {
    id: 'G07',
    name: 'tab-set-summary',
    group: 'B',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'Two laptops, a trail notice and an observatory article.' });
      }
      await open('/product-a.html');
      await open('/product-b.html');
      await open('/article.html');
      await open('/injection.html');
      await driver.openPanel();

      const { answer } = await driver.ask('What am I looking at across these tabs?');
      const prompt = ollama.requests.at(-1).promptText;

      const titles = [
        'Halden Pro 14',
        'Corvid Air 14',
        'Kestrel Ridge Observatory',
        'Carrow Valley trail conditions'
      ];
      const missing = titles.filter((t) => !prompt.includes(t));
      check(missing.length === 0, `${missing.length} of 4 open tabs never reached the model`, { missing });
      check(answer && answer.trim().length > 10, 'the answer was empty', answer);
    }
  }
];
