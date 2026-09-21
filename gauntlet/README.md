# The gauntlet

A QA harness that runs the extension through twenty-three real browser tasks
drawn from what Ask Gemini in Chrome actually does, and reports a scoreboard.

`GAUNTLET.md` is the task list and what each one has to do to pass.
`CONTRACT.md` is the (small) surface the harness needs from the extension.

## Running it

```bash
cd gauntlet
npm install
npm run gauntlet          # mock mode, against the extension in this repo
```

Mock mode needs no GPU and no model. It points the extension at a scripted
Ollama and measures the harness: page extraction, the element index, whether an
action actually executed, whether a gate held, whether injected page text was
fenced. It is what runs in CI and what a code change should be checked against.

## Running it against the real model

On the machine with the GPU:

```bash
ollama serve                       # if it is not already running
ollama pull qwen3.8:27b
cd gauntlet && npm install
npm run gauntlet:real
```

Real mode puts the actual model in the loop and measures answer quality and
speed. The extension is pointed at a small recording proxy in front of Ollama
rather than at Ollama directly, so the same prompt-level pass conditions hold in
both modes and you get real latency numbers out of it.

Results land in `results/scoreboard.real.md`, and the run prints what changed
since the last one.

### If real mode cannot reach Ollama

`npm run gauntlet:real` checks first and tells you. The other thing that bites
on a fresh machine is that Ollama refuses the extension's origin: a Chrome
extension is its own origin and Ollama only answers origins named in
`OLLAMA_ORIGINS`.

```bash
# Linux/macOS
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

```powershell
# Windows
setx OLLAMA_ORIGINS "chrome-extension://*"
# then restart Ollama
```

G21 exists to make sure the extension tells you this itself rather than showing
a bare "Failed to fetch".

## Useful flags

```bash
node scripts/run.js --mode=mock --only=G17,G18     # just these tasks
node scripts/run.js --mode=mock --headed           # watch it (needs a display)
node scripts/run.js --extension=../dist            # point at a specific build
node scripts/loop.js --branch=feat/qwen-browser-agent   # re-run on every push
```

## What "passing" means

Twenty-one of the twenty-three tasks run in mock mode; twenty-one run in real
mode. Mock results are honest about plumbing and say nothing about whether the
model is any good. Real results are the ones that answer Matthew's question,
and they can only be produced on his machine — no cloud session can reach his
Ollama.

`stub-extension/` is a reference implementation of `CONTRACT.md`. It exists so
the harness can be proven independently of the real build: if the gauntlet is
green against the stub and red against the extension, the extension has a
problem. It is not shipped and is not a product.
