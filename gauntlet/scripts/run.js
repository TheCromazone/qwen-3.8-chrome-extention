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
import { prepareExtension } from './prepare-extension.js';
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
 * Where the extension is.
 *
 * The gauntlet lives on its own branch, so a checkout of it does not contain
 * the extension. --branch fetches and builds one. Falling back to the reference
 * stub is never silent and never implicit: a run that quietly tests the stub
 * and reports 21 of 21 is worse than no run, because it looks like an answer.
 */
function findExtension({ explicit, branch, mode }) {
  if (explicit) {
    const p = path.resolve(GAUNTLET_DIR, explicit);
    if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
    throw new Error(`No manifest.json under ${p}`);
  }

  if (branch) {
    const built = prepareExtension(branch);
    console.log(`  Built ${built.branch} at ${built.head.slice(0, 8)}\n`);
    return built.path;
  }

  for (const c of ['dist', 'extension', 'src', '.', 'build'].map((d) => path.resolve(REPO_DIR, d))) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  }

  console.error(
    `\n  No extension to test.\n\n` +
    `  There is no manifest.json in dist/, extension/, src/, build/ or the repo root,\n` +
    `  which is normal on the gauntlet's own branch — the extension lives on another one.\n\n` +
    `  Build and test a branch:   npm run gauntlet${mode === 'real' ? ':real' : ''} -- --branch=feat/qwen-browser-agent\n` +
    `  Or point at a build:       node scripts/run.js --mode=${mode} --extension=/path/to/dist\n` +
    `  Or check the harness:      node scripts/run.js --mode=${mode} --extension=stub-extension\n\n` +
    `  The last one runs the reference stub. It proves the harness works and says\n` +
    `  nothing at all about the extension, so it is never chosen for you.\n`
  );
  process.exit(2);
}

const mode = arg('mode', 'mock');
const only = arg('only') ? arg('only').split(',').map((s) => s.trim().toUpperCase()) : null;
const extensionPath = findExtension({ explicit: arg('extension'), branch: arg('branch'), mode });
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
  if (d.fixed.length) console.log(`Fixed since the last run against ${run.extension}: ${d.fixed.join(', ')}`);
  if (d.broken.length) console.log(`Broke since the last run against ${run.extension}: ${d.broken.join(', ')}`);
} else {
  console.log(`First recorded run against ${run.extension}; nothing to compare with.`);
}
console.log(`Scoreboard: results/scoreboard.${mode}.md\n`);

process.exit(s.fail > 0 ? 1 : 0);
