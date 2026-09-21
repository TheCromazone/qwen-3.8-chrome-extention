/**
 * Side panel controller. The agent loop runs here rather than in the service
 * worker, so a long task survives for as long as the panel is open. Each run's
 * steps are also written to session storage as they happen, so closing and
 * reopening the panel shows what the last run did rather than a blank pane.
 */
import { CONFIRM_TIMEOUT_MS, runAgent, type AgentResult } from '../lib/agent.ts';
import { askAboutPage } from '../lib/ask.ts';
import { OllamaClient, OllamaError } from '../lib/ollama.ts';
import { loadSettings, onSettingsChanged } from '../lib/settings.ts';
import { activeTab } from '../lib/tab-driver.ts';
import type { AgentStep, ModelCapabilities, RunMode, Settings } from '../lib/types.ts';
import { installTestBridge, journalEntryFor, toJournal, type Confirmation } from './bridge.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const ui = {
  modeAsk: el<HTMLButtonElement>('mode-ask'),
  modeAgent: el<HTMLButtonElement>('mode-agent'),
  settings: el<HTMLButtonElement>('open-settings'),
  status: el<HTMLParagraphElement>('status'),
  error: el<HTMLParagraphElement>('error'),
  transcript: el<HTMLElement>('transcript'),
  composer: el<HTMLFormElement>('composer'),
  input: el<HTMLTextAreaElement>('input'),
  send: el<HTMLButtonElement>('send'),
  stop: el<HTMLButtonElement>('stop'),
  contextNote: el<HTMLSpanElement>('context-note'),
  confirm: el<HTMLDivElement>('confirm'),
  confirmText: el<HTMLParagraphElement>('confirm-text'),
  confirmAllow: el<HTMLButtonElement>('confirm-allow'),
  confirmDeny: el<HTMLButtonElement>('confirm-deny'),
};

let settings: Settings = await loadSettings();
let capabilities: ModelCapabilities | null = null;
let mode: RunMode = 'ask';
let controller: AbortController | null = null;
const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

onSettingsChanged((next) => {
  settings = next;
  capabilities = null;
  void probeCapabilities();
});

/* ---------------------------------------------------------------- rendering */

function setStatus(text: string, isError = false): void {
  ui.status.textContent = text;
  ui.status.classList.toggle('is-error', isError);
}

function showError(text: string): void {
  ui.error.textContent = text;
  ui.error.hidden = false;
}

function hideError(): void {
  ui.error.hidden = true;
  ui.error.textContent = '';
}

function addMessage(role: 'user' | 'assistant' | 'error', text = ''): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.textContent = text;
  ui.transcript.append(node);
  scrollToEnd();
  return node;
}

function addDivider(text: string): void {
  const node = document.createElement('div');
  node.className = 'divider';
  node.textContent = text;
  ui.transcript.append(node);
}

function renderStep(step: AgentStep): void {
  // Any step arriving while a confirmation is showing means the loop has moved
  // on — answered, or timed out — so the prompt is stale.
  if (pending) hideConfirm();

  const node = document.createElement('div');
  node.className = `step${step.kind === 'blocked' ? ' is-blocked' : ''}`;

  const label = document.createElement('span');
  label.className = 'step-label';
  label.textContent = stepLabel(step);
  node.append(label);

  // Reasoning and raw observations are long and rarely wanted; fold them away.
  if (step.kind === 'thinking' || step.kind === 'tool_result') {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = firstLine(step.text);
    const body = document.createElement('pre');
    body.textContent = step.text;
    details.append(summary, body);
    node.append(details);
  } else {
    node.append(document.createTextNode(step.text));
  }

  ui.transcript.append(node);
  scrollToEnd();
}

function stepLabel(step: AgentStep): string {
  switch (step.kind) {
    case 'thinking': return `Step ${step.iteration} · thinking`;
    case 'tool_call': return `Step ${step.iteration} · action`;
    case 'tool_result': return `Step ${step.iteration} · result`;
    case 'blocked': return `Step ${step.iteration} · refused`;
    case 'message': return `Step ${step.iteration} · note`;
    case 'error': return 'Problem';
    case 'done': return 'Finished';
    case 'stopped': return 'Stopped';
    default: return `Step ${step.iteration}`;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line || '(empty)';
}

function scrollToEnd(): void {
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function setRunning(running: boolean): void {
  ui.send.disabled = running;
  ui.stop.hidden = !running;
  ui.input.disabled = running;
  if (!running) hideConfirm();
}

/* ------------------------------------------------------------------ journal */

interface StoredRun {
  task: string;
  mode: RunMode;
  steps: AgentStep[];
  answer: string | null;
  at: number;
}

let currentRun: StoredRun | null = null;

function startJournal(task: string, runMode: RunMode): void {
  currentRun = { task, mode: runMode, steps: [], answer: null, at: Date.now() };
  void persistRun();
}

function recordStep(step: AgentStep): void {
  currentRun?.steps.push(step);
  renderStep(step);
  void persistRun();
}

function finishJournal(answer: string): void {
  if (!currentRun) return;
  currentRun.answer = answer;
  void persistRun();
}

/** Session storage outlives the panel document but not the browser; that is the right lifetime. */
async function persistRun(): Promise<void> {
  try {
    await chrome.storage.session.set({ lastRun: currentRun });
  } catch {
    /* storage unavailable; the run still shows while the panel is open */
  }
}

async function restoreLastRun(): Promise<void> {
  let stored: StoredRun | undefined;
  try {
    stored = ((await chrome.storage.session.get('lastRun')) as { lastRun?: StoredRun }).lastRun;
  } catch {
    return;
  }
  if (!stored?.task) return;

  addDivider(`Earlier ${stored.mode === 'ask' ? 'question' : 'task'} · ${new Date(stored.at).toLocaleTimeString()}`);
  addMessage('user', stored.task);
  for (const step of stored.steps) renderStep(step);
  if (stored.answer !== null) addMessage('assistant', stored.answer);
  addDivider('Now');
}

/* ------------------------------------------------------------ confirmations */

interface PendingConfirmation {
  id: string;
  reason: string;
  resolve: (approved: boolean) => void;
}

let pending: PendingConfirmation | null = null;
let confirmSeq = 0;

function requestConfirmation(description: string): Promise<boolean> {
  ui.confirmText.textContent =
    `${description} Allow it? It is declined on its own after ${Math.round(CONFIRM_TIMEOUT_MS / 1000)} seconds.`;
  ui.confirm.hidden = false;
  scrollToEnd();
  return new Promise((resolve) => {
    pending = {
      id: `c${++confirmSeq}`,
      reason: description,
      resolve: (approved) => {
        hideConfirm();
        resolve(approved);
      },
    };
  });
}

function answerConfirmation(approved: boolean): void {
  pending?.resolve(approved);
}

function hideConfirm(): void {
  ui.confirm.hidden = true;
  pending = null;
}

ui.confirmAllow.addEventListener('click', () => answerConfirmation(true));
ui.confirmDeny.addEventListener('click', () => answerConfirmation(false));

/* -------------------------------------------------------------- capabilities */

async function probeCapabilities(): Promise<void> {
  setStatus(`Checking ${settings.model}…`);
  try {
    capabilities = await new OllamaClient(settings.ollamaUrl).capabilities(settings.model);
    const can = [
      capabilities.vision ? 'images' : null,
      capabilities.tools ? 'tools' : null,
      capabilities.thinking ? 'thinking' : null,
    ].filter(Boolean);
    setStatus(`${capabilities.model} · ${can.length ? can.join(', ') : 'text only'}`);
  } catch (error) {
    capabilities = null;
    setStatus(describeError(error), true);
  }
}

function describeError(error: unknown): string {
  if (error instanceof OllamaError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/* ---------------------------------------------------------------- run modes */

interface RunOutcome {
  answer: string;
  result?: AgentResult;
}

async function runAsk(question: string): Promise<RunOutcome> {
  const tab = await activeTab();
  const answer = addMessage('assistant');
  let streamed = '';

  const result = await askAboutPage(
    { question, tabId: tab.id!, settings, capabilities, history: [...history], signal: controller!.signal },
    (token, kind) => {
      if (kind !== 'content') return;
      streamed += token;
      answer.textContent = streamed;
      scrollToEnd();
    },
  );

  // The streamed text can contain inline reasoning tags; the parsed answer wins.
  answer.textContent = result.answer || streamed || '(no answer)';
  history.push({ role: 'user', content: question }, { role: 'assistant', content: result.answer });

  const notes = [
    result.tabsRead > 1 ? `${result.tabsRead} tabs read` : `${result.context.originalLength.toLocaleString()} chars read`,
    result.context.truncated ? 'truncated' : null,
    result.context.selection ? 'used your selection' : null,
    result.context.transcript?.length ? `${result.context.transcript.length} transcript cues` : null,
  ].filter(Boolean);
  ui.contextNote.textContent = notes.join(' · ');
  return { answer: result.answer };
}

async function runAgentTask(task: string, opts: { allowOrigins?: string[] }): Promise<RunOutcome> {
  const tab = await activeTab();
  const result = await runAgent(
    { task, tabId: tab.id!, settings, capabilities, signal: controller!.signal, allowOrigins: opts.allowOrigins },
    { onStep: recordStep, requestConfirmation },
  );

  addMessage(result.succeeded ? 'assistant' : 'error', result.summary);
  ui.contextNote.textContent = `${result.steps} step${result.steps === 1 ? '' : 's'}`;
  return { answer: result.summary, result };
}

/** One entry point for the form and for the test bridge. */
async function run(text: string, runMode: RunMode, opts: { allowOrigins?: string[] } = {}): Promise<RunOutcome> {
  if (controller) throw new Error('A run is already in progress.');

  ui.input.value = '';
  hideError();
  addMessage('user', text);
  controller = new AbortController();
  setRunning(true);
  setStatus(runMode === 'ask' ? 'Reading the page…' : 'Working…');
  startJournal(text, runMode);

  try {
    if (!capabilities) await probeCapabilities();
    const outcome = runMode === 'ask' ? await runAsk(text) : await runAgentTask(text, opts);
    finishJournal(outcome.answer);
    setStatus('');
    return outcome;
  } catch (error) {
    const message = describeError(error);
    finishJournal('');
    if (controller.signal.aborted) setStatus('Stopped.');
    else {
      showError(message);
      setStatus('');
    }
    throw error;
  } finally {
    controller = null;
    setRunning(false);
    ui.input.focus();
  }
}

/* ------------------------------------------------------------------- events */

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.input.value.trim();
  if (!text || controller) return;
  run(text, mode).catch(() => {
    /* already shown in the error banner */
  });
});

ui.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ui.composer.requestSubmit();
  }
});

ui.stop.addEventListener('click', () => {
  controller?.abort();
  answerConfirmation(false);
  setStatus('Stopping…');
});

function selectMode(next: RunMode): void {
  mode = next;
  const isAsk = next === 'ask';
  ui.modeAsk.classList.toggle('is-active', isAsk);
  ui.modeAgent.classList.toggle('is-active', !isAsk);
  ui.modeAsk.setAttribute('aria-selected', String(isAsk));
  ui.modeAgent.setAttribute('aria-selected', String(!isAsk));
  ui.input.placeholder = isAsk
    ? 'Ask about this page…'
    : 'Describe a task, e.g. "find the cheapest flight to Lisbon on skyscanner.com"';
}

ui.modeAsk.addEventListener('click', () => selectMode('ask'));
ui.modeAgent.addEventListener('click', () => selectMode('agent'));
ui.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

/* -------------------------------------------------------------- test bridge */

function pendingConfirmations(): Confirmation[] {
  if (!pending) return [];
  const lastCall = [...(currentRun?.steps ?? [])].reverse().find((s) => s.kind === 'tool_call');
  return [{ id: pending.id, reason: pending.reason, action: journalEntryFor(lastCall) }];
}

void installTestBridge({
  async ask(question) {
    const outcome = await run(question, 'ask');
    return { answer: outcome.answer };
  },
  async runTask(task, opts) {
    const outcome = await run(task, 'agent', { allowOrigins: opts?.allowOrigins });
    return {
      answer: outcome.answer,
      journal: toJournal(currentRun?.steps ?? []),
      flags: outcome.result?.flags ?? [],
    };
  },
  getJournal: () => toJournal(currentRun?.steps ?? []),
  pendingConfirmations,
  approve(id) {
    if (pending?.id === id) answerConfirmation(true);
  },
  deny(id) {
    if (pending?.id === id) answerConfirmation(false);
  },
  reset() {
    controller?.abort();
    history.length = 0;
    currentRun = null;
    ui.transcript.replaceChildren();
    hideError();
    ui.contextNote.textContent = '';
    void chrome.storage.session.remove('lastRun').catch(() => undefined);
  },
});

selectMode('ask');
await restoreLastRun();
void probeCapabilities();
ui.input.focus();
