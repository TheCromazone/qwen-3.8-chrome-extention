import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OllamaClient,
  OllamaError,
  collectStream,
  normalizeBaseUrl,
  parseToolCallFromText,
  splitInlineThinking,
} from '../src/lib/ollama.ts';
import { agentTools } from '../src/lib/tools.ts';
import { startMockOllama } from './helpers/mock-ollama.ts';

describe('normalizeBaseUrl', () => {
  test('strips trailing slashes and whitespace', () => {
    assert.equal(normalizeBaseUrl('  http://localhost:11434///  '), 'http://localhost:11434');
  });
});

describe('splitInlineThinking', () => {
  test('separates <think> blocks from the answer', () => {
    const { content, thinking } = splitInlineThinking('<think>weigh it up</think>The answer is 42.');
    assert.equal(content, 'The answer is 42.');
    assert.equal(thinking, 'weigh it up');
  });

  test('treats an unterminated block as reasoning that got cut off', () => {
    const { content, thinking } = splitInlineThinking('Partial answer<think>still going');
    assert.equal(content, 'Partial answer');
    assert.equal(thinking, 'still going');
  });

  test('leaves plain content alone', () => {
    const { content, thinking } = splitInlineThinking('Just an answer.');
    assert.equal(content, 'Just an answer.');
    assert.equal(thinking, '');
  });
});

describe('parseToolCallFromText', () => {
  const tools = agentTools(false);

  test('reads a bare JSON object', () => {
    const call = parseToolCallFromText('{"tool":"click","arguments":{"ref":7}}', tools);
    assert.equal(call?.function.name, 'click');
    assert.deepEqual(call?.function.arguments, { ref: 7 });
  });

  test('reads JSON wrapped in prose and a markdown fence', () => {
    const text = 'Sure, here you go:\n```json\n{"name": "find_text", "args": {"text": "Sign in"}}\n```\nThat should do it.';
    const call = parseToolCallFromText(text, tools);
    assert.equal(call?.function.name, 'find_text');
    assert.deepEqual(call?.function.arguments, { text: 'Sign in' });
  });

  test('is not fooled by braces inside a string value', () => {
    const call = parseToolCallFromText('{"tool":"find_text","arguments":{"text":"a } brace"}}', tools);
    assert.equal(call?.function.name, 'find_text');
    assert.deepEqual(call?.function.arguments, { text: 'a } brace' });
  });

  test('ignores objects that name no known tool', () => {
    assert.equal(parseToolCallFromText('{"tool":"launch_missiles","arguments":{}}', tools), null);
  });

  test('returns null for prose with no JSON', () => {
    assert.equal(parseToolCallFromText('I think we should click the sign-in button.', tools), null);
  });
});

describe('OllamaClient against a mock server', () => {
  test('reports capabilities from /api/show', async () => {
    const mock = await startMockOllama({ capabilities: ['completion', 'tools', 'vision', 'thinking'] });
    try {
      const caps = await new OllamaClient(mock.url).capabilities('qwen3.8:27b');
      assert.equal(caps.vision, true);
      assert.equal(caps.tools, true);
      assert.equal(caps.thinking, true);
      assert.equal(caps.contextLength, 262144);
      assert.equal(caps.parameterSize, '27B');
    } finally {
      await mock.close();
    }
  });

  test('falls back to family hints when the server reports no capabilities', async () => {
    const mock = await startMockOllama({ capabilities: [] });
    try {
      const caps = await new OllamaClient(mock.url).capabilities('qwen3.8:27b');
      assert.equal(caps.vision, false, 'no projector and no vision family means no images');
      assert.deepEqual(caps.raw, []);
    } finally {
      await mock.close();
    }
  });

  test('assembles a streamed answer and surfaces thinking separately', async () => {
    const mock = await startMockOllama({
      script: [{ thinking: 'the page says 2019', content: 'It was founded in 2019.' }],
    });
    try {
      const client = new OllamaClient(mock.url);
      const tokens: string[] = [];
      const collected = await collectStream(
        client.chat({ model: 'qwen3.8:27b', messages: [{ role: 'user', content: 'when?' }] }),
        (token, kind) => {
          if (kind === 'content') tokens.push(token);
        },
      );

      assert.equal(collected.content, 'It was founded in 2019.');
      assert.equal(collected.thinking, 'the page says 2019');
      assert.equal(collected.doneReason, 'stop');
      assert.ok(tokens.length > 1, 'content should arrive as several tokens, not one blob');
      assert.equal(tokens.join(''), collected.content);
    } finally {
      await mock.close();
    }
  });

  test('passes num_ctx and keep_alive through to the server', async () => {
    const mock = await startMockOllama({ script: [{ content: 'ok' }] });
    try {
      await collectStream(
        new OllamaClient(mock.url).chat({
          model: 'qwen3.8:27b',
          messages: [{ role: 'user', content: 'hi' }],
          keep_alive: '30m',
          think: 'low',
          options: { num_ctx: 65536, temperature: 0.3 },
        }),
      );
      const [request] = mock.requests;
      assert.equal(request?.options?.num_ctx, 65536, 'Ollama silently caps context at 4096 without this');
      assert.equal(request?.keep_alive, '30m');
      assert.equal(request?.think, 'low');
    } finally {
      await mock.close();
    }
  });

  test('explains an unreachable server in terms of the two likely causes', async () => {
    const client = new OllamaClient('http://127.0.0.1:1');
    await assert.rejects(
      () => client.listModels(),
      (error: unknown) => {
        assert.ok(error instanceof OllamaError);
        assert.equal(error.kind, 'unreachable');
        assert.match(error.message, /OLLAMA_ORIGINS/);
        return true;
      },
    );
  });
});
