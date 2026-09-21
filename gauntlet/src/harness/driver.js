// The only file that touches the extension.
//
// Everything a test does to the extension goes through here: seeding settings,
// asking a page question, running an agent task, reading the journal, answering
// a confirmation gate. If the real build's shape differs from CONTRACT.md,
// this is the file to change; the tests should not need to know.

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
  }

  /** Open the side panel document as an ordinary tab and wait for it to be usable. */
  async openPanel() {
    this.panel = await this.context.newPage();
    await this.panel.goto(this.sidePanelUrl, { waitUntil: 'domcontentloaded' });
    await this.panel.waitForFunction(() => Boolean(window.__qwenGauntlet), null, { timeout: 15000 }).catch(() => {
      throw new Error(
        'The side panel did not expose window.__qwenGauntlet. Either the extension does not ' +
        'implement the test bridge (see CONTRACT.md §3) or it did not see {gauntlet: true} in storage.'
      );
    });
    return this.panel;
  }

  /**
   * Write settings and the gauntlet flag before the panel opens. Runs in an
   * extension page context so chrome.storage is reachable.
   */
  async seedSettings(settings) {
    const seeder = await this.context.newPage();
    try {
      await seeder.goto(this.sidePanelUrl, { waitUntil: 'domcontentloaded' });
      await seeder.evaluate(
        (s) =>
          new Promise((resolve) => {
            chrome.storage.local.set({ settings: s, gauntlet: true }, () => resolve(true));
          }),
        settings
      );
    } finally {
      await seeder.close().catch(() => {});
    }
  }

  async reset() {
    await this.panel?.evaluate(() => window.__qwenGauntlet.reset());
  }

  /** Page-question mode: one streaming call, no agent machinery. */
  async ask(question, { timeout = 120000 } = {}) {
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
    await this.panel.evaluate(
      ([t, opts]) => {
        window.__qwenGauntletRun = window.__qwenGauntlet.runTask(t, opts);
      },
      [task, { allowOrigins }]
    );
  }

  async awaitStartedTask({ timeout = 300000 } = {}) {
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
    return this.panel.evaluate(() => window.__qwenGauntlet.getJournal());
  }

  async pendingConfirmations() {
    return this.panel.evaluate(() => window.__qwenGauntlet.pendingConfirmations());
  }

  async waitForConfirmation({ timeout = 60000 } = {}) {
    await this.panel.waitForFunction(
      () => window.__qwenGauntlet.pendingConfirmations().length > 0,
      null,
      { timeout }
    );
    const pending = await this.pendingConfirmations();
    return pending[0];
  }

  async approve(id) {
    await this.panel.evaluate((i) => window.__qwenGauntlet.approve(i), id);
  }

  async deny(id) {
    await this.panel.evaluate((i) => window.__qwenGauntlet.deny(i), id);
  }

  /** Drive the real UI rather than the bridge — used by the error-surface test. */
  async askThroughUi(question) {
    await this.panel.locator('[data-testid="qwen-input"]').fill(question);
    await this.panel.locator('[data-testid="qwen-send"]').click();
  }

  async visibleError({ timeout = 12000 } = {}) {
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
