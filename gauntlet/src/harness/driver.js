// The only file that touches the extension.
//
// Everything a test does to the extension goes through here: seeding settings,
// asking a page question, running an agent task, reading the journal, answering
// a confirmation gate. If the real build's shape differs from CONTRACT.md,
// this is the file to change; the tests should not need to know.

import { UiBackend } from './ui-backend.js';

export class ExtensionDriver {
  /**
   * @param {import('@playwright/test').BrowserContext} context
   * @param {{extensionId: string, sidePanelUrl: string}} info
   */
  constructor(context, info) {
    this.context = context;
    this.extensionId = info.extensionId;
    this.sidePanelUrl = info.sidePanelUrl;
    /** @type {import('@playwright/test').Page | null} */
    this.panel = null;
    /** Set when the build has no test bridge and the UI is being driven instead. */
    this.ui = null;
  }

  /**
   * Open the side panel document as an ordinary tab.
   *
   * If the build exposes the test bridge, use it. If it does not, fall back to
   * driving the real UI — lossier, but it runs against the build as it is
   * rather than refusing to test it.
   */
  async openPanel() {
    this.panel = await this.context.newPage();
    await this.panel.goto(this.sidePanelUrl, { waitUntil: 'domcontentloaded' });

    // The real side panel is not a tab, so the page the user is looking at
    // stays the active one. Opening the panel as a tab would make the panel
    // itself active, and an extension that then reads "the current tab" reads
    // its own chrome-extension: page. Hand focus back to the content tab so
    // the extension sees what a user's Chrome would show it.
    await this.focusContent();

    const hasBridge = await this.panel
      .waitForFunction(() => Boolean(window.__qwenGauntlet), null, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);

    if (hasBridge) {
      this.ui = null;
    } else {
      await this.panel.waitForSelector('#send, [data-testid="qwen-send"]', { timeout: 15000 }).catch(() => {
        throw new Error(
          'The side panel exposed neither window.__qwenGauntlet (CONTRACT.md §3) nor a send ' +
          'button this harness can find, so there is no way to drive it.'
        );
      });
      this.ui = new UiBackend(this.panel);
    }
    return this.panel;
  }

  /** Bring the most recently opened http(s) page to the front. */
  async focusContent() {
    const pages = this.context.pages().filter((p) => /^https?:/.test(p.url()));
    const front = pages[pages.length - 1];
    if (front) await front.bringToFront().catch(() => {});
    return front ?? null;
  }

  /** True when the build has no test bridge, so structured-journal checks are unavailable. */
  get bridgeMissing() {
    return this.ui !== null;
  }

  /**
   * Write settings and the gauntlet flag before the panel opens. Runs in an
   * extension page context so chrome.storage is reachable.
   */
  async seedSettings(settings) {
    const seeder = await this.context.newPage();
    try {
      await seeder.goto(this.sidePanelUrl, { waitUntil: 'domcontentloaded' });
      // Builds differ on where settings live and on the exact field names, so
      // write a superset to both areas rather than guessing one.
      await seeder.evaluate(
        (s) =>
          new Promise((resolve) => {
            const payload = { settings: s, gauntlet: true };
            let left = 2;
            const done = () => { if (--left === 0) resolve(true); };
            chrome.storage.local.set(payload, done);
            if (chrome.storage.sync) chrome.storage.sync.set(payload, done); else done();
          }),
        settings
      );
    } finally {
      await seeder.close().catch(() => {});
    }
  }

  async reset() {
    if (this.ui) return; // a fresh browser per task already gives a clean slate
    await this.panel?.evaluate(() => window.__qwenGauntlet.reset());
  }

  /** Page-question mode: one streaming call, no agent machinery. */
  async ask(question, { timeout = 120000 } = {}) {
    await this.focusContent();
    if (this.ui) return this.ui.ask(question, { timeout });
    return this.panel.evaluate(
      ([q, t]) =>
        Promise.race([
          window.__qwenGauntlet.ask(q),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ask() timed out after ' + t + 'ms')), t))
        ]),
      [question, timeout]
    );
  }

  /** Agent mode. */
  async runTask(task, { allowOrigins = [], timeout = 300000 } = {}) {
    await this.focusContent();
    if (this.ui) return this.ui.runTask(task, { timeout });
    return this.panel.evaluate(
      ([t, opts, ms]) =>
        Promise.race([
          window.__qwenGauntlet.runTask(t, opts),
          new Promise((_, rej) => setTimeout(() => rej(new Error('runTask() timed out after ' + ms + 'ms')), ms))
        ]),
      [task, { allowOrigins }, timeout]
    );
  }

  /** Start a task without waiting for it, so a gate can be inspected mid-run. */
  async startTask(task, { allowOrigins = [] } = {}) {
    await this.focusContent();
    if (this.ui) return void (this._uiTask = this.ui.runTask(task, { timeout: 300000 }));
    await this.panel.evaluate(
      ([t, opts]) => {
        window.__qwenGauntletRun = window.__qwenGauntlet.runTask(t, opts);
      },
      [task, { allowOrigins }]
    );
  }

  async awaitStartedTask({ timeout = 300000 } = {}) {
    if (this.ui) return this._uiTask;
    return this.panel.evaluate(
      (ms) =>
        Promise.race([
          window.__qwenGauntletRun,
          new Promise((_, rej) => setTimeout(() => rej(new Error('task timed out after ' + ms + 'ms')), ms))
        ]),
      timeout
    );
  }

  async journal() {
    if (this.ui) return this.ui.journal();
    return this.panel.evaluate(() => window.__qwenGauntlet.getJournal());
  }

  async pendingConfirmations() {
    if (this.ui) return this.ui.pendingConfirmations();
    return this.panel.evaluate(() => window.__qwenGauntlet.pendingConfirmations());
  }

  async waitForConfirmation({ timeout = 60000 } = {}) {
    if (this.ui) return this.ui.waitForConfirmation({ timeout });
    await this.panel.waitForFunction(
      () => window.__qwenGauntlet.pendingConfirmations().length > 0,
      null,
      { timeout }
    );
    const pending = await this.pendingConfirmations();
    return pending[0];
  }

  /**
   * Answer confirmations as they appear, without blocking the run.
   *
   * A task can raise a gate the test did not expect, and an unanswered gate
   * looks exactly like a hang. Every confirmation answered here is recorded, so
   * a test can assert on what the extension chose to ask about — which is
   * itself a finding when the action came from the page rather than the user.
   */
  autoRespondConfirmations(decision = 'deny') {
    const seen = [];
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        const pending = await this.pendingConfirmations().catch(() => []);
        for (const c of pending) {
          seen.push({ at: Date.now(), reason: c.reason, decision });
          if (decision === 'approve') await this.approve(c.id).catch(() => {});
          else await this.deny(c.id).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return {
      seen,
      stop: async () => { stopped = true; await loop.catch(() => {}); return seen; }
    };
  }

  async approve(id) {
    if (this.ui) return this.ui.approve();
    await this.panel.evaluate((i) => window.__qwenGauntlet.approve(i), id);
  }

  async deny(id) {
    if (this.ui) return this.ui.deny();
    await this.panel.evaluate((i) => window.__qwenGauntlet.deny(i), id);
  }

  /** Drive the real UI rather than the bridge — used by the error-surface test. */
  async askThroughUi(question) {
    await this.focusContent();
    await this.panel.locator('#input, [data-testid="qwen-input"]').first().fill(question);
    await this.panel.locator('#send, [data-testid="qwen-send"]').first().click();
  }

  async visibleError({ timeout = 12000 } = {}) {
    if (this.ui) return this.ui.visibleError({ timeout });
    const banner = this.panel.locator('[data-testid="qwen-error"]');
    await banner.waitFor({ state: 'visible', timeout });
    return (await banner.textContent())?.trim() ?? '';
  }

  /** Kill the panel document, the way closing the side panel would. */
  async closePanel() {
    await this.panel?.close();
    this.panel = null;
  }
}
