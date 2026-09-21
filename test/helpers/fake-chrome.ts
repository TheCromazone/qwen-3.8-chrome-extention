/**
 * A fake of the slice of the Chrome extension API the agent touches, backed by
 * a real jsdom page. `tabs.sendMessage` runs the actual content-script handler,
 * so an agent test exercises the whole path: tool call -> action -> observation.
 */
import { handleCommand, type ContentCommand } from '../../src/content/page-agent.ts';
import { resolveRef } from '../../src/content/elements.ts';
import { withDom, type DomHandle } from './dom.ts';

export interface FakeTab {
  id: number;
  url: string;
  title: string;
  windowId: number;
  status: string;
  active: boolean;
  /** The page this tab shows, keyed by URL. */
  html: string;
}

export interface FakeChromeOptions {
  /** URL -> HTML, so navigation can land on a different page. */
  pages: Record<string, string>;
  startUrl: string;
  /** Further tabs open in the same window, by URL. */
  extraTabs?: string[];
  screenshot?: string;
}

export interface FakeChrome {
  tabs: FakeTab[];
  /** Every action the content script actually performed. */
  restore: () => void;
}

/** What Chrome reports as a loaded tab's title, without mounting the page. */
function titleOf(html: string): string {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
}

export function installFakeChrome(options: FakeChromeOptions): FakeChrome {
  const tabs: FakeTab[] = [
    {
      id: 1,
      url: options.startUrl,
      title: titleOf(options.pages[options.startUrl] ?? ''),
      windowId: 10,
      status: 'complete',
      active: true,
      html: options.pages[options.startUrl] ?? '<html><body>Not found</body></html>',
    },
  ];

  let nextTabId = 2;
  let dom: DomHandle | null = null;
  let mountedTabId: number | null = null;
  const historyOf = new Map<number, string[]>();
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};

  for (const url of options.extraTabs ?? []) {
    const html = options.pages[url] ?? `<html><head><title>Not found</title></head><body>No page at ${url}</body></html>`;
    tabs.push({ id: nextTabId++, url, title: titleOf(html), windowId: 10, status: 'complete', active: false, html });
  }

  /** Swaps the live jsdom document to the given tab's page. */
  const mount = (tab: FakeTab) => {
    if (mountedTabId === tab.id && dom) return;
    dom?.restore();
    dom = withDom(tab.html, tab.url);
    mountedTabId = tab.id;
    tab.title = dom.document.title;
  };

  const tabById = (id: number): FakeTab => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab ${id}`);
    return tab;
  };

  const navigate = (tab: FakeTab, url: string) => {
    historyOf.set(tab.id, [...(historyOf.get(tab.id) ?? []), tab.url]);
    tab.url = url;
    tab.html = options.pages[url] ?? `<html><head><title>Not found</title></head><body>No page at ${url}</body></html>`;
    tab.title = titleOf(tab.html);
    // Force a remount so the next observation sees the new document.
    if (mountedTabId === tab.id) {
      dom?.restore();
      dom = null;
      mountedTabId = null;
    }
  };

  const savedChrome = (globalThis as Record<string, unknown>).chrome;

  (globalThis as Record<string, unknown>).chrome = {
    runtime: { openOptionsPage() {}, sendMessage: async () => undefined },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    tabs: {
      async query(info: { active?: boolean }) {
        return info.active ? tabs.filter((t) => t.active) : tabs;
      },
      async get(id: number) {
        return { ...tabById(id) };
      },
      async update(id: number, props: { url?: string; active?: boolean }) {
        const tab = tabById(id);
        if (props.url) navigate(tab, props.url);
        if (props.active) {
          for (const t of tabs) t.active = t.id === id;
        }
        return { ...tab };
      },
      async goBack(id: number) {
        const tab = tabById(id);
        const previous = historyOf.get(id)?.pop();
        if (!previous) return;
        tab.url = previous;
        tab.html = options.pages[previous] ?? '<html><body>Not found</body></html>';
        if (mountedTabId === id) {
          dom?.restore();
          dom = null;
          mountedTabId = null;
        }
      },
      async create(props: { url: string }) {
        const tab: FakeTab = {
          id: nextTabId++,
          url: props.url,
          title: titleOf(options.pages[props.url] ?? ''),
          windowId: 10,
          status: 'complete',
          active: true,
          html: options.pages[props.url] ?? '<html><body>Not found</body></html>',
        };
        for (const t of tabs) t.active = false;
        tabs.push(tab);
        return { ...tab };
      },
      async sendMessage(id: number, message: ContentCommand) {
        const tab = tabById(id);
        mount(tab);

        // jsdom does not follow links or run inline scripts, so resolve where a
        // click would go — an anchor's href, or a `data-nav` attribute standing
        // in for a script that sets location — and drive the navigation ourselves.
        const href =
          message.command === 'act' && message.action.kind === 'click'
            ? hrefOf(resolveRef(message.action.ref))
            : null;

        const result = await handleCommand(message);
        if (href) navigate(tab, href);
        return result;
      },
      async captureVisibleTab() {
        return `data:image/png;base64,${options.screenshot ?? 'aGk='}`;
      },
      onUpdated: {
        addListener() {},
        removeListener() {},
      },
    },
    storage: {
      sync: {
        async get() {
          return {};
        },
        async set() {},
      },
      local: {
        async get(key: string) {
          return { [key]: local[key] };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
      session: {
        async get(key: string) {
          return { [key]: session[key] };
        },
        async set(values: Record<string, unknown>) {
          Object.assign(session, values);
        },
        async remove(key: string) {
          delete session[key];
        },
      },
      onChanged: { addListener() {} },
    },
  };

  function hrefOf(element: Element | null): string | null {
    const href = element?.getAttribute('href') ?? element?.getAttribute('data-nav');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
    try {
      return new URL(href, tabById(mountedTabId ?? 1).url).toString();
    } catch {
      return null;
    }
  }

  return {
    tabs,
    restore() {
      dom?.restore();
      (globalThis as Record<string, unknown>).chrome = savedChrome;
    },
  };
}
