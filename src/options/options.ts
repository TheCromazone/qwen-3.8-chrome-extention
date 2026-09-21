/** Settings page. Reads and writes the same validated shape the runtime uses. */
import { OllamaClient } from '../lib/ollama.ts';
import { coerceSettings, loadSettings, saveSettings } from '../lib/settings.ts';
import { DEFAULT_SETTINGS, type ReasoningEffort, type Settings } from '../lib/types.ts';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

const fields = {
  ollamaUrl: el<HTMLInputElement>('ollamaUrl'),
  model: el<HTMLInputElement>('model'),
  numCtx: el<HTMLInputElement>('numCtx'),
  reasoningEffort: el<HTMLSelectElement>('reasoningEffort'),
  temperature: el<HTMLInputElement>('temperature'),
  keepAlive: el<HTMLInputElement>('keepAlive'),
  pageCharBudget: el<HTMLInputElement>('pageCharBudget'),
  maxSteps: el<HTMLInputElement>('maxSteps'),
  useScreenshots: el<HTMLInputElement>('useScreenshots'),
  useThinking: el<HTMLInputElement>('useThinking'),
  confirmRiskyActions: el<HTMLInputElement>('confirmRiskyActions'),
};

const modelOptions = el<HTMLDataListElement>('model-options');
const probe = el<HTMLSpanElement>('probe');
const saved = el<HTMLSpanElement>('saved');
const visionHint = el<HTMLParagraphElement>('vision-hint');

function render(settings: Settings): void {
  fields.ollamaUrl.value = settings.ollamaUrl;
  fields.model.value = settings.model;
  fields.numCtx.value = String(settings.numCtx);
  fields.reasoningEffort.value = settings.reasoningEffort;
  fields.temperature.value = String(settings.temperature);
  fields.keepAlive.value = settings.keepAlive;
  fields.pageCharBudget.value = String(settings.pageCharBudget);
  fields.maxSteps.value = String(settings.maxSteps);
  fields.useScreenshots.checked = settings.useScreenshots;
  fields.useThinking.checked = settings.useThinking;
  fields.confirmRiskyActions.checked = settings.confirmRiskyActions;
}

function collect(): Settings {
  return coerceSettings({
    ollamaUrl: fields.ollamaUrl.value,
    model: fields.model.value,
    numCtx: Number(fields.numCtx.value),
    reasoningEffort: fields.reasoningEffort.value as ReasoningEffort,
    temperature: Number(fields.temperature.value),
    keepAlive: fields.keepAlive.value,
    pageCharBudget: Number(fields.pageCharBudget.value),
    maxSteps: Number(fields.maxSteps.value),
    useScreenshots: fields.useScreenshots.checked,
    useThinking: fields.useThinking.checked,
    confirmRiskyActions: fields.confirmRiskyActions.checked,
  });
}

function setProbe(text: string, state: 'ok' | 'error' | 'neutral'): void {
  probe.textContent = text;
  probe.classList.toggle('is-ok', state === 'ok');
  probe.classList.toggle('is-error', state === 'error');
}

/** Checks the server is reachable, lists its models, and reports what this one can do. */
async function testConnection(): Promise<void> {
  const settings = collect();
  setProbe('Checking…', 'neutral');
  const client = new OllamaClient(settings.ollamaUrl);

  try {
    const models = await client.listModels();
    modelOptions.replaceChildren(
      ...models.map((model) => {
        const option = document.createElement('option');
        option.value = model.name;
        return option;
      }),
    );

    if (!models.some((m) => m.name === settings.model)) {
      setProbe(
        `Connected, but "${settings.model}" is not pulled. Run: ollama pull ${settings.model}`,
        'error',
      );
      return;
    }

    const capabilities = await client.capabilities(settings.model);
    const can = [
      capabilities.vision ? 'images' : null,
      capabilities.tools ? 'tool calling' : null,
      capabilities.thinking ? 'thinking' : null,
    ].filter(Boolean);

    visionHint.textContent = capabilities.vision
      ? 'This model reports image support, so screenshots will be used when they help.'
      : 'This model does not report image support, so screenshots stay off whatever this is set to.';

    const context = capabilities.contextLength
      ? `, ${capabilities.contextLength.toLocaleString()} token context`
      : '';
    setProbe(
      `${capabilities.model}${capabilities.parameterSize ? ` (${capabilities.parameterSize})` : ''}${context} — ` +
        `${can.length ? can.join(', ') : 'text only'}`,
      'ok',
    );
  } catch (error) {
    setProbe(error instanceof Error ? error.message : String(error), 'error');
  }
}

el<HTMLButtonElement>('save').addEventListener('click', async () => {
  const settings = await saveSettings(collect());
  render(settings); // show the validated values, not the raw input
  saved.textContent = 'Saved.';
  saved.classList.add('is-ok');
  setTimeout(() => {
    saved.textContent = '';
    saved.classList.remove('is-ok');
  }, 2000);
});

el<HTMLButtonElement>('reset').addEventListener('click', () => render(DEFAULT_SETTINGS));
el<HTMLButtonElement>('test').addEventListener('click', () => void testConnection());

render(await loadSettings());
void testConnection();
