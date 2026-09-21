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
    keepAlive:
      typeof raw.keepAlive === 'string' && /^\d+(\.\d+)?(ms|s|m|h)?$|^-1$/.test(raw.keepAlive.trim())
        ? raw.keepAlive.trim()
        : DEFAULT_SETTINGS.keepAlive,
    maxSteps: Math.round(clampNumber(raw.maxSteps, 1, 200, DEFAULT_SETTINGS.maxSteps)),
    pageCharBudget: Math.round(clampNumber(raw.pageCharBudget, 1000, 200000, DEFAULT_SETTINGS.pageCharBudget)),
    useScreenshots: typeof raw.useScreenshots === 'boolean' ? raw.useScreenshots : DEFAULT_SETTINGS.useScreenshots,
    useThinking: typeof raw.useThinking === 'boolean' ? raw.useThinking : DEFAULT_SETTINGS.useThinking,
    confirmRiskyActions:
      typeof raw.confirmRiskyActions === 'boolean'
        ? raw.confirmRiskyActions
        : DEFAULT_SETTINGS.confirmRiskyActions,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
