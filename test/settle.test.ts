import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/content/page-agent.ts';
import { withDom, type DomHandle } from './helpers/dom.ts';

let handle: DomHandle | null = null;
afterEach(() => {
  handle?.restore();
  handle = null;
});

const PAGE = '<html><head><title>Settle</title></head><body><main><p>Static content.</p></main></body></html>';

describe('settle', () => {
  test('returns quickly on a page that is not changing', async () => {
    handle = withDom(PAGE);
    const result = await settle(2000, 50);
    assert.equal(result.settled, true);
    assert.ok(result.waitedMs < 500, `should settle after one quiet interval, waited ${result.waitedMs}ms`);
  });

  test('keeps waiting while content is still arriving, then settles', async () => {
    handle = withDom(PAGE);
    const main = handle.document.querySelector('main')!;

    // Simulate a client-rendered page streaming in for ~400ms after load.
    const timer = setInterval(() => {
      const p = handle!.document.createElement('p');
      p.textContent = 'more';
      main.append(p);
    }, 20);
    setTimeout(() => clearInterval(timer), 400);

    const result = await settle(3000, 100);
    assert.equal(result.settled, true);
    assert.ok(result.waitedMs >= 400, `should not report settled mid-render, waited ${result.waitedMs}ms`);
    assert.ok(main.querySelectorAll('p').length > 10, 'the mutations should actually have landed');
  });

  test('gives up at the cap on a page that never stops changing', async () => {
    handle = withDom(PAGE);
    const main = handle.document.querySelector('main')!;
    const timer = setInterval(() => {
      main.append(handle!.document.createElement('span'));
    }, 20);

    try {
      const result = await settle(400, 100);
      assert.equal(result.settled, false, 'a perpetually busy page must not hang the agent');
      assert.ok(result.waitedMs >= 400 && result.waitedMs < 1500, `waited ${result.waitedMs}ms`);
    } finally {
      clearInterval(timer);
    }
  });

  test('ignores attribute-only churn such as a spinner toggling classes', async () => {
    handle = withDom(PAGE);
    const p = handle.document.querySelector('p')!;
    const timer = setInterval(() => {
      p.className = p.className === 'a' ? 'b' : 'a';
    }, 20);

    try {
      const result = await settle(2000, 100);
      assert.equal(result.settled, true, 'class toggling alone should not count as the page changing');
      assert.ok(result.waitedMs < 500, `waited ${result.waitedMs}ms`);
    } finally {
      clearInterval(timer);
    }
  });
});
