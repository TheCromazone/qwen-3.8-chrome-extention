#!/usr/bin/env node
// The gauntlet loop: re-run whenever the branch under test moves.
//
//   node scripts/loop.js --branch=feat/extension --interval=120
//
// Fetches the branch, and if its head changed since the last run, checks it out
// into a worktree and runs the gauntlet against it. Prints only what changed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const branch = arg('branch');
const interval = Number(arg('interval', '120')) * 1000;
const mode = arg('mode', 'mock');
if (!branch) {
  console.error('Usage: node scripts/loop.js --branch=BRANCH [--interval=SECONDS] [--mode=mock|real]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
let lastHead = null;

for (;;) {
  try {
    git('fetch', 'origin', branch);
    const head = git('rev-parse', `origin/${branch}`);
    if (head !== lastHead) {
      console.log(`\n=== ${new Date().toISOString()} — ${branch} at ${head.slice(0, 8)} ===`);
      const worktree = path.join(REPO, '.gauntlet-worktree');
      try { git('worktree', 'remove', '--force', worktree); } catch { /* none yet */ }
      git('worktree', 'add', '--detach', worktree, head);
      try {
        execFileSync('node', [path.join(HERE, 'run.js'), `--mode=${mode}`, `--extension=${worktree}`], {
          cwd: path.resolve(HERE, '..'),
          stdio: 'inherit'
        });
      } catch { /* run.js exits non-zero on failures; the scoreboard has them */ }
      lastHead = head;
    }
  } catch (err) {
    console.error(`loop: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, interval));
}
