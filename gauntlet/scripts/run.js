#!/usr/bin/env node
// One command to run the gauntlet.
//
//   npm run gauntlet          mock mode, against ../ (the extension in this repo)
//   npm run gauntlet:real     real mode, against Ollama on localhost:11434
//   npm run gauntlet:stub     mock mode, against the reference stub extension
//
// Flags: --mode=mock|real  --extension=PATH  --only=G01,G17  --headed  --upstream=URL
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Extensions need a real browser window. With no display, re-exec the whole run
// under Xvfb rather than trying to load an extension into headless_shell, which
// silently gives you a browser with no extension in it.
if (!process.env.DISPLAY && !process.env.GAUNTLET_NO_XVFB) {
  const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
  if (xvfb.status === 0 && xvfb.stdout.trim()) {
    const res = spawnSync(
      xvfb.stdout.trim(),
      ['-a', '-s', '-screen 0 1280x1024x24', process.execPath, ...process.argv.slice(1)],
      { stdio: 'inherit', env: { ...process.env, GAUNTLET_NO_XVFB: '1' } }
    );
    process.exit(res.status ?? 1);
  }
  console.error(
    '\n  No DISPLAY and no xvfb-run. Chrome extensions do not load in headless mode,\n' +
    '  so the gauntlet needs one or the other. On a desktop machine just run it\n' +
    '  normally; on a server, install xvfb.\n'
  );
}
import { TASKS } from '../tests/index.js';
import { runGauntlet } from '../src/harness/runner.js';
import { writeScoreboard, summarise, diffRuns } from '../src/harness/scoreboard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAUNTLET_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(GAUNTLET_DIR, '..');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * Where the extension is. Default: wherever the real build put its manifest,
 * searched shallowly so this keeps working whether it lands at the repo root,
 * under extension/, or under dist/ after a build step.
 */
function findExtension(explicit) {
  if (explicit) {
    const p = path.resolve(GAUNTLET_DIR, explicit);
    if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
    throw new Error(`No manifest.json under ${p}`);
  }
  const candidates = ['dist', 'extension', 'src', '.', 'build'].map((c) => path.resolve(REPO_DIR, c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  }
  const stub = path.resolve(GAUNTLET_DIR, 'stub-extension');
  console.error(
    '\n  No built extension found in this repo (looked for manifest.json in dist/, extension/, src/, build/ and the repo root).\n' +
    '  Running against the reference stub instead, which proves the harness but tells you nothing about the real build.\n' +
    '  Point at the real one with --extension=PATH once it exists.\n'
  );
  return stub;
}

const mode = arg('mode', 'mock');
const only = arg('only') ? arg('only').split(',').map((s) => s.trim().toUpperCase()) : null;
const extensionPath = findExtension(arg('extension'));
const upstream = arg('upstream', process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434');

if (mode === 'real') {
  try {
    const res = await fetch(upstream + '/api/tags', { signal: AbortSignal.timeout(4000) });
    const { models } = await res.json();
    const names = (models ?? []).map((m) => m.name);
    console.log(`Ollama at ${upstream} is up. Models: ${names.join(', ') || '(none)'}`);
    if (!names.some((n) => n.startsWith('qwen3.8'))) {
      console.error(`\n  Warning: no qwen3.8 tag is pulled. Run:  ollama pull qwen3.8:27b\n`);
    }
  } catch (err) {
    console.error(
      `\n  Real mode needs Ollama running at ${upstream}, and it is not answering (${err.message}).\n` +
      `  Start it with:  ollama serve\n` +
      `  Then:           ollama pull qwen3.8:27b\n`
    );
    process.exit(2);
  }
}

console.log(`\nGauntlet — ${mode} mode`);
console.log(`Extension: ${extensionPath}`);
console.log(`Tasks:     ${only ? only.join(', ') : TASKS.length + ' total'}\n`);

const run = await runGauntlet({
  tasks: TASKS,
  mode,
  extensionPath,
  headless: !flag('headed'),
  only,
  upstream,
  onResult: (r) => {
    const mark = r.status === 'pass' ? '  pass' : r.status === 'fail' ? '  FAIL' : '  skip';
    console.log(`${mark}  ${r.id} ${r.name}  ${(r.ms / 1000).toFixed(1)}s${r.why ? '\n        ' + r.why : ''}`);
  }
});

const resultsDir = path.join(GAUNTLET_DIR, 'results');
const { previous } = writeScoreboard(run, resultsDir);
const s = summarise(run);

console.log(`\n${s.pass} passed, ${s.fail} failed, ${s.skip} skipped — score ${(s.score * 100).toFixed(0)}%`);
if (previous) {
  const d = diffRuns(previous, run);
  if (d.fixed.length) console.log(`Fixed since last run: ${d.fixed.join(', ')}`);
  if (d.broken.length) console.log(`Broke since last run: ${d.broken.join(', ')}`);
}
console.log(`Scoreboard: results/scoreboard.${mode}.md\n`);

process.exit(s.fail > 0 ? 1 : 0);
