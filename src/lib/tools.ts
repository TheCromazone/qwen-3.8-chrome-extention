/** The agent's tool surface: schema for the model, plus argument coercion. */
import type { ToolSchema } from './types.ts';

export const FINISH_TOOL = 'finish';

export function agentTools(canSee: boolean): ToolSchema[] {
  const tools: ToolSchema[] = [
    tool('click', 'Click an element from the current observation, addressed by its number.', {
      ref: { type: 'integer', description: 'The element number, e.g. 12 for [12].' },
    }, ['ref']),

    tool('type_text', 'Type text into a text box or search field, optionally submitting it.', {
      ref: { type: 'integer', description: 'The element number of the text box.' },
      text: { type: 'string', description: 'The text to type. Replaces whatever is already there.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards to submit. Defaults to false.' },
    }, ['ref', 'text']),

    tool('select_option', 'Choose an option in a dropdown.', {
      ref: { type: 'integer', description: 'The element number of the dropdown.' },
      value: { type: 'string', description: 'The option label or value to select.' },
    }, ['ref', 'value']),

    tool('scroll', 'Scroll the page to bring more content into view.', {
      direction: { type: 'string', description: 'Which way to scroll.', enum: ['up', 'down', 'top', 'bottom'] },
    }, ['direction']),

    tool('press_key', 'Press a single key, such as Enter, Escape, Tab or ArrowDown.', {
      key: { type: 'string', description: 'The key name.' },
    }, ['key']),

    tool('find_text', 'Search the current page for text. Use this to confirm what is on the page before acting.', {
      text: { type: 'string', description: 'The text to look for.' },
    }, ['text']),

    tool('navigate', 'Go to a URL in the current tab.', {
      url: { type: 'string', description: 'The full URL, including https://.' },
    }, ['url']),

    tool('open_tab', 'Open a URL in a new tab and switch to it.', {
      url: { type: 'string', description: 'The full URL, including https://.' },
    }, ['url']),

    tool('list_tabs', 'List the open tabs in this window, with their numbers.', {}),

    tool('switch_tab', 'Switch to an open tab by the number shown in list_tabs.', {
      index: { type: 'integer', description: 'The tab number from list_tabs.' },
    }, ['index']),

    tool('get_transcript', 'Read the transcript of the YouTube video in the current tab, with timestamps.', {}),

    tool('observe', 'Re-read the current page. Use this after waiting, or when you think the page has changed.', {}),

    tool('wait', 'Wait for the page to settle, up to 10 seconds.', {
      ms: { type: 'integer', description: 'Milliseconds to wait.' },
    }, ['ms']),

    tool(
      FINISH_TOOL,
      'End the task. Call this with the answer when you are done, or with an explanation if you are stuck.',
      {
        summary: { type: 'string', description: 'The answer to the task, or why you could not complete it.' },
        succeeded: { type: 'boolean', description: 'Whether the task was actually completed. Defaults to true.' },
      },
      ['summary'],
    ),
  ];

  if (canSee) {
    tools.splice(
      tools.length - 1,
      0,
      tool('take_screenshot', 'Capture what the page looks like right now, for anything the text does not convey.', {}),
    );
  }

  return tools;
}

function tool(
  name: string,
  description: string,
  properties: ToolSchema['function']['parameters']['properties'],
  required: string[] = [],
): ToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** A compact rendering of the tool list for models driven by the JSON fallback. */
export function describeTools(tools: ToolSchema[]): string {
  return tools
    .map((t) => {
      const params = Object.entries(t.function.parameters.properties)
        .map(([key, spec]) => {
          const required = t.function.parameters.required?.includes(key) ? '' : '?';
          const options = spec.enum ? ` (${spec.enum.join('|')})` : '';
          return `${key}${required}: ${spec.type}${options}`;
        })
        .join(', ');
      return `- ${t.function.name}(${params}) — ${t.function.description}`;
    })
    .join('\n');
}

/**
 * Models hand back arguments loosely typed — "12" for a number, "true" for a
 * boolean, sometimes a JSON string for the whole object. Normalise before use.
 */
export function coerceArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return coerceArgs(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

export function argInt(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function argBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}
