/**
 * The QA gauntlet's test bridge. Inert unless chrome.storage.local holds
 * { gauntlet: true }; without that flag nothing here is reachable, and a remote
 * page could not reach a side panel document's globals in any case.
 *
 * The shape follows gauntlet/CONTRACT.md §3 so the safety tasks can assert on
 * structured journal entries rather than on rendered step text.
 */
import type { AgentStep, BlockedReason } from '../lib/types.ts';

export interface JournalStep {
  n: number;
  action: 'click' | 'type' | 'navigate' | 'scroll' | 'read' | 'screenshot' | 'answer';
  ref?: string;
  value?: string;
  observation?: string;
  blocked?: BlockedReason;
  at: number;
}

export interface Confirmation {
  id: string;
  action: JournalStep;
  reason: string;
}

export interface TaskResult {
  answer: string;
  journal: JournalStep[];
  flags: string[];
}

export interface PanelApi {
  ask(question: string): Promise<{ answer: string }>;
  runTask(task: string, opts?: { allowOrigins?: string[] }): Promise<TaskResult>;
  getJournal(): JournalStep[];
  pendingConfirmations(): Confirmation[];
  approve(id: string): void;
  deny(id: string): void;
  reset(): void;
}

const ACTION_OF: Record<string, JournalStep['action']> = {
  click: 'click',
  select_option: 'click',
  type_text: 'type',
  press_key: 'type',
  navigate: 'navigate',
  open_tab: 'navigate',
  switch_tab: 'navigate',
  scroll: 'scroll',
  observe: 'read',
  find_text: 'read',
  get_transcript: 'read',
  list_tabs: 'read',
  wait: 'read',
  take_screenshot: 'screenshot',
  finish: 'answer',
};

/** Collapses the panel's step stream into one journal entry per action. */
export function toJournal(steps: AgentStep[]): JournalStep[] {
  const out: JournalStep[] = [];
  let n = 0;
  let lastBlockedText: string | null = null;

  for (const step of steps) {
    if (step.kind === 'blocked') {
      lastBlockedText = step.text;
      out.push({
        n: ++n,
        action: ACTION_OF[step.toolName ?? ''] ?? 'navigate',
        ref: refOf(step.toolArgs),
        value: valueOf(step.toolArgs),
        blocked: step.blockedReason,
        at: step.at,
      });
      continue;
    }
    if (step.kind === 'tool_result') {
      // The loop records a refusal as a tool result too; that is the same entry.
      if (lastBlockedText !== null && step.text === lastBlockedText) {
        lastBlockedText = null;
        continue;
      }
      lastBlockedText = null;
      out.push({
        n: ++n,
        action: ACTION_OF[step.toolName ?? ''] ?? 'read',
        ref: refOf(step.toolArgs),
        value: valueOf(step.toolArgs),
        observation: step.text,
        at: step.at,
      });
      continue;
    }
    if (step.kind === 'done') {
      out.push({ n: ++n, action: 'answer', value: step.text, at: step.at });
    }
  }
  return out;
}

export function journalEntryFor(step: AgentStep | undefined): JournalStep {
  if (!step) return { n: 0, action: 'read', at: Date.now() };
  return {
    n: 0,
    action: ACTION_OF[step.toolName ?? ''] ?? 'read',
    ref: refOf(step.toolArgs),
    value: valueOf(step.toolArgs),
    at: step.at,
  };
}

function refOf(args: Record<string, unknown> | undefined): string | undefined {
  const ref = args?.ref;
  return ref === undefined || ref === null ? undefined : String(ref);
}

function valueOf(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['text', 'url', 'value', 'direction', 'key', 'summary', 'index']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

declare global {
  interface Window {
    __qwenGauntlet?: PanelApi;
  }
}

export async function installTestBridge(api: PanelApi): Promise<boolean> {
  let enabled = false;
  try {
    const stored = await chrome.storage.local.get('gauntlet');
    enabled = stored?.gauntlet === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return false;
  window.__qwenGauntlet = api;
  return true;
}
