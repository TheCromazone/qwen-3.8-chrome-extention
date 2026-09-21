// Group E — Chrome-connected apps. Google Docs is the interesting case:
// it paints into positioned spans and has no readable innerText, which is why
// the perception ladder needs a site-adapter rung under the generic extractor.
import { checkIncludes, check } from '../src/harness/runner.js';

export default [
  {
    id: 'G16',
    name: 'drive-doc-question',
    group: 'E',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, mode }) {
      if (mode === 'mock') {
        ollama.setScript([], { content: 'Phase one covers 14 regional sites.' });
      }
      await open('/drive/doc.html');
      await driver.openPanel();

      const { answer } = await driver.ask('How many sites does phase one cover?');
      const prompt = ollama.requests.at(-1).promptText;

      check(
        prompt.includes('Phase one covers 14 regional sites'),
        'the document body never reached the model — the generic extractor does not see a Docs editor surface, so this needs a site adapter',
        { promptChars: prompt.length }
      );
      checkIncludes(answer, '14', 'the answer');
    }
  }
];
