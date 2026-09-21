/** Settings persistence. Stored in chrome.storage.sync so they follow the profile. */
import { DEFAULT_SETTINGS, type Settings } from './types.ts';

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(KEY);
  return coerceSettings(stored?.[KEY]);
}

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const next = coerceSettings({ ...(await loadSettings()), ...partial });
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(handler: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[KEY]) return;
    handler(coerceSettings(changes[KEY].newValue));
  });
}

/**
 * Settings arrive from storage and from the options form, so every field is
 * validated rather than trusted. Out-of-range numbers fall back to the default.
 */
export function coerceSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const url = typeof raw.ollamaUrl === 'string' && raw.ollamaUrl.trim() ? raw.ollamaUrl.trim() : DEFAULT_SETTINGS.ollamaUrl;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_SETTINGS.model;

  return {
    ollamaUrl: url.replace(/\/+$/, ''),
    model,
    temperature: clampNumber(raw.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    numCtx: Math.round(clampNumber(raw.numCtx, 2048, 262144, DEFAULT_SETTINGS.numCtx)),
    reasoningEffort:
      raw.reasoningEffort === 'low' || raw.reasoningEffort === 'medium' || raw.reasoningEffort === 'high'
        ? raw.reasoningEffort
        : DEFAULT_SETTINGS.reasoningEffort,
    keepAlive: coerceKeepAlive(raw.keepAlive),
    maxSteps: Math.round(clampNumber(raw.maxSteps, 1, 200, DEFAULT_SETTINGS.maxSteps)),
    pageCharBudget: coercePageBudget(raw.pageCharBudget),
    useScreenshots: typeof raw.useScreenshots === 'boolean' ? raw.useScreenshots : DEFAULT_SETTINGS.useScreenshots,
    useThinking: typeof raw.useThinking === 'boolean' ? raw.useThinking : DEFAULT_SETTINGS.useThinking,
    confirmRiskyActions:
      typeof raw.confirmRiskyActions === 'boolean'
        ? raw.confirmRiskyActions
        : DEFAULT_SETTINGS.confirmRiskyActions,
  };
}

/** 0 is "automatic"; anything else must be a usable cap. */
function coercePageBudget(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(Math.min(400000, Math.max(1000, n)));
}

/** Ollama accepts durations ("30m") or seconds as a number; -1 means never unload. */
function coerceKeepAlive(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(text) ? text : DEFAULT_SETTINGS.keepAlive;
}

/**
 * The page-text budget actually used. Roughly 3 characters per token is a safe
 * floor for prose, and three quarters of the window leaves room for the prompt,
 * the conversation and the answer.
 */
export function resolvePageBudget(settings: Settings): number {
  if (settings.pageCharBudget > 0) return settings.pageCharBudget;
  return Math.min(400000, Math.floor(settings.numCtx * 3 * 0.75));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
