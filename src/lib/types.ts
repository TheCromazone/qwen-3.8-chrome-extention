/** Shared types for the Ollama wire format, agent state and extension messaging. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  /** Base64 image data (no data: prefix), only sent to models with the vision capability. */
  images?: string[];
  /** Tool calls the model asked for. Present on assistant messages. */
  tool_calls?: ToolCall[];
  /** Names the tool a `role: 'tool'` message is answering. */
  tool_name?: string;
  /** Reasoning text some Qwen builds emit separately from content. */
  thinking?: string;
}

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required?: string[];
    };
  };
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  stream?: boolean;
  /**
   * Reasoning control. Ollama accepts a boolean, and newer builds accept an
   * effort level. Qwen3.8 ships at the highest effort and overthinks routine
   * steps badly, so we always send this explicitly rather than taking the default.
   */
  think?: boolean | ReasoningEffort;
  /** How long Ollama keeps the model resident. It unloads after 5m by default. */
  keep_alive?: string;
  /**
   * A JSON schema Ollama constrains the reply to. Used for models without
   * native tool calling: a grammar that cannot express an invalid action keeps
   * a local model on the rails far better than asking it nicely.
   */
  format?: Record<string, unknown> | 'json';
  options?: {
    temperature?: number;
    num_ctx?: number;
    num_predict?: number;
    top_p?: number;
  };
}

export interface ChatChunk {
  model: string;
  created_at: string;
  message?: ChatMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * What a given model tag can actually do. Ollama reports this from /api/show;
 * everything downstream (screenshots, tool calling, thinking) keys off it rather
 * than off a hardcoded model name.
 */
export interface ModelCapabilities {
  model: string;
  vision: boolean;
  tools: boolean;
  thinking: boolean;
  /** Raw capability strings as reported, for display in settings. */
  raw: string[];
  contextLength: number | null;
  parameterSize: string | null;
}

/** A page snapshot handed to the model as context. */
export interface PageContext {
  url: string;
  title: string;
  /** Main readable text, already trimmed to the configured budget. */
  text: string;
  /** The user's current selection, if any. */
  selection: string | null;
  /** Video transcript when the page is a supported video page. */
  transcript: TranscriptCue[] | null;
  /** True when `text` was cut short by the character budget. */
  truncated: boolean;
  /** Characters of extracted text before truncation. */
  originalLength: number;
}

export interface TranscriptCue {
  /** Seconds from the start of the video. */
  start: number;
  duration: number;
  text: string;
}

/** An interactive element the agent can act on, addressed by its `ref`. */
export interface InteractiveElement {
  ref: number;
  tag: string;
  role: string;
  name: string;
  value?: string;
  /** Viewport-relative centre point, used for debugger-based input. */
  center: { x: number; y: number };
  inViewport: boolean;
  disabled: boolean;
}

/** What the content script reports back after each agent action. */
export interface Observation {
  url: string;
  title: string;
  elements: InteractiveElement[];
  text: string;
  /** Scroll position as a 0-1 fraction of scrollable height. */
  scrollProgress: number;
  notice?: string;
}

export type AgentStepKind =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'message'
  | 'error'
  | 'done'
  | 'stopped';

export interface AgentStep {
  kind: AgentStepKind;
  /** Zero for pre-loop events, then 1-based iteration number. */
  iteration: number;
  text: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  at: number;
}

export type RunMode = 'ask' | 'agent';

export interface Settings {
  ollamaUrl: string;
  model: string;
  temperature: number;
  /**
   * Ollama caps context at 2048-4096 regardless of what the model supports, so
   * this is always sent. Qwen3.8's native window is much larger; the practical
   * ceiling is VRAM, not the model.
   */
  numCtx: number;
  /** Reasoning effort. Only sent to models that report the thinking capability. */
  reasoningEffort: ReasoningEffort;
  /** Ollama's keep_alive, so the model is not unloaded between questions. */
  keepAlive: string;
  /** Hard ceiling on agent loop iterations, so a runaway task still terminates. */
  maxSteps: number;
  /** Characters of page text sent as context. */
  pageCharBudget: number;
  /** Send screenshots to the model. Only honoured when the model reports vision. */
  useScreenshots: boolean;
  /** Ask the model to emit reasoning. Only honoured when the model reports thinking. */
  useThinking: boolean;
  /** Pause for confirmation before consequential actions. See lib/safety.ts. */
  confirmRiskyActions: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://localhost:11434',
  model: 'qwen3.8:27b',
  temperature: 0.3,
  numCtx: 65536,
  reasoningEffort: 'low',
  keepAlive: '30m',
  maxSteps: 30,
  pageCharBudget: 24000,
  useScreenshots: true,
  useThinking: false,
  confirmRiskyActions: true,
};
