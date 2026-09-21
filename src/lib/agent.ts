/**
 * The perceive -> plan -> gate -> act loop.
 *
 * Every action is followed by a fresh observation, and that observation is what
 * comes back as the tool result. The model therefore never has to remember what
 * the page looked like across a navigation — element numbers are regenerated
 * each time and the newest list is always the one in front of it.
 */
import { OllamaClient, collectStream, parseToolCallFromText, splitInlineThinking } from './ollama.ts';
import { agentSystemPrompt, jsonToolInstructions } from './prompts.ts';
import { FINISH_TOOL, actionSchema, agentTools, argBool, argInt, argString, coerceArgs, describeTools } from './tools.ts';
import { assessClick, assessNavigation, assessTyping, isBlockedUrl, wrapUntrusted } from './safety.ts';
import { formatElements } from '../content/elements.ts';
import { formatTranscript } from '../content/youtube.ts';
import * as tabs from './tab-driver.ts';
import type { AgentStep, ChatMessage, InteractiveElement, ModelCapabilities, Observation, Settings, ToolCall } from './types.ts';

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void;
  onToken?: (token: string, kind: 'content' | 'thinking') => void;
  /** Resolves true when the user approves a gated action. */
  requestConfirmation: (description: string) => Promise<boolean>;
}

export interface AgentRunOptions {
  task: string;
  tabId: number;
  settings: Settings;
  capabilities: ModelCapabilities | null;
  signal: AbortSignal;
}

export interface AgentResult {
  summary: string;
  succeeded: boolean;
  steps: number;
  stopped: boolean;
}

/** Identical observations in a row that mean the agent is going nowhere. */
const STUCK_THRESHOLD = 3;

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
  // A model that keeps acting without changing anything will grind through
  // every remaining step. Watch for the page coming back identical instead.
  const recentResults: string[] = [];

  const emit = (step: Omit<AgentStep, 'at' | 'iteration'> & { iteration?: number }) =>
    callbacks.onStep({ iteration, at: Date.now(), ...step });

  const systemPrompt = canCallTools
    ? agentSystemPrompt(capabilities, settings.maxSteps)
    : `${agentSystemPrompt(capabilities, settings.maxSteps)}\n\n${jsonToolInstructions(describeTools(tools))}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Task: ${task}` },
  ];

  // Seed the loop with what is already on screen, so the first decision is informed.
  try {
    const observation = await tabs.observePage(tabId);
    lastElements = observation.elements;
    messages.push({ role: 'user', content: renderObservation(observation, 'Starting page') });
  } catch (error) {
    messages.push({
      role: 'user',
      content: `Could not read the starting page: ${errorText(error)}. Use navigate to go somewhere you can work.`,
    });
  }

  while (iteration < settings.maxSteps) {
    if (signal.aborted) return { summary: 'Stopped by the user.', succeeded: false, steps: iteration, stopped: true };
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
      if (signal.aborted) return { summary: 'Stopped by the user.', succeeded: false, steps: iteration, stopped: true };
      emit({ kind: 'error', text: errorText(error) });
      return { summary: errorText(error), succeeded: false, steps: iteration, stopped: false };
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
      return { summary, succeeded, steps: iteration, stopped: false };
    }

    let result: string;
    try {
      const outcome = await execute(name, args, {
        tabId,
        lastElements,
        settings,
        canSee,
        signal,
        requestConfirmation: callbacks.requestConfirmation,
      });
      result = outcome.text;
      if (outcome.tabId) tabId = outcome.tabId;
      if (outcome.elements) lastElements = outcome.elements;
      if (outcome.images?.length) {
        messages.push({ role: 'tool', tool_name: name, content: result, images: outcome.images });
        emit({ kind: 'tool_result', text: result, toolName: name });
        continue;
      }
    } catch (error) {
      if (signal.aborted) return { summary: 'Stopped by the user.', succeeded: false, steps: iteration, stopped: true };
      result = `Error: ${errorText(error)}`;
    }

    emit({ kind: 'tool_result', text: result, toolName: name });
    messages.push({ role: 'tool', tool_name: name, content: result });

    recentResults.push(result);
    if (recentResults.length > STUCK_THRESHOLD) recentResults.shift();
    if (recentResults.length === STUCK_THRESHOLD && recentResults.every((r) => r === recentResults[0])) {
      const summary =
        `Stopped after ${STUCK_THRESHOLD} steps that left the page unchanged. ` +
        `The last thing I tried was ${describeCall(name, args)}, and it made no difference. ` +
        `The task may need something I cannot reach from this page.`;
      emit({ kind: 'error', text: summary });
      return { summary, succeeded: false, steps: iteration, stopped: false };
    }
  }

  const summary = `Reached the ${settings.maxSteps}-step limit without finishing. Raise the limit in settings, or give me a narrower task.`;
  emit({ kind: 'error', text: summary });
  return { summary, succeeded: false, steps: iteration, stopped: false };
}

interface ExecuteContext {
  tabId: number;
  lastElements: InteractiveElement[];
  settings: Settings;
  canSee: boolean;
  signal: AbortSignal;
  requestConfirmation: (description: string) => Promise<boolean>;
}

interface ExecuteOutcome {
  text: string;
  tabId?: number;
  elements?: InteractiveElement[];
  images?: string[];
}

async function execute(name: string, args: Record<string, unknown>, ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const { tabId, settings } = ctx;
  const elementFor = (ref: number | null) => ctx.lastElements.find((el) => el.ref === ref);

  const gate = async (assessment: { risky: boolean; reason: string }): Promise<string | null> => {
    if (!assessment.risky || !settings.confirmRiskyActions) return null;
    const approved = await ctx.requestConfirmation(assessment.reason);
    return approved ? null : `Blocked: the user declined this action (${assessment.reason}) Choose a different approach.`;
  };

  switch (name) {
    case 'click': {
      const ref = argInt(args, 'ref');
      if (ref === null) return { text: 'Error: click needs a ref, e.g. {"ref": 12}.' };
      const blocked = await gate(assessClick(elementFor(ref)));
      if (blocked) return { text: blocked };
      const result = await tabs.performAction(tabId, { kind: 'click', ref });
      return withObservation(ctx, result.detail, { settle: true });
    }

    case 'type_text': {
      const ref = argInt(args, 'ref');
      const text = argString(args, 'text');
      if (ref === null || text === null) return { text: 'Error: type_text needs a ref and text.' };
      const submit = argBool(args, 'submit', false);
      const blocked = await gate(assessTyping(elementFor(ref), submit));
      if (blocked) return { text: blocked };
      const result = await tabs.performAction(tabId, { kind: 'type', ref, text, submit });
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
      const current = await chrome.tabs.get(tabId).catch(() => null);
      const blocked = await gate(assessNavigation(url, current?.url ?? ''));
      if (blocked) return { text: blocked };
      await tabs.navigateTab(tabId, url);
      return withObservation(ctx, `Navigated to ${url}.`);
    }

    case 'open_tab': {
      const url = argString(args, 'url');
      if (!url) return { text: 'Error: open_tab needs a url.' };
      if (isBlockedUrl(url)) return { text: `Blocked: ${url} is not a page an extension may drive.` };
      const blocked = await gate(assessNavigation(url, ''));
      if (blocked) return { text: blocked };
      const tab = await tabs.openTab(url);
      if (!tab.id) return { text: 'Error: the new tab could not be opened.' };
      return withObservation({ ...ctx, tabId: tab.id }, `Opened ${url} in a new tab.`, { newTabId: tab.id });
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
      return { text: wrapUntrusted('transcript', formatTranscript(cues, 30000)) };
    }

    case 'observe':
      return withObservation(ctx, 'Re-read the page.');

    case 'wait': {
      const ms = Math.min(10000, Math.max(0, argInt(args, 'ms') ?? 1000));
      await tabs.performAction(tabId, { kind: 'wait', ms });
      return withObservation(ctx, `Waited ${ms}ms.`);
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

  if (opts.settle) {
    // A click or a submit may start a navigation; give it a chance to commit
    // before we describe the page, or we describe the page being left behind.
    await tabs.waitForLoad(tabId, 8000);
  }

  try {
    const observation = await tabs.observePage(tabId);
    return {
      text: `${detail}\n\n${renderObservation(observation)}`,
      tabId,
      elements: observation.elements,
    };
  } catch (error) {
    return { text: `${detail}\n\nCould not read the page afterwards: ${errorText(error)}`, tabId };
  }
}

export function renderObservation(observation: Observation, label = 'Page now'): string {
  const scroll = `${Math.round(observation.scrollProgress * 100)}% down the page`;
  return [
    `${label}: ${observation.title}`,
    `URL: ${observation.url} (${scroll})`,
    '',
    'Interactive elements:',
    formatElements(observation.elements),
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
