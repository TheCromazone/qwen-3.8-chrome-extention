// Group D — agentic tasks. The half Ask Gemini mostly cannot do, and the
// half that decides whether this is worth building.
import { check, checkIncludes } from '../src/harness/runner.js';

const shopScope = (fixtures) => ({ allowOrigins: [fixtures.origin] });

/** The mock plays the model: it is told what to click, and finds the ref itself. */
const FIND_LAMP = [
  { when: 'Departments', act: { type: 'click', find: 'Lighting' } },
  { when: 'Meridian desk lamp', act: { type: 'click', find: 'Meridian desk lamp' } },
  { when: '\\$89', act: { type: 'answer', text: 'The Meridian desk lamp is $89.' } }
];

export default [
  {
    id: 'G11',
    name: 'click-to-find',
    group: 'D',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, fixtures, browser, mode }) {
      if (mode === 'mock') ollama.setScript(FIND_LAMP);

      await open('/shop/index.html');
      await driver.openPanel();

      const result = await driver.runTask('Find the price of the Meridian desk lamp.', shopScope(fixtures));
      const journal = result.journal ?? (await driver.journal());

      const clicks = journal.filter((s) => s.action === 'click');
      check(clicks.length >= 2, `the agent made ${clicks.length} clicks; the lamp is two clicks deep`, journal);
      check(
        clicks.every((c) => c.ref),
        'a click was issued without a ref into the snapshot — actions must reference the snapshot, not coordinates',
        clicks
      );

      const reachedItem = browser.navigations.some((n) => n.url.includes('/shop/item-lamp.html'));
      check(reachedItem, 'the agent never reached the item page', browser.navigations.map((n) => n.url));

      checkIncludes(result.answer, '89', 'the answer');
    }
  },

  {
    id: 'G12',
    name: 'search-and-read',
    group: 'D',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, fixtures, browser, mode }) {
      if (mode === 'mock') {
        ollama.setScript([
          { act: { type: 'type', find: 'Search the shop', value: 'kettle' } },
          { act: { type: 'click', find: 'Search' } },
          { when: 'Orbit kettle', act: { type: 'answer', text: 'The top result is the Orbit kettle at $54.' } }
        ]);
      }

      await open('/shop/index.html');
      await driver.openPanel();

      const result = await driver.runTask("Search the shop for 'kettle' and tell me the top result.", shopScope(fixtures));
      const journal = result.journal ?? (await driver.journal());

      const typeIdx = journal.findIndex((s) => s.action === 'type');
      check(typeIdx !== -1, 'the agent never typed into the search field', journal);
      check(
        journal.slice(typeIdx + 1).some((s) => s.action === 'click' || s.action === 'submit'),
        'the agent typed a query but never submitted it',
        journal
      );

      const searched = browser.navigations.some((n) => n.url.includes('q=kettle'));
      check(searched, 'no navigation carried the search query', browser.navigations.map((n) => n.url));
      checkIncludes(result.answer, 'Orbit kettle', 'the answer');
    }
  },

  {
    id: 'G13',
    name: 'multi-step-journal',
    group: 'D',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, fixtures, mode }) {
      if (mode === 'mock') {
        ollama.setScript([
          { when: 'Departments', act: { type: 'click', find: 'Kitchen' } },
          { when: 'Orbit kettle', act: { type: 'click', find: 'Orbit kettle' } },
          { when: '\\$54', act: { type: 'click', find: 'Back' } },
          { when: 'Stanwell frying pan', act: { type: 'click', find: 'Stanwell frying pan' } },
          { when: '\\$38', act: { type: 'answer', text: 'The kettle is $54 and the pan is $38, so $92 together.' } }
        ]);
      }

      await open('/shop/index.html');
      await driver.openPanel();

      const result = await driver.runTask(
        'In the Kitchen department, find the price of the Orbit kettle and the Stanwell frying pan and add them up.',
        shopScope(fixtures)
      );
      const journal = result.journal ?? (await driver.journal());

      check(journal.length >= 5, `the journal recorded ${journal.length} steps, expected at least 5`, journal);

      const ordered = journal.every((s, i) => (i === 0 ? true : s.n > journal[i - 1].n));
      check(ordered, 'journal steps are not in order', journal.map((s) => s.n));

      const acting = journal.filter((s) => s.action !== 'answer');
      const incomplete = acting.filter((s) => !s.action || s.observation == null);
      check(
        incomplete.length === 0,
        `${incomplete.length} journal steps lack an action or an observation, so the run cannot be replayed`,
        incomplete
      );

      // Persistence: a journal that dies with the panel cannot resume a task
      // that outlives it. Full mid-task resumption is scripted separately in
      // real mode (G23); what is asserted here is that the record survives.
      await driver.closePanel();
      await driver.openPanel();
      const afterReopen = await driver.journal();
      check(
        afterReopen.length >= journal.length,
        `the journal was lost when the panel closed: ${journal.length} steps before, ${afterReopen.length} after`,
        { before: journal.length, after: afterReopen.length }
      );
    }
  },

  {
    id: 'G14',
    name: 'screen-read',
    group: 'D',
    modes: ['mock', 'real'],
    async run({ driver, open, ollama, fixtures, mode }) {
      if (mode === 'mock') {
        ollama.setScript([
          { act: { type: 'screenshot' } },
          { act: { type: 'answer', text: 'Average utilisation is 41.8 percent.' } }
        ]);
      }

      await open('/canvas-dashboard.html');
      await driver.openPanel();

      const result = await driver.runTask('What is the average utilisation on this dashboard?', {
        allowOrigins: [fixtures.origin]
      });

      // The number is painted into a canvas. It is in no DOM node and no
      // accessibility node, so the only way to it is the top rung of the
      // perception ladder.
      const withImage = ollama.requests.filter((r) => r.hasImage);
      check(
        withImage.length > 0,
        'no request carried an image — the perception ladder never reached the screenshot rung, so the value was unreachable',
        { requests: ollama.requests.length }
      );
      checkIncludes(result.answer, '41.8', 'the answer');
    }
  },

  {
    id: 'G15',
    name: 'perception-ladder-efficiency',
    group: 'D',
    modes: ['mock'],
    async run({ driver, open, ollama, fixtures }) {
      ollama.setScript(FIND_LAMP);
      await open('/shop/index.html');
      await driver.openPanel();

      await driver.runTask('Find the price of the Meridian desk lamp.', shopScope(fixtures));

      // Screenshotting a page the DOM already describes is what makes a local
      // agent unusable: an image costs more tokens than the whole snapshot and
      // the model reads it worse. Spending one here is a failure, not a taste.
      const wasteful = ollama.requests.filter((r) => r.hasImage);
      check(
        wasteful.length === 0,
        `${wasteful.length} of ${ollama.requests.length} requests sent a screenshot for a task the DOM fully answers`,
        { imageRequests: wasteful.length, total: ollama.requests.length }
      );
    }
  }
];
