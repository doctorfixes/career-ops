#!/usr/bin/env node

/**
 * health.mjs — pipeline health telemetry.
 *
 * doctor.mjs checks whether the system is set up; verify-pipeline.mjs checks
 * structural integrity. Neither gives a rolled-up "is my pipeline healthy right
 * now" score. This does: it turns a handful of hygiene signals into a 0–100
 * score + grade + per-check breakdown, so drift (un-followed-up applications,
 * missing report links, non-canonical statuses, an un-triaged reply queue, a
 * stale pipeline backlog) is visible at a glance and the orchestrator can
 * surface it in the daily digest.
 *
 * Read-only. Diagnoses; never edits anything.
 *
 * Usage:
 *   node health.mjs             # human-readable score + checks
 *   node health.mjs --json
 *   node health.mjs --from ./dir   # cached stats.json (+ optional pipeline/replies counts)
 *   node health.mjs --self-test
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = path.join(__dirname, 'data', 'pipeline.md');
const REPLIES_PATH = path.join(__dirname, 'data', 'reply-candidates.json');

const BACKLOG_WARN = 40; // pending pipeline rows above this start deducting

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Score → letter grade. */
export function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

/**
 * Compute a health score from normalized signals. Each check deducts from 100.
 * @param {{trackerTotal?:number, applied?:number, appliedWithoutFollowup?:number,
 *   reportPct?:number, nonCanonical?:number, pipelinePending?:number,
 *   repliesPending?:number}} s
 */
export function computeHealth(s = {}) {
  const trackerTotal = s.trackerTotal || 0;
  const applied = s.applied || 0;
  const checks = [];
  let deductions = 0;
  const add = (name, status, detail, deduction) => { checks.push({ name, status, detail, deduction }); deductions += deduction; };

  // 1. Follow-up compliance (applied rows with no follow-up seeded).
  if (applied > 0) {
    const missing = s.appliedWithoutFollowup || 0;
    const r = missing / applied;
    const d = Math.round(25 * r);
    add('follow-up compliance', r === 0 ? 'ok' : r <= 0.5 ? 'warn' : 'fail',
      `${missing}/${applied} applied rows have no follow-up`, d);
  } else {
    add('follow-up compliance', 'ok', 'no applied rows yet', 0);
  }

  // 2. Report-link coverage.
  if (trackerTotal > 0) {
    const reportPct = s.reportPct ?? 100;
    const d = clamp(Math.round((100 - reportPct) * 0.15), 0, 15);
    add('report coverage', reportPct >= 90 ? 'ok' : reportPct >= 60 ? 'warn' : 'fail',
      `${reportPct}% of tracker rows link a report`, d);
  } else {
    add('report coverage', 'ok', 'no tracker rows yet', 0);
  }

  // 3. Non-canonical statuses (data-contract drift).
  {
    const bad = s.nonCanonical || 0;
    const d = clamp(bad * 4, 0, 20);
    add('status hygiene', bad === 0 ? 'ok' : 'fail',
      bad === 0 ? 'all statuses canonical' : `${bad} row(s) with a non-canonical status`, d);
  }

  // 4. Reply triage backlog (action-needed, light deduction).
  {
    const pending = s.repliesPending || 0;
    const d = clamp(pending * 2, 0, 10);
    add('reply triage', pending === 0 ? 'ok' : 'warn',
      pending === 0 ? 'no replies awaiting review' : `${pending} repl${pending === 1 ? 'y' : 'ies'} awaiting \`reply-watch\``, d);
  }

  // 5. Pipeline backlog (un-evaluated leads piling up).
  {
    const pending = s.pipelinePending || 0;
    const over = Math.max(0, pending - BACKLOG_WARN);
    const d = clamp(Math.round(over * 0.3), 0, 15);
    add('pipeline backlog', pending <= BACKLOG_WARN ? 'ok' : 'warn',
      `${pending} pending lead(s) to evaluate`, d);
  }

  const score = clamp(100 - deductions, 0, 100);
  return { score, grade: gradeFor(score), checks };
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

const ICON = { ok: '✅', warn: '⚠️', fail: '❌' };

export function formatHealth(h) {
  const L = [];
  L.push(`Pipeline health: ${h.score}/100  (grade ${h.grade})`);
  L.push('');
  for (const c of h.checks) {
    const d = c.deduction ? `  (−${c.deduction})` : '';
    L.push(`  ${ICON[c.status] || '•'} ${c.name}: ${c.detail}${d}`);
  }
  const worst = h.checks.filter((c) => c.status !== 'ok').sort((a, b) => b.deduction - a.deduction);
  if (worst.length) {
    L.push('');
    L.push(`Fix first: ${worst[0].name} — ${worst[0].detail}.`);
  }
  return L.join('\n');
}

/** One-line form for the orchestrator digest. */
export function healthLine(h) {
  const flags = h.checks.filter((c) => c.status !== 'ok').map((c) => c.name);
  return `Pipeline health: ${h.score}/100 (${h.grade})${flags.length ? ` — watch: ${flags.join(', ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Signal gathering (impure)
// ---------------------------------------------------------------------------

function runJson(script, args = []) {
  try {
    const res = spawnSync('node', [script, ...args], { cwd: __dirname, encoding: 'utf-8', timeout: 120_000, env: process.env });
    if (res.status !== 0 || !res.stdout) return null;
    const d = JSON.parse(res.stdout);
    return d && d.error ? null : d;
  } catch { return null; }
}
function readCached(dir, name) {
  const p = path.join(path.isAbsolute(dir) ? dir : path.join(__dirname, dir), `${name}.json`);
  if (!existsSync(p)) return null;
  try { const d = JSON.parse(readFileSync(p, 'utf-8')); return d && d.error ? null : d; } catch { return null; }
}
function countPipelinePending() {
  try {
    if (!existsSync(PIPELINE_PATH)) return 0;
    return (readFileSync(PIPELINE_PATH, 'utf-8').match(/^- \[ \] /gm) || []).length;
  } catch { return 0; }
}
function countRepliesPending() {
  try {
    if (!existsSync(REPLIES_PATH)) return 0;
    const arr = JSON.parse(readFileSync(REPLIES_PATH, 'utf-8'));
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

/** Normalize signals from stats.mjs JSON + local file counts. */
export function signalsFromStats(stats, extra = {}) {
  const tracker = stats?.tracker || {};
  const followups = stats?.followups || {};
  const byStatus = tracker.byStatus || {};
  return {
    trackerTotal: tracker.total || 0,
    applied: byStatus.Applied || 0,
    appliedWithoutFollowup: followups.appliedWithoutFollowup || 0,
    reportPct: tracker.reportPct ?? 100,
    nonCanonical: byStatus.Unknown || 0,
    pipelinePending: extra.pipelinePending || 0,
    repliesPending: extra.repliesPending || 0,
  };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const fails = [];
  const perfect = computeHealth({ trackerTotal: 10, applied: 5, appliedWithoutFollowup: 0, reportPct: 100, nonCanonical: 0, pipelinePending: 3, repliesPending: 0 });
  if (perfect.score !== 100 || perfect.grade !== 'A') fails.push(`healthy pipeline should be 100/A, got ${perfect.score}/${perfect.grade}`);

  const drifting = computeHealth({ trackerTotal: 20, applied: 10, appliedWithoutFollowup: 10, reportPct: 40, nonCanonical: 3, pipelinePending: 100, repliesPending: 6 });
  if (drifting.score >= perfect.score) fails.push('drifting pipeline should score lower');
  if (drifting.checks.find((c) => c.name === 'follow-up compliance').status !== 'fail') fails.push('100% missing follow-ups should fail');
  if (drifting.checks.find((c) => c.name === 'status hygiene').status !== 'fail') fails.push('non-canonical statuses should fail');

  const sig = signalsFromStats({ tracker: { total: 5, reportPct: 80, byStatus: { Applied: 3, Unknown: 1 } }, followups: { appliedWithoutFollowup: 1 } }, { pipelinePending: 2, repliesPending: 4 });
  if (sig.applied !== 3 || sig.nonCanonical !== 1 || sig.repliesPending !== 4) fails.push('signalsFromStats mapping wrong');
  if (!healthLine(drifting).startsWith('Pipeline health:')) fails.push('healthLine format');

  if (fails.length) { console.error(`health self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('health self-test OK (scoring, grade bands, drift deductions, signal mapping)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  const json = argv.includes('--json');
  const fi = argv.indexOf('--from'); const from = fi !== -1 ? argv[fi + 1] : null;

  const stats = from ? readCached(from, 'stats') : runJson('stats.mjs');
  const extra = from
    ? { pipelinePending: (readCached(from, 'pipeline') || {}).pending || 0, repliesPending: (readCached(from, 'replies') || {}).pending || 0 }
    : { pipelinePending: countPipelinePending(), repliesPending: countRepliesPending() };
  const health = computeHealth(signalsFromStats(stats, extra));

  if (json) console.log(JSON.stringify(health, null, 2));
  else console.log('\n' + formatHealth(health));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
