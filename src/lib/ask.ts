/**
 * Page-question mode: one streaming chat call with the readable page text.
 * No loop, no screenshots — this is the everyday path and it should feel instant.
 */
import { OllamaClient, collectStream, splitInlineThinking } from './ollama.ts';
import { ASK_SYSTEM_PROMPT, renderPageContext } from './prompts.ts';
import { wrapUntrusted } from './safety.ts';
import { readPage } from './tab-driver.ts';
import type { ChatMessage, ModelCapabilities, PageContext, Settings } from './types.ts';

export interface AskOptions {
  question: string;
  tabId: number;
  settings: Settings;
  capabilities: ModelCapabilities | null;
  /** Earlier turns in this conversation, oldest first. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal: AbortSignal;
}

export interface AskResult {
  answer: string;
  thinking: string;
  context: PageContext;
}

export async function askAboutPage(
  options: AskOptions,
  onToken?: (token: string, kind: 'content' | 'thinking') => void,
): Promise<AskResult> {
  const { settings, capabilities, signal } = options;

  const context = await readPage(options.tabId, settings.pageCharBudget, true);
  const client = new OllamaClient(settings.ollamaUrl);

  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM_PROMPT },
    // The page is attached once, ahead of the conversation, so follow-up
    // questions reuse the same snapshot instead of re-reading on every turn.
    { role: 'user', content: wrapUntrusted('page', renderPageContext(context)) },
    { role: 'assistant', content: 'I have read the page. What would you like to know about it?' },
    ...options.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: options.question },
  ];

  const stream = client.chat(
    {
      model: settings.model,
      messages,
      ...(capabilities?.thinking ? { think: settings.reasoningEffort } : {}),
      keep_alive: settings.keepAlive,
      options: { temperature: settings.temperature, num_ctx: settings.numCtx },
    },
    signal,
  );

  const collected = await collectStream(stream, onToken);
  const { content, thinking } = splitInlineThinking(collected.content);

  return { answer: content.trim(), thinking: (collected.thinking || thinking).trim(), context };
}
