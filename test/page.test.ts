import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractReadableText, findMainContent, trimToBudget } from '../src/content/extract.ts';
import { accessibleName, formatElements, indexInteractiveElements } from '../src/content/elements.ts';
import { withDom, type DomHandle } from './helpers/dom.ts';
import { present } from './helpers/present.ts';

let handle: DomHandle | null = null;
afterEach(() => {
  handle?.restore();
  handle = null;
});

const ARTICLE = `
<html><head><title>Founding story</title></head><body>
  <nav><a href="/a">Home</a><a href="/b">Pricing</a><a href="/c">Careers</a></nav>
  <header><h1>Site chrome heading</h1></header>
  <main>
    <h1>How the company started</h1>
    <p>The company was founded in 2019 by two engineers.</p>
    <p>It reached profitability in 2023 after a slow first year.</p>
    <ul><li>Offices in Lisbon</li><li>Forty people</li></ul>
    <h2>What changed</h2>
    <p>The second product line arrived in 2024.</p>
  </main>
  <footer><p>Copyright notice that nobody wants in the context window.</p></footer>
  <script>const noise = "should never be extracted";</script>
  <style>.x { color: red }</style>
</body></html>`;

describe('extractReadableText', () => {
  test('keeps the article and drops chrome, scripts and styles', () => {
    handle = withDom(ARTICLE);
    const text = extractReadableText(handle.document);

    assert.match(text, /founded in 2019/);
    assert.match(text, /second product line arrived in 2024/);
    assert.doesNotMatch(text, /should never be extracted/);
    assert.doesNotMatch(text, /color: red/);
    assert.doesNotMatch(text, /Copyright notice/);
    assert.doesNotMatch(text, /Site chrome heading/);
  });

  test('preserves heading levels and list markers', () => {
    handle = withDom(ARTICLE);
    const text = extractReadableText(handle.document);

    assert.match(text, /^# How the company started$/m);
    assert.match(text, /^## What changed$/m);
    assert.match(text, /^- Offices in Lisbon$/m);
  });

  test('does not run paragraphs together', () => {
    handle = withDom(ARTICLE);
    const text = extractReadableText(handle.document);
    assert.doesNotMatch(text, /engineers\.It reached/, 'block elements must break the line');
  });

  test('skips elements hidden with inline styles', () => {
    handle = withDom(`<html><body><main><p>Visible text here to pass the length check.</p>
      <p style="display:none">Hidden away</p>
      <p aria-hidden="true">Also hidden</p></main></body></html>`);
    const text = extractReadableText(handle.document);
    assert.match(text, /Visible text here/);
    assert.doesNotMatch(text, /Hidden away/);
    assert.doesNotMatch(text, /Also hidden/);
  });

  test('falls back to the densest container when there is no <main>', () => {
    const body = `<html><body>
      <div id="sidebar"><a href="/1">one</a><a href="/2">two</a></div>
      <div id="story">${'Real prose about the subject at hand. '.repeat(20)}</div>
    </body></html>`;
    handle = withDom(body);
    assert.equal(findMainContent(handle.document).id, 'story');
  });
});

describe('trimToBudget', () => {
  test('leaves short text untouched', () => {
    const { text, truncated } = trimToBudget('short', 100);
    assert.equal(text, 'short');
    assert.equal(truncated, false);
  });

  test('keeps the ending, where conclusions live', () => {
    const body = `${'a'.repeat(5000)}\nTHE CONCLUSION IS HERE`;
    const { text, truncated } = trimToBudget(body, 1000);
    assert.equal(truncated, true);
    assert.match(text, /THE CONCLUSION IS HERE$/);
    assert.match(text, /characters of page text omitted/);
  });
});

describe('indexInteractiveElements', () => {
  const FORM = `<html><body><main>
    <p>${'Padding text to make this the main content. '.repeat(10)}</p>
    <label for="q">Search the catalogue</label>
    <input id="q" type="text" value="boots" />
    <input id="pw" type="password" value="hunter2" aria-label="Password" />
    <button aria-label="Run the search">Go</button>
    <a href="/help">Help centre</a>
    <select aria-label="Sort by"><option value="new">Newest</option></select>
    <button disabled>Unavailable</button>
    <input type="hidden" value="csrf" />
  </main></body></html>`;

  test('numbers every interactive control and skips hidden inputs', () => {
    handle = withDom(FORM);
    const elements = indexInteractiveElements(handle.document);
    const names = elements.map((el) => el.name);

    assert.deepEqual(
      elements.map((el) => el.ref),
      elements.map((_, i) => i + 1),
      'refs should be 1-based and contiguous',
    );
    assert.ok(names.includes('Search the catalogue'));
    assert.ok(names.includes('Run the search'));
    assert.ok(names.includes('Help centre'));
    assert.ok(!names.includes('csrf'), 'hidden inputs are not actionable');
  });

  test('never surfaces the contents of a password field', () => {
    handle = withDom(FORM);
    const elements = indexInteractiveElements(handle.document);
    const password = present(elements.find((el) => el.name === 'Password'), 'the password field');
    assert.equal(password.value, undefined);
    assert.doesNotMatch(formatElements(elements), /hunter2/);
  });

  test('marks disabled controls so the model does not waste a step', () => {
    handle = withDom(FORM);
    const elements = indexInteractiveElements(handle.document);
    assert.equal(elements.find((el) => el.name === 'Unavailable')?.disabled, true);
    assert.match(formatElements(elements), /"Unavailable" \[[^\]]*disabled/);
  });

  test('renders a listing the model can address by number', () => {
    handle = withDom(FORM);
    const listing = formatElements(indexInteractiveElements(handle.document));
    // jsdom gives every element a zero-size rect, so they all read as offscreen here.
    assert.match(listing, /^\[\d+\] textbox "Search the catalogue" \[[^\]]*value="boots"\]$/m);
    assert.match(listing, /^\[\d+\] link "Help centre"/m);
  });
});

describe('accessibleName', () => {
  test('prefers aria-label over inner text', () => {
    handle = withDom('<html><body><button aria-label="Close dialog">x</button></body></html>');
    assert.equal(accessibleName(present(handle.document.querySelector('button'), 'the button')), 'Close dialog');
  });

  test('resolves aria-labelledby', () => {
    handle = withDom('<html><body><span id="lbl">Delete account</span><button aria-labelledby="lbl"></button></body></html>');
    assert.equal(accessibleName(present(handle.document.querySelector('button'), 'the button')), 'Delete account');
  });

  test('falls back to a placeholder for an unlabelled input', () => {
    handle = withDom('<html><body><input placeholder="Email address" /></body></html>');
    assert.equal(accessibleName(present(handle.document.querySelector('input'), 'the input')), 'Email address');
  });
});
