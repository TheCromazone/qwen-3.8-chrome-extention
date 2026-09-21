# Qwen Browser Agent

A Chrome extension that answers questions about the page you are on, and runs
long browser tasks for you — powered by a Qwen model running locally on your own
machine through [Ollama](https://ollama.com). Nothing leaves your computer.

It covers what Chrome's "Ask Gemini" does (ask about this page, summarise it,
pull an answer out of a video) and adds an agent mode that clicks through sites
on its own to get something done.

## Two modes

**Ask** — one question, one answer, about the page in front of you. The
extension pulls the readable text out of the page, adds your selection if you
have one, and adds the video transcript if you are on YouTube, then streams the
answer into the side panel. No clicking, no loop; it should feel immediate.

**Agent** — you describe a task and it works the page: clicking, typing,
scrolling, following links, opening tabs, reading transcripts. Every step is
shown live in the side panel and there is a Stop button that takes effect
immediately. A task stays on the site it started on unless you name another
site in the task ("compare this with the same boot on amazon.com"), which is
how you tell it where it is allowed to go.

Ask mode also knows about your other tabs: ask "which of my open tabs is the
better deal" and it reads each one and answers with the contents attributed to
their titles, the way Chrome's own assistant does.

## Requirements

- Google Chrome 120 or newer.
- [Ollama](https://ollama.com/download) installed and running.
- A GPU with enough VRAM for the model. The default, `qwen3.8:27b`, is an 18 GB
  download with a 256K native context and reports vision, tool calling and
  thinking. It wants about 24 GB of VRAM; on a 32 GB card it runs comfortably
  with a large context window. Other tags (MLX for Apple Silicon, higher
  precision builds) are listed on [its Ollama page](https://ollama.com/library/qwen3.8).

## Setup

### 1. Pull the model

```bash
ollama pull qwen3.8:27b
```

On an NVIDIA card, `qwen3.8:27b-mtp-q4_K_M` is the same 18 GB and noticeably
faster (multi-token prediction, i.e. speculative decoding); the trade-off is that
its output is no longer bit-for-bit reproducible, which is why the default stays
on the plain tag. The full list of builds is on the
[tags page](https://ollama.com/library/qwen3.8/tags).

Any Ollama model works — set the tag in the extension's settings. The extension
asks Ollama what the model can do (`/api/show`) and adapts: screenshots are only
offered to models that report image support, and models without native tool
calling are driven through a JSON fallback instead.

### 2. Let the extension talk to Ollama

This is the step that trips everyone up. Ollama refuses cross-origin requests by
default, and a Chrome extension counts as cross-origin, so requests fail with a
generic network error until `OLLAMA_ORIGINS` allows it.

**Windows** (PowerShell, then restart Ollama from the tray):

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
```

**macOS**:

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# then quit and reopen the Ollama app
```

**Linux** (systemd):

```bash
sudo systemctl edit ollama
# add, under [Service]:
#   Environment="OLLAMA_ORIGINS=chrome-extension://*"
sudo systemctl restart ollama
```

If you would rather not allow every extension, load the extension first, copy its
ID from `chrome://extensions`, and use `chrome-extension://<that-id>` instead.

### 3. Build and load the extension

```bash
npm install
npm run build
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, and choose the `dist/` folder.

Click the extension's toolbar icon (or press `Ctrl+Shift+Y` / `Cmd+Shift+Y`) to
open the side panel.

### 4. Check the connection

Open the extension's settings (the gear in the side panel) and press **Test
connection**. It should report the model, its size, its context length and what
it can do. If it cannot reach Ollama, the error names the two likely causes:
Ollama is not running, or `OLLAMA_ORIGINS` is not set.

## Settings that matter

Three Ollama defaults will hurt if left alone, so the extension overrides all
three. They are exposed in settings if you want to tune them:

| Setting | Default here | Why |
| --- | --- | --- |
| Context window | 65,536 | Ollama caps context at 4,096 regardless of what the model supports, which silently truncates long pages. Lower this if the model spills out of VRAM. |
| Page text per question | automatic | Sized from the context window (about 147,000 characters at 64k), so a whole long page reaches the model. A flat cap is the one strategy guaranteed to drop a fact near the bottom of a page. |
| Reasoning effort | Low | Qwen3.8 ships at its highest effort and overthinks routine browsing steps badly. |
| Keep model loaded | 30m | Ollama unloads the model after 5 minutes idle, making the next question slow to start. |

Also worth knowing:

- When a page does exceed the budget it is trimmed from the middle, not the
  end, so its conclusions survive.
- **Maximum agent steps** (30) is a hard stop, so a confused run always
  terminates. It usually stops sooner: three actions in a row that leave the
  page unchanged end the run rather than grinding through the remaining steps.
- **Ask before buying, sending, deleting or submitting** is on by default. Leave
  it on — see below. An unanswered prompt is declined after a minute, so a run
  never hangs on it.

## Safety

Three rules are enforced in code and cannot be switched off:

- **A task is fenced to its sites.** The site it started on, plus any site you
  named in the task. A link, a `navigate`, or a page that redirects itself
  anywhere else is refused and recorded, and the agent is told to carry on or
  finish and say which site it needed. It is refused rather than asked about on
  purpose: a confirmation that pops up mid-task with a destination the page
  supplied is exactly how prompt injection succeeds in practice, because people
  click Allow. If a task genuinely needs another site, say so in the task.
- **Password and payment fields are never filled.** Whatever the model was told,
  by you or by the page. The run ends there and asks you to sign in yourself.
  This is checked against the live field in the page as well as in the agent,
  so a stale or misleading element list cannot get around it.
- **Browser-internal pages are off limits.** `chrome://`, other extensions,
  local files.

And one that asks: clicking something that reads as a purchase, a send, a
delete, or a confirmation, or submitting a form that is not a search, waits for
you — with silence counting as no after a minute.

Those checks live in the extension, not in the prompt. A local Qwen has none of
the prompt-injection training the hosted assistants have, and every page it reads
is content someone else wrote — so page text and transcripts are wrapped in
tags, both system prompts say unconditionally that whatever is inside those tags
is data and never an instruction, text that reads like instructions aimed at an
AI agent is additionally flagged inline, and the gates are enforced in code where
the model cannot talk its way past them. Password field contents are never put in the
model's context.

This reduces the risk; it does not eliminate it. Don't turn the confirmations off
on a site where a mistake costs money.

## What the panel remembers

Each run's steps are written to the extension's local storage as they happen,
so closing and reopening the side panel — or Chrome itself — shows the last run
rather than a blank pane. A task only keeps *running* while the panel is open,
though; if you close it mid-task, you will see how far it got and can start
again. The stored copy keeps the first 6,000 characters of each step and the
last 400 steps; it never leaves the machine.

## Development

```bash
npm run build      # bundle into dist/
npm run watch      # rebuild on change (reload the extension in Chrome to pick it up)
npm run typecheck  # tsc --noEmit
npm run test       # node --test
npm run check      # typecheck + test
```

The test suite runs against a mock Ollama server (`test/helpers/mock-ollama.ts`)
that speaks the same endpoints and the same newline-delimited stream format as
the real one, and against real pages in jsdom driven through a fake Chrome API
(`test/helpers/fake-chrome.ts`). That means the agent tests exercise the whole
path — tool call, page action, fresh observation — without a GPU or a browser.
The behaviour against the real model still has to be checked by hand.

`npm run build` also regenerates nothing by hand: run `node scripts/make-icons.mjs`
if you want to change the icon.

There is a QA gauntlet on the `qa/ask-gemini-gauntlet` branch that drives the
built extension through mocked pages against a scripted model. Its test bridge
(`window.__qwenGauntlet`) only exists when `chrome.storage.local` contains
`{ gauntlet: true }`; in ordinary use it is not defined.

## How it works

```
side panel  ──  agent loop, page questions, all Ollama calls
     │
     ├── chrome.scripting ──▶ content script ──  text extraction, element index,
     │                                            actions, YouTube transcripts
     └── fetch ─────────────▶ Ollama (localhost:11434)

service worker  ──  opens the side panel. Nothing else.
```

A few decisions worth explaining:

**The loop runs in the side panel, not the service worker.** An MV3 service
worker is torn down after about 30 seconds idle, which would kill a long agent
run mid-step. The side panel document lives as long as it is open.

**The model acts on numbered elements, not coordinates.** Each observation gives
it a list like `[12] button "Sign in"`, and it picks a number. It never invents a
selector, and it cannot click somewhere nothing is.

**Every action comes back with a fresh observation.** The result of a click is
the new page's element list, so the model is never working from a stale picture
after a navigation — the numbers are regenerated each time and the newest list is
always the one in front of it. This is what keeps it oriented when a click lands
somewhere unexpected.

**It waits for the page to stop changing before reading it.** `load` fires long
before a client-rendered page has finished drawing, so after anything that can
change the page the extension waits until two structural snapshots taken 300 ms
apart match (capped at 5 s) before it looks. Without this the model perceives a
half-rendered page and picks an element that is about to move, and the failure
looks like model flakiness rather than the timing bug it is.

**A model without tool calling gets a grammar, not just instructions.** Where
Ollama reports native tool support, that is used. Where it does not, the request
carries a JSON schema with a closed enum of action names, so an action that does
not exist cannot be decoded in the first place — which holds a small local model
on the rails much better than asking it to behave. The free-text JSON parser is
still there as a last resort.

**Screenshots are a fallback, not the medium.** Describing the page as structured
text is far faster than making a 27B model read pixels on every step, which
matters when it is running on your own GPU. Screenshots are offered only when the
model reports image support, and only when the model asks for one.

## Limitations

- Chrome does not let extensions run on `chrome://` pages, the Chrome Web Store,
  or other extensions' pages. The agent will say so rather than fail oddly.
- The side panel has to stay open for an agent run to continue.
- YouTube transcripts need captions to exist on the video; auto-generated ones are
  used when there are no manual ones.
- Pages that render everything in a closed shadow root or a cross-origin iframe
  are not visible to the extractor.
