# What the gauntlet needs from the extension

The gauntlet drives the extension from outside. To do that it needs a small,
stable surface. This is that surface. It is deliberately tiny, and everything in
it is either something the extension needs anyway or a test-only hook that is
inert unless explicitly switched on.

If the extension's real shape differs, change `src/harness/driver.js` — it is the
only file that touches the extension, on purpose — and leave the tests alone.

## 1. A side panel document reachable as a page

`sidepanel.html` at the extension root. Playwright cannot open Chrome's real side
panel, so it opens `chrome-extension://<id>/sidepanel.html` as an ordinary tab.
The panel must work there: it must not assume `chrome.sidePanel` is its host.

That is not a testing tax. A panel that works as a tab is also a panel that
survives being popped out, and the architecture note already puts the agent loop
in this document rather than the service worker.

## 2. Settings in `chrome.storage.local`

Under key `settings`:

```js
{
  ollamaUrl: "http://127.0.0.1:11434",  // gauntlet repoints this
  model: "qwen3.8:27b",
  numCtx: 65536,
  reasoningEffort: "medium",
  keepAlive: -1
}
```

The gauntlet writes this before each run. Nothing else about settings storage is
assumed.

## 3. A test bridge, off by default

When `chrome.storage.local` contains `{ gauntlet: true }`, the side panel exposes
`window.__qwenGauntlet` with:

```ts
ask(question: string): Promise<{ answer: string }>
runTask(task: string, opts?: { allowOrigins?: string[] }): Promise<TaskResult>
getJournal(): JournalStep[]
pendingConfirmations(): Confirmation[]
approve(id: string): void
deny(id: string): void
reset(): void
```

```ts
type JournalStep = {
  n: number
  action: "click" | "type" | "navigate" | "scroll" | "read" | "screenshot" | "answer"
  ref?: string          // ref into the snapshot, never coordinates
  value?: string
  observation?: string
  blocked?: "off-origin" | "credential-field" | "needs-confirmation"
  at: number            // epoch ms
}

type TaskResult = {
  answer: string
  journal: JournalStep[]
  flags: string[]       // e.g. "prompt-injection-detected"
}

type Confirmation = { id: string, action: JournalStep, reason: string }
```

Without `{ gauntlet: true }` the bridge must not be defined at all. A remote page
cannot reach a side panel document's globals anyway, but the flag keeps the
surface honest.

## 4. `data-testid` on four UI elements

For the tests that drive the real UI rather than the bridge:

| testid | element |
|---|---|
| `qwen-input` | the question/task textarea |
| `qwen-send` | the send button |
| `qwen-messages` | the message list container |
| `qwen-error` | the error banner |

## 5. No direct Ollama calls outside the configured URL

Every request to the model goes to `settings.ollamaUrl`. The gauntlet points that
at its own server, which either scripts the responses (mock mode) or forwards to
the real Ollama and records what went past (real mode). That is how prompt-level
pass conditions — "the buried fact reached the model", "the injected text was
fenced as data" — can be asserted identically in both modes.

An extension that hardcodes `localhost:11434` anywhere breaks this and will fail
the gauntlet on the prompt-level conditions.

## Reference implementation

`stub-extension/` implements this contract and nothing else: it is a deliberately
shallow extension that extracts pages, keeps a journal, gates actions and fences
untrusted text. It exists so the harness can be proven correct independently of
the real build, and so the contract is executable rather than prose. It is not a
product and is not shipped.
