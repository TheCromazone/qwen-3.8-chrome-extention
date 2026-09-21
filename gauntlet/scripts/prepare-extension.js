// Build the extension from a branch, into a worktree beside this checkout.
//
// The gauntlet and the extension live on different branches, so a checkout of
// the gauntlet does not contain the thing it tests. This fetches the named
// branch, builds it, and returns the path to the built extension.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const WORKTREE = path.join(REPO, '.gauntlet-worktree');

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

export function prepareExtension(branch, { quiet = false } = {}) {
  const say = (m) => { if (!quiet) console.log(`  ${m}`); };

  say(`Fetching ${branch}…`);
  git('fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`, '--force');
  const head = git('rev-parse', `origin/${branch}`);

  if (fs.existsSync(WORKTREE)) {
    execFileSync('git', ['checkout', '--detach', head], { cwd: WORKTREE, stdio: 'ignore' });
  } else {
    git('worktree', 'add', '--detach', WORKTREE, head);
  }
  say(`${branch} is at ${head.slice(0, 8)}`);

  const pkg = path.join(WORKTREE, 'package.json');
  if (!fs.existsSync(pkg)) {
    throw new Error(`${branch} has no package.json, so there is nothing to build.`);
  }
  const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};

  say('Installing and building…');
  execFileSync('npm', ['install'], { cwd: WORKTREE, stdio: quiet ? 'ignore' : 'inherit' });
  if (scripts.build) execFileSync('npm', ['run', 'build'], { cwd: WORKTREE, stdio: quiet ? 'ignore' : 'inherit' });

  for (const candidate of ['dist', 'extension', 'src', '.']) {
    const dir = path.join(WORKTREE, candidate);
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return { path: dir, head, branch };
  }
  throw new Error(`Built ${branch} but found no manifest.json under it.`);
}

// Usable on its own: node scripts/prepare-extension.js feat/qwen-browser-agent
if (import.meta.url === `file://${process.argv[1]}`) {
  const branch = process.argv[2];
  if (!branch) {
    console.error('Usage: node scripts/prepare-extension.js <branch>');
    process.exit(2);
  }
  console.log(prepareExtension(branch).path);
}
