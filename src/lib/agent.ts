/**
 * The perceive -> plan -> gate -> act loop.
 *
 * Every action is followed by a fresh observation, and that observation is what
 * comes back as the tool result. The model therefore never has to remember what
 * the page looked like across a navigation — element numbers are regenerated
 * each time and the newest list is always the one in front of it.
 *
 * The gates live here and in the content script, not in the prompt. A task is
 * fenced to the site it started on plus any site the user named; credential
 * fields are never filled; and consequential same-site actions wait for the
 * user, with silence counting as no.
 */
import { OllamaClient, collectStream, parseToolCallFromText, splitInlineThinking } from './ollama.ts';
import { agentSystemPrompt, jsonToolInstructions } from './prompts.ts';
import { FINISH_TOOL, actionSchema, agentTools, argBool, argInt, argString, coerceArgs, describeTools } from './tools.ts';
import {
  assessClick,
  assessNavigation,
  assessTyping,
  buildScope,
  detectInjectionAttempt,
  hostOf,
  isBlockedUrl,
  isHostAllowed,
  wrapUntrusted,
} from './safety.ts';
import { formatElements } from '../content/elements.ts';
import { formatTranscript } from '../content/youtube.ts';
import * as tabs from './tab-driver.ts';
import type {
  AgentStep,
  BlockedReason,
  ChatMessage,
  InteractiveElement,
  ModelCapabilities,
  Observation,
  Settings,
  ToolCall,
} from './types.ts';

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void;
  onToken?: (token: string, kind: 'content' | 'thinking') => void;
  /** Resolves true when the user approves a gated action. Unanswered for long enough counts as no. */
  requestConfirmation: (description: string) => Promise<boolean>;
}

export interface AgentRunOptions {
  task: string;
  tabId: number;
  settings: Settings;
  capabilities: ModelCapabilities | null;
  signal: AbortSignal;
  /** Extra hosts the task may visit, on top of the starting site and any the task names. */
  allowOrigins?: string[];
  /** How long a confirmation may wait for the user before it counts as declined. */
  confirmTimeoutMs?: number;
}

export interface AgentResult {
  summary: string;
  succeeded: boolean;
  steps: number;
  stopped: boolean;
  /** Things the harness noticed along the way, such as 'prompt-injection-detected'. */
  flags: string[];
}

/** Identical observations in a row that mean the agent is going nowhere. */
const STUCK_THRESHOLD = 3;

/** How long a confirmation may sit unanswered before it is treated as declined. */
export const CONFIRM_TIMEOUT_MS = 60_000;

export async function runAgent(options: AgentRunOptions, callbacks: AgentCallbacks): Promise<AgentResult> {
  const { task, settings, capabilities, signal } = options;
  const client = new OllamaClient(settings.ollamaUrl);

  const canSee = Boolean(capabilities?.vision) && settings.useScreenshots;
  const canCallTools = capabilities?.tools !== false;
  const canThink = Boolean(capabilities?.thinking);
  const tools = agentTools(canSee);

  let tabId = options.tabId;
  let lastElements: InteractiveElement[] = [];
  let iteration = 0;
  const flags = new Set<string>();
  // A model that keeps acting without changing anything will grind through
  // every remaining step. Watch for the page coming back identical instead.
  const recentResults: string[] = [];

  const emit = (step: Omit<AgentStep, 'at' | 'iteration'> & { iteration?: number }) =>
    callbacks.onStep({ iteration, at: Date.now(), ...step });

  const finish = (summary: string, succeeded: boolean, stopped = false): AgentResult => ({
    summary,
    succeeded,
    steps: iteration,
    stopped,
    flags: [...flags],
  });

  const startTab = await chrome.tabs.get(tabId).catch(() => null);
  const scope = buildScope(startTab?.url ?? '', task, options.allowOrigins ?? []);

  const systemPrompt = canCallTools
    ? agentSystemPrompt(capabilities, settings.maxSteps)
    : `${agentSystemPrompt(capabilities, settings.maxSteps)}\n\n${jsonToolInstructions(describeTools(tools))}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Task: ${task}\n\nSites this task may use: ${[...scope].join(', ') || '(none yet)'}. Links to other sites will be refused; if the task needs one, finish and say which.` },
  ];

  const ctx: ExecuteContext = {
    tabId,
    lastElements,
    settings,
    canSee,
    signal,
    scope,
    flags,
    emit,
    requestConfirmation: callbacks.requestConfirmation,
    confirmTimeoutMs: options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS,
  };

  // Seed the loop with what is already on screen, so the first decision is informed.
  try {
    const observation = await tabs.observePage(tabId);
    lastElements = observation.elements;
    noteInjection(observation, flags);
    messages.push({ role: 'user', content: renderObservation(observation, 'Starting page') });
  } catch (error) {
    messages.push({
      role: 'user',
      content: `Could not read the starting page: ${errorText(error)}. Use navigate to go somewhere you can work.`,
    });
  }

  while (iteration < settings.maxSteps) {
    if (signal.aborted) return finish('Stopped by the user.', false, true);
    iteration += 1;

    const stream = client.chat(
      {
        model: settings.model,
        messages,
        // Native tool calling when the model has it; a constraining grammar when
        // it does not, so an invalid action cannot be decoded in the first place.
        ...(canCallTools ? { tools } : { format: actionSchema(tools) }),
        ...(canThink ? { think: settings.reasoningEffort } : {}),
        keep_alive: settings.keepAlive,
        options: { temperature: settings.temperature, num_ctx: settings.numCtx },
      },
      signal,
    );

    let collected;
    try {
      collected = await collectStream(stream, callbacks.onToken);
    } catch (error) {
      if (signal.aborted) return finish('Stopped by the user.', false, true);
      emit({ kind: 'error', text: errorText(error) });
      return finish(errorText(error), false);
    }

    const { content, thinking } = splitInlineThinking(collected.content);
    const reasoning = collected.thinking || thinking;
    if (reasoning.trim()) emit({ kind: 'thinking', text: reasoning.trim() });

    const toolCall: ToolCall | null =
      collected.toolCalls[0] ?? (canCallTools ? null : parseToolCallFromText(content, tools));

    if (!toolCall) {
      // No tool call and no obvious JSON. If the model wrote an answer, take it
      // as the result; if it wrote nothing useful, nudge it once per step.
      if (content.trim()) {
        emit({ kind: 'message', text: content.trim() });
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: `You replied with text instead of an action. If the task is complete, call ${FINISH_TOOL}. Otherwise take the next action.`,
        });
        continue;
      }
      messages.push({ role: 'user', content: `Empty reply. Take an action, or call ${FINISH_TOOL} if you are done.` });
      continue;
    }

    const name = toolCall.function.name;
    const args = coerceArgs(toolCall.function.arguments);
    emit({ kind: 'tool_call', text: describeCall(name, args), toolName: name, toolArgs: args });

    messages.push({ role: 'assistant', content, tool_calls: [{ function: { name, arguments: args } }] });

    if (name === FINISH_TOOL) {
      const summary = argString(args, 'summary') ?? content.trim() ?? 'Done.';
      const succeeded = argBool(args, 'succeeded', true);
      emit({ kind: 'done', text: summary });
      return finish(summary, succeeded);
    }

    let result: string;
    let halt: string | undefined;
    try {
      ctx.tabId = tabId;
      ctx.lastElements = lastElements;
      const outcome = await execute(name, args, ctx);
      result = outcome.text;
      halt = outcome.halt;
      if (outcome.tabId) tabId = outcome.tabId;
      if (outcome.elements) lastElements = outcome.elements;
      if (outcome.images?.length) {
        messages.push({ role: 'tool', tool_name: name, content: result, images: outcome.images });
        emit({ kind: 'tool_result', text: result, toolName: name, toolArgs: args });
        continue;
      }
    } catch (error) {
      if (signal.aborted) return finish('Stopped by the user.', false, true);
      result = `Error: ${errorText(error)}`;
    }

    emit({ kind: 'tool_result', text: result, toolName: name, toolArgs: args });
    messages.push({ role: 'tool', tool_name: name, content: result });

    // Some refusals hand control back to the user rather than letting the model
    // try another route: there is no other route to a password field.
    if (halt) {
      emit({ kind: 'error', text: halt });
      return finish(halt, false);
    }

    recentResults.push(result);
    if (recentResults.length > STUCK_THRESHOLD) recentResults.shift();
    if (recentResults.length === STUCK_THRESHOLD && recentResults.every((r) => r === recentResults[0])) {
      const summary =
        `Stopped after ${STUCK_THRESHOLD} steps that left the page unchanged. ` +
        `The last thing I tried was ${describeCall(name, args)}, and it made no difference. ` +
        `The task may need something I cannot reach from this page.`;
      emit({ kind: 'error', text: summary });
      return finish(summary, false);
    }
  }

  const summary = `Reached the ${settings.maxSteps}-step limit without finishing. Raise the limit in settings, or give me a narrower task.`;
  emit({ kind: 'error', text: summary });
  return finish(summary, false);
}

interface ExecuteContext {
  tabId: number;
  lastElements: InteractiveElement[];
  settings: Settings;
  canSee: boolean;
  signal: AbortSignal;
  /** Hosts this task may visit. */
  scope: Set<string>;
  flags: Set<string>;
  emit: (step: Omit<AgentStep, 'at' | 'iteration'>) => void;
  requestConfirmation: (description: string) => Promise<boolean>;
  confirmTimeoutMs: number;
}

interface ExecuteOutcome {
  text: string;
  tabId?: number;
  elements?: InteractiveElement[];
  images?: string[];
  /** When set, the run ends with this summary after the result is recorded. */
  halt?: string;
}

async function execute(name: string, args: Record<string, unknown>, ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const { tabId, settings } = ctx;
  const elementFor = (ref: number | null) => ctx.lastElements.find((el) => el.ref === ref);

  const refuse = (reason: BlockedReason, text: string): ExecuteOutcome => {
    ctx.emit({ kind: 'blocked', text, blockedReason: reason, toolName: name, toolArgs: args });
    return { text };
  };

  const outOfScope = (url: string): ExecuteOutcome =>
    refuse(
      'off-origin',
      `Refused: ${hostOf(url) ?? url} is outside this task's sites (${[...ctx.scope].join(', ')}). ` +
        `Nothing on a page can widen that. Continue within the allowed sites, or finish and tell the user which site the task needs.`,
    );

  /** Same-site consequential actions wait for the user; no answer means no. */
  const gate = async (assessment: { risky: boolean; reason: string }): Promise<ExecuteOutcome | null> => {
    if (!assessment.risky || !settings.confirmRiskyActions) return null;
    const approved = await Promise.race([
      ctx.requestConfirmation(assessment.reason),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ctx.confirmTimeoutMs)),
    ]);
    if (approved === true) return null;
    const why = approved === 'timeout' ? 'the user did not answer in time' : 'the user declined';
    return refuse(
      'needs-confirmation',
      `Blocked: ${why} (${assessment.reason}) Choose a different approach, or finish and explain.`,
    );
  };

  switch (name) {
    case 'click': {
      const ref = argInt(args, 'ref');
      if (ref === null) return { text: 'Error: click needs a ref, e.g. {"ref": 12}.' };
      const target = elementFor(ref);
      // A link's destination is checked before the click, not after the page
      // has already gone there.
      if (target?.href && !isHostAllowed(target.href, ctx.scope)) return outOfScope(target.href);
      const blocked = await gate(assessClick(target));
      if (blocked) return blocked;
      const result = await tabs.performAction(tabId, { kind: 'click', ref });
      return withObservation(ctx, result.detail, { settle: true });
    }

    case 'type_text': {
      const ref = argInt(args, 'ref');
      const text = argString(args, 'text');
      if (ref === null || text === null) return { text: 'Error: type_text needs a ref and text.' };
      const target = elementFor(ref);
      if (target?.sensitive) return credentialRefusal(ctx, ref, name, args);

      const submit = argBool(args, 'submit', false);
      const blocked = await gate(assessTyping(target, submit));
      if (blocked) return blocked;

      const result = await tabs.performAction(tabId, { kind: 'type', ref, text, submit });
      // The content script checks the live node too; if it refused, the index
      // was stale and the same rule applies.
      if (!result.ok && result.detail.startsWith('Refused:')) return credentialRefusal(ctx, ref, name, args);
      return withObservation(ctx, result.detail, { settle: submit });
    }

    case 'select_option': {
      const ref = argInt(args, 'ref');
      const value = argString(args, 'value');
      if (ref === null || value === null) return { text: 'Error: select_option needs a ref and value.' };
      const result = await tabs.performAction(tabId, { kind: 'select', ref, value });
      return withObservation(ctx, result.detail);
    }

    case 'scroll': {
      const direction = (argString(args, 'direction') ?? 'down').toLowerCase();
      if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
        return { text: `Error: scroll direction must be up, down, top or bottom (got "${direction}").` };
      }
      const result = await tabs.performAction(tabId, {
        kind: 'scroll',
        direction: direction as 'up' | 'down' | 'top' | 'bottom',
      });
      return withObservation(ctx, result.detail);
    }

    case 'press_key': {
      const key = argString(args, 'key');
      if (!key) return { text: 'Error: press_key needs a key name.' };
      const result = await tabs.performAction(tabId, { kind: 'press', key });
      return withObservation(ctx, result.detail, { settle: key === 'Enter' });
    }

    case 'find_text': {
      const text = argString(args, 'text');
      if (!text) return { text: 'Error: find_text needs text to look for.' };
      const result = await tabs.performAction(tabId, { kind: 'find', text });
      return { text: result.detail };
    }

    case 'navigate': {
      const url = argString(args, 'url');
      if (!url) return { text: 'Error: navigate needs a url.' };
      if (isBlockedUrl(url)) return { text: `Blocked: ${url} is not a page an extension may drive.` };
      const shape = assessNavigation(url);
      if (shape.risky) return { text: `Blocked: ${shape.reason}` };
      if (!isHostAllowed(url, ctx.scope)) return outOfScope(url);
      await tabs.navigateTab(tabId, url);
      return withObservation(ctx, `Navigated to ${url}.`, { settle: true });
    }

    case 'open_tab': {
      const url = argString(args, 'url');
      if (!url) return { text: 'Error: open_tab needs a url.' };
      if (isBlockedUrl(url)) return { text: `Blocked: ${url} is not a page an extension may drive.` };
      const shape = assessNavigation(url);
      if (shape.risky) return { text: `Blocked: ${shape.reason}` };
      if (!isHostAllowed(url, ctx.scope)) return outOfScope(url);
      const tab = await tabs.openTab(url);
      if (!tab.id) return { text: 'Error: the new tab could not be opened.' };
      return withObservation({ ...ctx, tabId: tab.id }, `Opened ${url} in a new tab.`, { newTabId: tab.id, settle: true });
    }

    case 'list_tabs': {
      const open = await tabs.listTabs();
      const listing = open
        .map((tab, index) => `[${index}] ${tab.title ?? '(untitled)'} — ${tab.url ?? ''}${tab.id === tabId ? ' (current)' : ''}`)
        .join('\n');
      return { text: listing || 'No open tabs.' };
    }

    case 'switch_tab': {
      const index = argInt(args, 'index');
      const open = await tabs.listTabs();
      const target = index === null ? undefined : open[index];
      if (!target?.id) return { text: `Error: no tab at index ${index}. Call list_tabs to see what is open.` };
      // A tab the user already has open is theirs; it joins the task's sites.
      const host = target.url ? hostOf(target.url) : null;
      if (host) ctx.scope.add(host);
      await tabs.focusTab(target.id);
      return withObservation({ ...ctx, tabId: target.id }, `Switched to "${target.title ?? target.url}".`, {
        newTabId: target.id,
      });
    }

    case 'get_transcript': {
      const cues = await tabs.readTranscript(tabId);
      if (!cues?.length) {
        return { text: 'No transcript is available for this tab. It may not be a YouTube video, or captions may be off.' };
      }
      const rendered = formatTranscript(cues, 30000);
      if (detectInjectionAttempt(rendered)) ctx.flags.add('prompt-injection-detected');
      return { text: wrapUntrusted('transcript', rendered) };
    }

    case 'observe':
      return withObservation(ctx, 'Re-read the page.');

    case 'wait': {
      const ms = Math.min(10000, Math.max(0, argInt(args, 'ms') ?? 1000));
      await tabs.performAction(tabId, { kind: 'wait', ms });
      return withObservation(ctx, `Waited ${ms}ms.`, { settle: true });
    }

    case 'take_screenshot': {
      if (!ctx.canSee) {
        return { text: 'Screenshots are unavailable: this model does not report image support, or they are off in settings.' };
      }
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === undefined) return { text: 'Error: could not identify the window to capture.' };
      const image = await tabs.captureScreenshot(tab.windowId);
      return { text: 'Screenshot of the visible part of the page:', images: [image] };
    }

    default:
      return { text: `Error: no such tool "${name}".` };
  }
}

/**
 * A credential field ends the run. There is no confirmation to ask for: a dialog
 * that offers to type the user's password is a credential-entry dialog with
 * extra steps, and a page that talked the model into asking would be halfway
 * there. The user signs in themselves and starts the task again.
 */
function credentialRefusal(ctx: ExecuteContext, ref: number, name: string, args: Record<string, unknown>): ExecuteOutcome {
  const text = `Refused: [${ref}] is a password or payment field, and the agent never fills those.`;
  ctx.emit({ kind: 'blocked', text, blockedReason: 'credential-field', toolName: name, toolArgs: args });
  return {
    text,
    halt:
      'Stopped: the task reached a password or payment field, which I will not fill in. ' +
      'Sign in or enter the details yourself, then run the task again.',
  };
}

/**
 * Pairs an action's outcome with a fresh observation. This is what keeps the
 * model oriented: it never acts on a stale element list because the newest one
 * arrives attached to the result of its last action.
 */
async function withObservation(
  ctx: ExecuteContext,
  detail: string,
  opts: { settle?: boolean; newTabId?: number } = {},
): Promise<ExecuteOutcome> {
  const tabId = opts.newTabId ?? ctx.tabId;

  let notice = '';
  if (opts.settle) {
    // A click or a submit may start a navigation; give it a chance to commit
    // before we describe the page, or we describe the page being left behind.
    await tabs.waitForLoad(tabId, 8000);
    // Then wait for the DOM itself to stop changing. `load` fires long before
    // a client-rendered page has finished drawing what the user will see.
    const settled = await tabs.settlePage(tabId).catch(() => null);
    if (settled && !settled.settled) {
      notice += '\n\n[notice] The page was still changing when it was read; if an element you expect is missing, call observe again.';
    }
  }

  // A page can navigate itself, by script or by a button that is really a link.
  // If that took the tab out of scope, step back before the model sees it.
  const landed = await chrome.tabs.get(tabId).catch(() => null);
  if (landed?.url && hostOf(landed.url) && !isHostAllowed(landed.url, ctx.scope)) {
    const text = `Refused: the page navigated to ${hostOf(landed.url)}, which is outside this task's sites. Went back.`;
    ctx.emit({ kind: 'blocked', text, blockedReason: 'off-origin' });
    await tabs.goBack(tabId).catch(() => undefined);
    notice += `\n\n[notice] ${text}`;
  }

  try {
    const observation = await tabs.observePage(tabId);
    noteInjection(observation, ctx.flags);
    return {
      text: `${detail}${notice}\n\n${renderObservation(observation)}`,
      tabId,
      elements: observation.elements,
    };
  } catch (error) {
    return { text: `${detail}${notice}\n\nCould not read the page afterwards: ${errorText(error)}`, tabId };
  }
}

function noteInjection(observation: Observation, flags: Set<string>): void {
  if (detectInjectionAttempt(observation.text)) flags.add('prompt-injection-detected');
}

export function renderObservation(observation: Observation, label = 'Page now'): string {
  const scroll = `${Math.round(observation.scrollProgress * 100)}% down the page`;
  return [
    `${label}: ${observation.title}`,
    `URL: ${observation.url} (${scroll})`,
    '',
    'Interactive elements:',
    formatElements(observation.elements, hostOf(observation.url) ?? undefined),
    '',
    wrapUntrusted('page_text', observation.text),
  ].join('\n');
}

function describeCall(name: string, args: Record<string, unknown>): string {
  const rendered = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value.slice(0, 60)) : String(value)}`)
    .join(', ');
  return rendered ? `${name}(${rendered})` : `${name}()`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
