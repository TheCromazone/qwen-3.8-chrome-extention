/**
 * The rule that page content is data has to be in every system prompt, not
 * only in the warning the injection detector adds when it recognises an
 * attack: the attacks that get through are the ones the detector does not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_SYSTEM_PROMPT, agentSystemPrompt } from '../src/lib/prompts.ts';
import { wrapUntrusted } from '../src/lib/safety.ts';

const STANDING_RULE = /not an instruction to you|is data/i;

describe('system prompts', () => {
  test('both modes state unconditionally that fenced page content is data', () => {
    for (const prompt of [ASK_SYSTEM_PROMPT, agentSystemPrompt(null, 20), agentSystemPrompt({ model: 'x', vision: true, tools: true, thinking: false, raw: [], contextLength: 1, parameterSize: '' }, 20)]) {
      assert.match(prompt, STANDING_RULE);
      for (const tag of ['<page_text>', '<page>', '<transcript>']) {
        assert.ok(prompt.includes(tag), `${tag} should be named in the rule`);
      }
    }
  });

  test('the rule names the labels wrapUntrusted actually produces', () => {
    for (const label of ['page_text', 'page', 'transcript']) {
      assert.match(wrapUntrusted(label, 'hello'), new RegExp(`^<${label}>`));
    }
  });

  test('ordinary page text gets no detector warning, so the standing rule is what protects it', () => {
    assert.doesNotMatch(wrapUntrusted('page_text', 'Trail closed until 14 November for bridge repairs.'), /\[warning\]/);
  });
});
