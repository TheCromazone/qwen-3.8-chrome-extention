/**
 * Page-question mode: one streaming chat call with the readable page text.
 * No loop, no screenshots — this is the everyday path and it should feel instant.
 *
 * When the question is about the user's tabs rather than this page, every
 * readable tab in the window is read and attributed, because comparing open
 * tabs is most of what people use a browser assistant for.
 */
import { OllamaClient, collectStream, splitInlineThinking } from './ollama.ts';
import { ASK_SYSTEM_PROMPT, renderPageContext } from './prompts.ts';
import { isBlockedUrl, wrapUntrusted } from './safety.ts';
import { resolvePageBudget } from './settings.ts';
import { listTabs, readPage } from './tab-driver.ts';
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
  /** The current tab's snapshot. */
  context: PageContext;
  /** How many tabs' contents went to the model. */
  tabsRead: number;
}

/** Reading every tab costs a content-script round trip each; cap it. */
const MAX_TABS = 6;

/** Whether a question is about the set of open tabs rather than this one page. */
export function mentionsTabs(question: string): boolean {
  return /\b(tabs?|open pages?|other (page|window)s?|across (my )?(pages|windows))\b/i.test(question);
}

export async function askAboutPage(
  options: AskOptions,
  onToken?: (token: string, kind: 'content' | 'thinking') => void,
): Promise<AskResult> {
  const { settings, capabilities, signal, tabId } = options;
  const budget = resolvePageBudget(settings);

  const open = await listTabs().catch(() => [] as chrome.tabs.Tab[]);
  const readable = open.filter(
    (tab) => tab.id !== undefined && typeof tab.url === 'string' && /^https?:/i.test(tab.url) && !isBlockedUrl(tab.url),
  );
  const others = readable.filter((tab) => tab.id !== tabId).slice(0, MAX_TABS - 1);
  const readAll = mentionsTabs(options.question) && others.length > 0;
  const perTab = readAll ? Math.floor(budget / (others.length + 1)) : budget;

  const context = await readPage(tabId, perTab, true);
  const currentIndex = Math.max(0, open.findIndex((tab) => tab.id === tabId));

  const blocks = [wrapUntrusted('page', `Tab ${currentIndex + 1} (current)\n${renderPageContext(context)}`)];

  if (readAll) {
    const rest = await Promise.all(
      others.map(async (tab) => {
        const snapshot = await readPage(tab.id!, perTab, false).catch(() => null);
        const index = open.findIndex((t) => t.id === tab.id) + 1;
        if (!snapshot) return `<page>\nTab ${index}: ${tab.title ?? tab.url} — could not be read.\n</page>`;
        return wrapUntrusted('page', `Tab ${index}\n${renderPageContext(snapshot)}`);
      }),
    );
    blocks.push(...rest);
  }

  // Titles alone are enough for "what do I have open"; contents only go when asked.
  const tabList = open
    .map((tab, index) => `[${index + 1}] ${tab.title || '(untitled)'} — ${tab.url ?? ''}${tab.id === tabId ? ' (current)' : ''}`)
    .join('\n');
  if (tabList) blocks.push(`Open tabs in this window:\n${tabList}`);

  const client = new OllamaClient(settings.ollamaUrl);
  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM_PROMPT },
    // The pages are attached once, ahead of the conversation, so follow-up
    // questions reuse the same snapshot instead of re-reading on every turn.
    { role: 'user', content: blocks.join('\n\n') },
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

  return {
    answer: content.trim(),
    thinking: (collected.thinking || thinking).trim(),
    context,
    tabsRead: readAll ? others.length + 1 : 1,
  };
}
