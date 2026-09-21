/**
 * Content-script entry point. Injected on demand by the service worker; answers
 * extraction, observation and action commands over chrome.runtime messaging.
 */
import { extractReadableText, getSelectionText, trimToBudget } from './extract.ts';
import { formatElements, indexInteractiveElements } from './elements.ts';
import { fetchTranscript, isYouTubeWatchPage } from './youtube.ts';
import {
  clickRef,
  findText,
  pressKey,
  scrollPage,
  scrollProgress,
  selectOption,
  typeIntoRef,
  type ActionResult,
} from './actions.ts';
import type { Observation, PageContext } from '../lib/types.ts';

export type ContentCommand =
  | { command: 'ping' }
  | { command: 'extract'; charBudget: number; includeTranscript: boolean }
  | { command: 'observe'; textBudget?: number }
  | { command: 'act'; action: PageAction };

export type PageAction =
  | { kind: 'click'; ref: number }
  | { kind: 'type'; ref: number; text: string; submit?: boolean }
  | { kind: 'select'; ref: number; value: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; amount?: number }
  | { kind: 'press'; key: string }
  | { kind: 'find'; text: string }
  | { kind: 'wait'; ms: number };

const MARKER = '__qwenBrowserAgentInstalled';

declare global {
  interface Window {
    [MARKER]?: boolean;
  }
}

// executeScript can run this file more than once on the same frame; a second
// listener would answer every message twice.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !window[MARKER]) {
  window[MARKER] = true;
  chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse) => {
    handleCommand(message).then(sendResponse, (error: unknown) =>
      sendResponse({ error: error instanceof Error ? error.message : String(error) }),
    );
    return true; // keeps the message channel open for the async response
  });
}

/** Exported so tests can drive the same code path the message listener uses. */
export async function handleCommand(message: ContentCommand): Promise<unknown> {
  switch (message.command) {
    case 'ping':
      return { ok: true };
    case 'extract':
      return extract(message.charBudget, message.includeTranscript);
    case 'observe':
      return observe(message.textBudget ?? 3000);
    case 'act':
      return act(message.action);
    default:
      return { error: `Unknown command: ${(message as { command: string }).command}` };
  }
}

async function extract(charBudget: number, includeTranscript: boolean): Promise<PageContext> {
  const raw = extractReadableText(document);
  const { text, truncated } = trimToBudget(raw, charBudget);

  let transcript = null;
  if (includeTranscript && isYouTubeWatchPage(location.href)) {
    try {
      transcript = await fetchTranscript(location.href);
    } catch {
      transcript = null; // a missing transcript is not a failed extraction
    }
  }

  return {
    url: location.href,
    title: document.title,
    text,
    selection: getSelectionText(document),
    transcript,
    truncated,
    originalLength: raw.length,
  };
}

function observe(textBudget: number): Observation {
  const elements = indexInteractiveElements(document);
  const { text } = trimToBudget(extractReadableText(document), textBudget);
  return {
    url: location.href,
    title: document.title,
    elements,
    text,
    scrollProgress: scrollProgress(),
  };
}

async function act(action: PageAction): Promise<ActionResult> {
  switch (action.kind) {
    case 'click':
      return clickRef(action.ref);
    case 'type':
      return typeIntoRef(action.ref, action.text, action.submit ?? false);
    case 'select':
      return selectOption(action.ref, action.value);
    case 'scroll':
      return scrollPage(action.direction, action.amount);
    case 'press':
      return pressKey(action.key);
    case 'find':
      return findText(action.text);
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(0, action.ms))));
      return { ok: true, detail: `Waited ${action.ms}ms.` };
    default:
      return { ok: false, detail: `Unknown action: ${JSON.stringify(action)}` };
  }
}

