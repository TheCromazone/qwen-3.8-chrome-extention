/**
 * Side panel controller. The agent loop runs here rather than in the service
 * worker, so a long task survives for as long as the panel is open.
 */
import { runAgent } from '../lib/agent.ts';
import { askAboutPage } from '../lib/ask.ts';
import { OllamaClient, OllamaError } from '../lib/ollama.ts';
import { loadSettings, onSettingsChanged } from '../lib/settings.ts';
import { activeTab } from '../lib/tab-driver.ts';
import type { AgentStep, ModelCapabilities, RunMode, Settings } from '../lib/types.ts';

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

function addMessage(role: 'user' | 'assistant' | 'error', text = ''): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  node.textContent = text;
  ui.transcript.append(node);
  scrollToEnd();
  return node;
}

function addStep(step: AgentStep): void {
  const node = document.createElement('div');
  node.className = 'step';

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

/* ------------------------------------------------------------ confirmations */

let pendingConfirm: ((approved: boolean) => void) | null = null;

function requestConfirmation(description: string): Promise<boolean> {
  ui.confirmText.textContent = `${description} Allow it?`;
  ui.confirm.hidden = false;
  scrollToEnd();
  return new Promise((resolve) => {
    pendingConfirm = (approved) => {
      hideConfirm();
      resolve(approved);
    };
  });
}

function hideConfirm(): void {
  ui.confirm.hidden = true;
  pendingConfirm = null;
}

ui.confirmAllow.addEventListener('click', () => pendingConfirm?.(true));
ui.confirmDeny.addEventListener('click', () => pendingConfirm?.(false));

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

async function runAsk(question: string): Promise<void> {
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
    `${result.context.originalLength.toLocaleString()} chars read`,
    result.context.truncated ? 'truncated' : null,
    result.context.selection ? 'used your selection' : null,
    result.context.transcript?.length ? `${result.context.transcript.length} transcript cues` : null,
  ].filter(Boolean);
  ui.contextNote.textContent = notes.join(' · ');
}

async function runAgentTask(task: string): Promise<void> {
  const tab = await activeTab();
  const result = await runAgent(
    { task, tabId: tab.id!, settings, capabilities, signal: controller!.signal },
    { onStep: addStep, requestConfirmation },
  );

  addMessage(result.succeeded ? 'assistant' : 'error', result.summary);
  ui.contextNote.textContent = `${result.steps} step${result.steps === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------- events */

ui.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ui.input.value.trim();
  if (!text || controller) return;

  ui.input.value = '';
  addMessage('user', text);
  controller = new AbortController();
  setRunning(true);
  setStatus(mode === 'ask' ? 'Reading the page…' : 'Working…');

  try {
    if (!capabilities) await probeCapabilities();
    if (mode === 'ask') await runAsk(text);
    else await runAgentTask(text);
    setStatus('');
  } catch (error) {
    if (controller.signal.aborted) setStatus('Stopped.');
    else {
      addMessage('error', describeError(error));
      setStatus('');
    }
  } finally {
    controller = null;
    setRunning(false);
    ui.input.focus();
  }
});

ui.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    ui.composer.requestSubmit();
  }
});

ui.stop.addEventListener('click', () => {
  controller?.abort();
  pendingConfirm?.(false);
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
    : 'Describe a task, e.g. "find the cheapest flight to Lisbon next Friday"';
}

ui.modeAsk.addEventListener('click', () => selectMode('ask'));
ui.modeAgent.addEventListener('click', () => selectMode('agent'));
ui.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

selectMode('ask');
void probeCapabilities();
ui.input.focus();
