/**
 * Everything that touches a tab. Runs in the side panel document rather than
 * the service worker: an MV3 worker is torn down after ~30s idle, which would
 * kill a long agent run mid-step.
 */
import type { ContentCommand, PageAction, SettleResult } from '../content/page-agent.ts';
import type { ActionResult } from '../content/actions.ts';
import type { Observation, PageContext, TranscriptCue } from './types.ts';
import { isBlockedUrl } from './safety.ts';

const CONTENT_SCRIPT = 'content/page-agent.js';

export class TabError extends Error {}

export async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new TabError('No active tab. Open a page and try again.');
  return tab;
}

/**
 * Injects the content script if it is not already there. Injection is
 * idempotent — the script guards against installing its listener twice — but a
 * ping first avoids a redundant round trip on every step.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && isBlockedUrl(tab.url)) {
    throw new TabError(
      `This page (${tab.url.split(':')[0]}:) is off limits to extensions. Open a normal web page and try again.`,
    );
  }

  const alive = await send<{ ok: boolean }>(tabId, { command: 'ping' }).catch(() => null);
  if (alive?.ok) return;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (error) {
    throw new TabError(
      `Could not attach to this tab: ${error instanceof Error ? error.message : String(error)}. ` +
        `Chrome blocks extensions on its own pages and on the Web Store.`,
    );
  }
}

async function send<T>(tabId: number, message: ContentCommand): Promise<T> {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (response && typeof response === 'object' && 'error' in response) {
    throw new TabError(String((response as { error: unknown }).error));
  }
  return response as T;
}

export async function readPage(tabId: number, charBudget: number, includeTranscript: boolean): Promise<PageContext> {
  await ensureContentScript(tabId);
  return send<PageContext>(tabId, { command: 'extract', charBudget, includeTranscript });
}

export async function observePage(tabId: number, textBudget = 3000): Promise<Observation> {
  await ensureContentScript(tabId);
  return send<Observation>(tabId, { command: 'observe', textBudget });
}

/** Waits for the page's DOM to stop changing before it is observed. */
export async function settlePage(tabId: number, maxMs = 5000): Promise<SettleResult> {
  await ensureContentScript(tabId);
  return send<SettleResult>(tabId, { command: 'settle', maxMs });
}

export async function performAction(tabId: number, action: PageAction): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return send<ActionResult>(tabId, { command: 'act', action });
}

export async function readTranscript(tabId: number): Promise<TranscriptCue[] | null> {
  const context = await readPage(tabId, 1, true);
  return context.transcript;
}

export async function navigateTab(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
}

export async function openTab(url: string): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id) await waitForLoad(tab.id);
  return tab;
}

export async function listTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ lastFocusedWindow: true });
}

export async function focusTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (!tab) throw new TabError(`Tab ${tabId} is gone.`);
  return tab;
}

/**
 * Resolves when the tab finishes loading, or after `timeoutMs`. A timeout is
 * not an error: plenty of pages never reach `complete` because of long-polling,
 * and the next observation will show whatever did render.
 */
export function waitForLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // Give client-side rendering a beat to paint after load.
      setTimeout(resolve, 350);
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);

    // The load may already be finished before the listener was attached.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish();
      },
      () => finish(),
    );
  });
}

/** Captures the visible viewport as base64 PNG, for models that can see. */
export async function captureScreenshot(windowId: number): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new TabError('Screenshot capture returned an unexpected format.');
  return dataUrl.slice(comma + 1);
}
