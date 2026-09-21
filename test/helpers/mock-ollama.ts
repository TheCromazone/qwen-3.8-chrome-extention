/**
 * A stand-in Ollama server. The real one runs on Matthew's machine and is not
 * reachable from here, so the client and the agent loop are exercised against
 * this instead: same endpoints, same newline-delimited streaming format.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { ChatRequest, ToolCall } from '../../src/lib/types.ts';

export interface ScriptedTurn {
  /** Text the model "says" for this turn. */
  content?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
}

export interface MockOllamaOptions {
  capabilities?: string[];
  models?: string[];
  contextLength?: number;
  /** One entry per expected /api/chat call, in order. */
  script?: ScriptedTurn[];
}

export interface MockOllama {
  url: string;
  /** Every /api/chat body received, in order. */
  requests: ChatRequest[];
  close: () => Promise<void>;
}

export async function startMockOllama(options: MockOllamaOptions = {}): Promise<MockOllama> {
  const capabilities = options.capabilities ?? ['completion', 'tools', 'vision', 'thinking'];
  const models = options.models ?? ['qwen3.8:27b'];
  const script = [...(options.script ?? [])];
  const requests: ChatRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

      if (req.url === '/api/tags') {
        return json(res, {
          models: models.map((name) => ({ name, size: 1, details: { parameter_size: '27B' } })),
        });
      }

      if (req.url === '/api/show') {
        return json(res, {
          capabilities,
          details: { parameter_size: '27B', families: ['qwen3'] },
          model_info: { 'qwen3.context_length': options.contextLength ?? 262144 },
        });
      }

      if (req.url === '/api/chat') {
        requests.push(body as ChatRequest);
        return streamChat(res, script.shift() ?? { content: 'No scripted turn left.' });
      }

      res.writeHead(404).end();
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('mock server did not bind a port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function streamChat(res: ServerResponse, turn: ScriptedTurn): void {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

  const write = (message: Record<string, unknown>) => {
    res.write(`${JSON.stringify({ model: 'qwen3.8:27b', created_at: new Date().toISOString(), message, done: false })}\n`);
  };

  for (const piece of pieces(turn.thinking)) write({ role: 'assistant', content: '', thinking: piece });
  for (const piece of pieces(turn.content)) write({ role: 'assistant', content: piece });
  if (turn.toolCalls?.length) write({ role: 'assistant', content: '', tool_calls: turn.toolCalls });

  res.end(
    `${JSON.stringify({
      model: 'qwen3.8:27b',
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
    })}\n`,
  );
}

/** Splits text the way a real token stream would: many small pieces. */
function pieces(text: string | undefined): string[] {
  if (!text) return [];
  return text.match(/\S+\s*/g) ?? [text];
}
