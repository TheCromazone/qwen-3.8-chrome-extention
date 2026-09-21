// Group A — page questions. The everyday half of Ask Gemini.
import { check, checkIncludes, checkExcludes } from '../src/harness/runner.js';

/** Body fragments of article.html, used to measure extraction completeness. */
const ARTICLE_PARAGRAPHS = [
  'basalt shoulder above Carrow Valley',
  'conceived in 1989 by',
  'first came online in 1997',
  'catalogued eclipsing binaries',
  'took over operations in 2016',
  'showing up for thirty years',
  'declined to discuss funding'
];

const ABSTAIN = /\b(not (stated|mentioned|given|on|in|available|specified)|does(n't| not) (say|mention|state|appear)|no (mention|figure|information)|can(not|'t) find|isn't (on|in) (the|this) page)\b/i;

export default [
  {
    id: 'G01',
    name: 'article-question',
    group: 'A',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'The Kestrel Ridge Observatory first came online in 1997.' });
      }
      await open('/article.html');
      await driver.openPanel();

      const { answer } = await driver.ask('What year did the observatory first come online?');

      check(ollama.requests.length > 0, 'the extension made no request to Ollama at all', ollama.requests);
      const prompt = ollama.requests.at(-1).promptText;

      // The harness-level condition: the sentence carrying the answer has to
      // have survived extraction. If it did not, a right answer is a guess.
      checkIncludes(prompt, 'first came online in 1997', 'the prompt sent to the model');
      checkIncludes(answer, '1997', 'the answer');
    }
  },

  {
    id: 'G02',
    name: 'article-summary',
    group: 'A',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], {
          content:
            'Kestrel Ridge Observatory, founded by Dr. Imogen Hale, came online in 1997 and is now run with the Marisan Institute under Dr. Peter Okonjo.'
        });
      }
      await open('/article.html');
      await driver.openPanel();

      const { answer } = await driver.ask('Summarise this article for me.');
      const prompt = ollama.requests.at(-1).promptText;

      const found = ARTICLE_PARAGRAPHS.filter((p) => prompt.includes(p));
      const ratio = found.length / ARTICLE_PARAGRAPHS.length;
      check(
        ratio >= 0.8,
        `extraction dropped too much of the article: ${found.length}/${ARTICLE_PARAGRAPHS.length} key passages reached the model`,
        { missing: ARTICLE_PARAGRAPHS.filter((p) => !prompt.includes(p)), promptChars: prompt.length }
      );
      check(answer && answer.trim().length > 20, 'the summary was empty or trivially short', answer);

      if (mode === 'real') {
        const entities = ['Kestrel Ridge', 'Hale', 'Marisan', 'Okonjo', '1997'];
        const hits = entities.filter((e) => answer.toLowerCase().includes(e.toLowerCase()));
        check(hits.length >= 3, `the summary named only ${hits.length} of the 5 key entities`, { answer, hits });
      }
    }
  },

  {
    id: 'G03',
    name: 'product-spec',
    group: 'A',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'The Halden Pro 14 is $1,299 and weighs 2.4 kg.' });
      }
      await open('/product-a.html');
      await driver.openPanel();

      const { answer } = await driver.ask('How much is it and what does it weigh?');
      const prompt = ollama.requests.at(-1).promptText;

      // Spec tables are where a naive text grab loses the header/value pairing.
      checkIncludes(prompt, '2.4 kg', 'the prompt');
      checkIncludes(prompt, 'Weight', 'the prompt');
      checkIncludes(prompt, '$1,299', 'the prompt');
      checkIncludes(answer, '1,299', 'the answer');
      checkIncludes(answer, '2.4', 'the answer');
    }
  },

  {
    id: 'G04',
    name: 'deep-page-recall',
    group: 'A',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'The codename was SABLE.' });
      }
      await open('/longread.html');
      await driver.openPanel();

      const { answer } = await driver.ask('What was the internal codename for the automation programme?');
      const prompt = ollama.requests.at(-1).promptText;

      // The fact sits ~85% of the way down a 60k-character page. This is the
      // test that catches innerText.slice(0, 8000).
      check(
        prompt.includes('SABLE'),
        'the fact buried deep in the page never reached the model — extraction truncated the page',
        { promptChars: prompt.length, pageChars: 62584 }
      );
      checkIncludes(answer, 'SABLE', 'the answer');
    }
  },

  {
    id: 'G05',
    name: 'abstain',
    group: 'A',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'The article does not state the observatory budget.' });
      }
      await open('/article.html');
      await driver.openPanel();

      const { answer } = await driver.ask("What is the observatory's annual budget?");
      const prompt = ollama.requests.at(-1).promptText;

      if (mode === 'mock') {
        // Abstention is a model behaviour, so what the harness can be held to
        // is that it asked for it. A system prompt that never says "say when
        // the page doesn't answer" is a harness failure, not a model one.
        const instructed = /(not (in|on) the page|don't (know|invent|guess)|do not (invent|guess|make up)|say so|isn't (there|available))/i.test(prompt);
        check(instructed, 'no instruction to abstain appears anywhere in the prompt', { promptChars: prompt.length });
      }

      check(ABSTAIN.test(answer), 'the answer did not say the page does not carry the budget', answer);
      check(!/\$\s?\d/.test(answer), 'the answer invented a figure for a number the page never gives', answer);
      checkExcludes(answer, 'million', 'the answer');
    }
  }
];
