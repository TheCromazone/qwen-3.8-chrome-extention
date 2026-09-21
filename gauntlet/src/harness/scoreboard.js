// Scoreboard rendering and run-to-run diffing.
import fs from 'node:fs';
import path from 'node:path';

export function summarise(run) {
  const pass = run.results.filter((r) => r.status === 'pass').length;
  const fail = run.results.filter((r) => r.status === 'fail').length;
  const skip = run.results.filter((r) => r.status === 'skip').length;
  return { pass, fail, skip, total: pass + fail, score: pass + fail === 0 ? 0 : pass / (pass + fail) };
}

export function renderMarkdown(run, previous = null) {
  const s = summarise(run);
  const lines = [];
  lines.push(`# Gauntlet scoreboard — ${run.mode} mode`);
  lines.push('');
  lines.push(`Run at ${new Date(run.startedAt).toISOString()}, took ${Math.round((run.finishedAt - run.startedAt) / 1000)}s.`);
  lines.push('');
  lines.push(`**${s.pass} passed, ${s.fail} failed, ${s.skip} skipped** — score ${(s.score * 100).toFixed(0)}%`);
  lines.push('');

  const diff = previous ? diffRuns(previous, run) : null;
  if (diff && (diff.fixed.length || diff.broken.length)) {
    lines.push('## Since the last run');
    lines.push('');
    for (const id of diff.fixed) lines.push(`- fixed: \`${id}\``);
    for (const id of diff.broken) lines.push(`- broke: \`${id}\``);
    lines.push('');
  }

  lines.push('| Task | Status | Time | Why it failed |');
  lines.push('|---|---|---|---|');
  for (const r of run.results) {
    const mark = r.status === 'pass' ? 'pass' : r.status === 'fail' ? '**fail**' : 'skip';
    const why = r.status === 'fail' ? escapeCell(r.why) : r.status === 'skip' ? escapeCell(r.reason ?? '') : '';
    lines.push(`| \`${r.id}\` ${r.name} | ${mark} | ${(r.ms / 1000).toFixed(1)}s | ${why} |`);
  }
  lines.push('');

  const failures = run.results.filter((r) => r.status === 'fail');
  if (failures.length) {
    lines.push('## Failures in detail');
    lines.push('');
    for (const f of failures) {
      lines.push(`### \`${f.id}\` ${f.name}`);
      lines.push('');
      lines.push(f.why);
      lines.push('');
      if (f.observed != null) {
        lines.push('What was observed:');
        lines.push('');
        lines.push('```');
        lines.push(typeof f.observed === 'string' ? f.observed : JSON.stringify(f.observed, null, 2));
        lines.push('```');
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function diffRuns(before, after) {
  const was = new Map(before.results.map((r) => [r.id, r.status]));
  const fixed = [];
  const broken = [];
  for (const r of after.results) {
    const prev = was.get(r.id);
    if (prev === 'fail' && r.status === 'pass') fixed.push(r.id);
    if (prev === 'pass' && r.status === 'fail') broken.push(r.id);
  }
  return { fixed, broken };
}

export function writeScoreboard(run, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `scoreboard.${run.mode}.json`);
  const previous = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
  fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  const md = renderMarkdown(run, previous);
  fs.writeFileSync(path.join(dir, `scoreboard.${run.mode}.md`), md);
  return { previous, markdown: md, jsonPath };
}
