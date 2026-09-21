/**
 * Minimal Ollama client: capability probe, streaming chat, and tool-call
 * extraction with a fallback for models Ollama does not report tool support for.
 */
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ModelCapabilities,
  ToolCall,
  ToolSchema,
} from './types.ts';

export class OllamaError extends Error {
  readonly kind: 'unreachable' | 'cors' | 'http' | 'protocol';
  constructor(kind: OllamaError['kind'], message: string) {
    super(message);
    this.name = 'OllamaError';
    this.kind = kind;
  }
}

/**
 * A failed fetch to a local Ollama is nearly always one of two things: the
 * server is not running, or it is running without OLLAMA_ORIGINS allowing this
 * extension. The browser does not tell us which, so say both.
 */
function wrapFetchFailure(baseUrl: string, cause: unknown): OllamaError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new OllamaError(
    'unreachable',
    `Could not reach Ollama at ${baseUrl} (${detail}). Check that Ollama is running, ` +
      `and that OLLAMA_ORIGINS includes chrome-extension://* so the browser allows the request.`,
  );
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export interface ListedModel {
  name: string;
  size: number;
  parameterSize: string | null;
}

export class OllamaClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private url(path: string): string {
    return `${normalizeBaseUrl(this.baseUrl)}${path}`;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw wrapFetchFailure(this.baseUrl, cause);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError('http', `Ollama returned ${res.status} for ${path}: ${text.slice(0, 400)}`);
    }
    return res;
  }

  /** Cheap reachability check used by the settings page. */
  async listModels(signal?: AbortSignal): Promise<ListedModel[]> {
    let res: Response;
    try {
      res = await fetch(this.url('/api/tags'), { signal });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw wrapFetchFailure(this.baseUrl, cause);
    }
    if (!res.ok) throw new OllamaError('http', `Ollama returned ${res.status} for /api/tags`);
    const body = (await res.json()) as { models?: Array<Record<string, any>> };
    return (body.models ?? []).map((m) => ({
      name: String(m.name ?? ''),
      size: Number(m.size ?? 0),
      parameterSize: m.details?.parameter_size ? String(m.details.parameter_size) : null,
    }));
  }

  /**
   * Asks Ollama what the model can do. `capabilities` is authoritative when the
   * server reports it; older servers omit it, and we fall back to reading the
   * families/projector hints that indicate a multimodal build.
   */
  async capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    const res = await this.post('/api/show', { model }, signal);
    const body = (await res.json()) as Record<string, any>;
    const raw: string[] = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];

    const families: string[] = Array.isArray(body.details?.families)
      ? body.details.families.map((f: unknown) => String(f).toLowerCase())
      : [];
    const hasProjector =
      Boolean(body.projector_info) || families.some((f) => f.includes('clip') || f.includes('vision'));

    const templateMentionsTools = typeof body.template === 'string' && /tool/i.test(body.template);

    return {
      model,
      vision: raw.length ? raw.includes('vision') : hasProjector,
      tools: raw.length ? raw.includes('tools') : templateMentionsTools,
      thinking: raw.includes('thinking'),
      raw,
      contextLength: readContextLength(body),
      parameterSize: body.details?.parameter_size ? String(body.details.parameter_size) : null,
    };
  }

  /**
   * Streams a chat completion. Yields each decoded chunk so callers can render
   * tokens as they arrive; the caller is responsible for assembling the final
   * message (see `collectStream`).
   */
  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
    const res = await this.post('/api/chat', { ...request, stream: true }, signal);
    if (!res.body) throw new OllamaError('protocol', 'Ollama response had no body to stream.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Ollama streams newline-delimited JSON; a chunk can split a line.
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          yield parseChunk(line);
        }
      }
      const tail = buffer.trim();
      if (tail) yield parseChunk(tail);
    } finally {
      reader.releaseLock();
    }
  }
}

function parseChunk(line: string): ChatChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new OllamaError('protocol', `Ollama sent a line that was not JSON: ${line.slice(0, 200)}`);
  }
  const chunk = parsed as ChatChunk & { error?: string };
  if (chunk.error) throw new OllamaError('http', `Ollama error: ${chunk.error}`);
  return chunk;
}

function readContextLength(body: Record<string, any>): number | null {
  const info = body.model_info as Record<string, unknown> | undefined;
  if (!info) return null;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value;
  }
  return null;
}

export interface CollectedMessage {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  doneReason: string | null;
}

/**
 * Drains a chat stream into a single message, invoking `onToken` as content
 * arrives so the UI can render progressively.
 */
export async function collectStream(
  stream: AsyncGenerator<ChatChunk>,
  onToken?: (token: string, kind: 'content' | 'thinking') => void,
): Promise<CollectedMessage> {
  let content = '';
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  let doneReason: string | null = null;

  for await (const chunk of stream) {
    const message = chunk.message;
    if (message?.content) {
      content += message.content;
      onToken?.(message.content, 'content');
    }
    if (message?.thinking) {
      thinking += message.thinking;
      onToken?.(message.thinking, 'thinking');
    }
    if (message?.tool_calls?.length) toolCalls.push(...message.tool_calls);
    if (chunk.done) doneReason = chunk.done_reason ?? 'stop';
  }

  return { content, thinking, toolCalls, doneReason };
}

/**
 * Some Qwen builds emit reasoning inline as <think>...</think> rather than in a
 * separate field. Split it out so it is never mistaken for the answer.
 */
export function splitInlineThinking(content: string): { content: string; thinking: string } {
  const matches = [...content.matchAll(/<think>([\s\S]*?)<\/think>/g)];
  if (!matches.length) {
    // An unterminated <think> means the stream was cut mid-reasoning.
    const open = content.indexOf('<think>');
    if (open !== -1) return { content: content.slice(0, open).trim(), thinking: content.slice(open + 7).trim() };
    return { content, thinking: '' };
  }
  const thinking = matches.map((m) => (m[1] ?? '').trim()).join('\n\n');
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { content: stripped, thinking };
}

/**
 * Fallback tool-call parsing for models Ollama does not expose native tool
 * support for. We ask such models to reply with a bare JSON object and pull the
 * first balanced object out of the response, tolerating markdown fences.
 */
export function parseToolCallFromText(text: string, known: ToolSchema[]): ToolCall | null {
  const names = new Set(known.map((t) => t.function.name));
  for (const candidate of extractJsonObjects(text)) {
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const name = parsed?.tool ?? parsed?.name ?? parsed?.action ?? parsed?.function?.name;
    if (typeof name !== 'string' || !names.has(name)) continue;
    const args =
      parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.input ?? parsed.function?.arguments ?? {};
    return {
      function: {
        name,
        arguments: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
      },
    };
  }
  return null;
}

/** Yields balanced top-level {...} spans, skipping braces inside JSON strings. */
function* extractJsonObjects(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        yield text.slice(start, i + 1);
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
}
