#!/usr/bin/env node
// Turn a scoreboard into GitHub Actions annotations.
//
// Annotations ride on the workflow command protocol, so they need no token
// permissions and they surface through the check-runs API — which matters when
// the logs and artifacts of a run are not reachable from where the fix is being
// written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mode = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=mock').slice(7);
const file = path.resolve(HERE, `../results/scoreboard.${mode}.json`);

// Annotations are one line each; newlines end the command.
const flatten = (v) =>
  String(typeof v === 'string' ? v : JSON.stringify(v) ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/%/g, '%25')
    .replace(/::/g, '∶∶')
    .slice(0, 900);

if (!fs.existsSync(file)) {
  console.log(`::error title=gauntlet::No scoreboard at results/scoreboard.${mode}.json — the run failed before any task completed.`);
  process.exit(0);
}

const run = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log(
  `::notice title=gauntlet environment::${flatten(
    Object.entries(run.environment ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')
  )}`
);

const failures = run.results.filter((r) => r.status === 'fail');
if (!failures.length) {
  console.log('::notice title=gauntlet::Every task that ran passed.');
  process.exit(0);
}

// Actions shows at most ten annotations per step, so lead with the distinct
// reasons rather than one line per task when many tasks share a cause.
for (const f of failures.slice(0, 9)) {
  console.log(`::error title=${f.id} ${f.name}::${flatten(f.why)} — observed: ${flatten(f.observed)}`);
}
if (failures.length > 9) {
  console.log(`::error title=gauntlet::${failures.length - 9} further failures; see the scoreboard artifact.`);
}
