// Group C — YouTube. Transcript questions and quiz answering.
//
// The fixture puts the transcript in a collapsed ytd-transcript-renderer, the
// way a watch page does. A generic innerText grab picks up the description and
// the sidebar and misses the transcript entirely, which is exactly the failure
// these tasks are here to catch.
import { check, checkIncludes } from '../src/harness/runner.js';

const QUIZ_KEY = [
  { q: 'What is the press rated at?', accept: [/twenty tonnes/i, /20\s*tonnes?/i] },
  { q: 'Where did the ram come from?', accept: [/forklift/i] },
  { q: 'What did the total build cost?', accept: [/420/, /four hundred and twenty/i] }
];

export default [
  {
    id: 'G08',
    name: 'youtube-transcript-question',
    group: 'C',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'He builds a hydraulic press from scrap, rated at twenty tonnes.' });
      }
      await open('/watch?v=carrow1', { host: 'www.youtube.com' });
      await driver.openPanel();

      const { answer } = await driver.ask('What is he building in this video, and what is it rated at?');
      const prompt = ollama.requests.at(-1).promptText;

      // Lines that exist only inside the transcript panel.
      // Neither line is in the page DOM — both exist only in the caption
      // track, so seeing them means the adapter actually ran.
      checkIncludes(prompt, 'off a scrapped gantry crane', 'the prompt (transcript body)');
      checkIncludes(prompt, 'borrowed from the university', 'the prompt (transcript body)');
      check(
        !/^\s*$/.test(prompt) && prompt.includes('hydraulic press'),
        'the transcript never reached the model — only the description and sidebar did',
        { promptChars: prompt.length }
      );
      checkIncludes(answer, 'hydraulic press', 'the answer');
    }
  },

  {
    id: 'G09',
    name: 'youtube-quiz',
    group: 'C',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], {
          content: '1. Twenty tonnes.\n2. Off a forklift mast.\n3. Four hundred and twenty pounds.'
        });
      }
      await open('/watch?v=carrow1', { host: 'www.youtube.com' });
      await driver.openPanel();

      const question =
        'Answer these three questions about the video:\n' + QUIZ_KEY.map((k, i) => `${i + 1}. ${k.q}`).join('\n');
      const before = ollama.requests.length;
      const { answer } = await driver.ask(question);
      const used = ollama.requests.length - before;

      // One request, not three: the transcript is the expensive part of the
      // prompt and re-sending it per question is what makes this slow locally.
      check(used === 1, `answering three questions took ${used} requests to the model, not 1`, { used });
      checkIncludes(ollama.requests.at(-1).promptText, 'forklift mast', 'the prompt (transcript body)');

      const numbered = (answer.match(/^\s*\d[\.\)]/gm) ?? []).length;
      check(numbered >= 3, `only ${numbered} of 3 answers came back`, answer);

      if (mode === 'real') {
        const correct = QUIZ_KEY.filter((k) => k.accept.some((re) => re.test(answer))).length;
        check(correct >= 2, `only ${correct} of 3 quiz answers were right`, { answer, correct });
      }
    }
  },

  {
    id: 'G10',
    name: 'youtube-timestamp',
    group: 'C',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'He gets to calibration at 4:10.' });
      }
      await open('/watch?v=carrow1', { host: 'www.youtube.com' });
      await driver.openPanel();

      const { answer } = await driver.ask('When does he talk about calibration?');
      const prompt = ollama.requests.at(-1).promptText;

      // Timestamps have to survive into the prompt or no answer can be right.
      check(/\b4:10\b/.test(prompt), 'transcript timestamps were stripped before the model saw them', {
        promptChars: prompt.length
      });

      const stamps = [...answer.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
      check(stamps.length > 0, 'the answer carried no timestamp at all', answer);
      const target = 4 * 60 + 10;
      const closest = stamps.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
      check(Math.abs(closest - target) <= 20, `nearest timestamp given was ${closest}s, target ${target}s (±20s)`, answer);
    }
  }
];
