#!/usr/bin/env node

/**
 * readiness.mjs — live scoring of the job-search readiness checklist.
 *
 * data/readiness.md is the human checklist (four gates, 23 items). This scores
 * the objectively-MEASURABLE items automatically — CV facts, setup, tracked-
 * outcome volume, the scoring baseline, pipeline health, funnel conversion,
 * concurrent processes, comp segment — and lists the SELF-ASSESSED items for
 * you. It reuses the tested pure logic from health.mjs / conversion.mjs so a
 * single stats read powers several checks.
 *
 * Read-only. It reports where you stand; it never edits the checklist or your
 * profile.
 *
 * Usage:
 *   node readiness.mjs             # human-readable gate-by-gate readiness
 *   node readiness.mjs --json
 *   node readiness.mjs --from ./dir   # cached signals.json (offline/testing)
 *   node readiness.mjs --self-test
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeHealth, signalsFromStats } from './health.mjs';
import { computeStageConversion } from './conversion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNLOG_PATH = path.join(__dirname, 'data', 'orchestrator-runs.tsv');
const PIPELINE_PATH = path.join(__dirname, 'data', 'pipeline.md');
const REPLIES_PATH = path.join(__dirname, 'data', 'reply-candidates.json');

// Thresholds (exported so tests read the same numbers the tool scores against).
export const MIN_OUTCOMES = 30;        // tracked applications before the funnel is trustworthy
export const HEALTH_MIN = 80;          // health.mjs score for "pipeline healthy"
export const ACTIVE_MIN = 2;           // overlapping interview processes = leverage
export const SEVERE_CONV_PCT = 10;     // a hop this low is a real bottleneck (fail)
export const MIN_RUNS = 1;             // orchestrator run rows = discovery is actually running

const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const unk = (detail) => ({ status: 'unknown', detail });

// ---------------------------------------------------------------------------
// Check definitions. Measurable checks carry an evaluate(signals); self items
// are listed for the human. IDs + labels mirror data/readiness.md.
// ---------------------------------------------------------------------------

export const CHECKS = [
  // Gate 1 — Honest, complete inputs
  { gate: 1, id: 'cv-facts', label: 'CV facts verify clean', kind: 'measurable',
    evaluate: (s) => s.cvFactsOk == null ? unk('could not run verify-cv-facts / cv-sync-check')
      : s.cvFactsOk ? pass('verify-cv-facts + cv-sync-check pass') : fail('CV facts or sync check failing') },
  { gate: 1, id: 'doctor', label: 'System set up', kind: 'measurable',
    evaluate: (s) => s.doctorReady == null ? unk('could not run doctor')
      : s.doctorReady ? pass('doctor: no missing prerequisites') : fail('doctor: onboarding incomplete') },
  { gate: 1, id: 'cv-complete', label: 'CV complete & current (real metrics)', kind: 'self' },
  { gate: 1, id: 'proof-points', label: 'Proof points captured in article-digest.md', kind: 'self' },
  { gate: 1, id: 'profile-targeting', label: 'Profile reflects real targeting', kind: 'self' },
  { gate: 1, id: 'scoring-weights', label: 'Scoring weights encode your priorities', kind: 'self' },
  { gate: 1, id: 'target-level', label: 'Target level is realistic', kind: 'self' },

  // Gate 2 — The loop actually closes
  { gate: 2, id: 'discovery-running', label: 'Scheduled discovery is running', kind: 'measurable',
    evaluate: (s) => s.orchestratorRuns == null ? unk('no run log yet')
      : s.orchestratorRuns >= MIN_RUNS ? pass(`${s.orchestratorRuns} orchestrator run(s) logged`) : fail('no orchestrator runs logged — schedule it') },
  { gate: 2, id: 'portals-segment', label: 'Portals cover your segment', kind: 'self' },
  { gate: 2, id: 'reply-ingest', label: 'Reply ingestion connected', kind: 'self' },
  { gate: 2, id: 'outcomes-volume', label: `Enough tracked outcomes (≥ ${MIN_OUTCOMES})`, kind: 'measurable',
    evaluate: (s) => s.everApplied == null ? unk('no tracker data yet')
      : s.everApplied >= MIN_OUTCOMES ? pass(`${s.everApplied} applications tracked`) : fail(`only ${s.everApplied} tracked — keep applying`) },
  { gate: 2, id: 'golden-baseline', label: 'Scoring baseline is trustworthy', kind: 'measurable',
    evaluate: (s) => s.goldenPass == null ? unk('could not run eval-golden')
      : s.goldenPass ? pass('golden eval PASSES') : fail('golden eval FAILING — scoring is unreliable') },
  { gate: 2, id: 'pipeline-health', label: `Pipeline is healthy (≥ ${HEALTH_MIN})`, kind: 'measurable',
    evaluate: (s) => s.healthScore == null ? unk('health unavailable')
      : s.healthScore >= HEALTH_MIN ? pass(`health ${s.healthScore}/100`) : fail(`health ${s.healthScore}/100 — clean up hygiene`) },

  // Gate 3 — Genuine fit at the target level
  { gate: 3, id: 'quality-discipline', label: 'Applying only to ≥ 4.0 fits', kind: 'self' },
  { gate: 3, id: 'conversion-fit', label: 'Conversion proves fit (no severe bottleneck)', kind: 'measurable',
    evaluate: (s) => !s.conversionHasSample ? unk('not enough funnel data to judge conversion')
      : (s.bottleneckPct != null && s.bottleneckPct < SEVERE_CONV_PCT)
        ? fail(`weakest hop converts ${s.bottleneckPct}% — a real bottleneck`)
        : pass('no severe bottleneck in the funnel') },
  { gate: 3, id: 'no-fabrication', label: 'Zero fabrication (claims trace to CV)', kind: 'self' },
  { gate: 3, id: 'sustainability', label: 'Sustainability screened (red-flag/culture)', kind: 'self' },
  { gate: 3, id: 'learning-applied', label: 'Learn proposals reviewed & applied', kind: 'self' },

  // Gate 4 — Real, concurrent leverage
  { gate: 4, id: 'concurrent-processes', label: `Multiple live processes (≥ ${ACTIVE_MIN})`, kind: 'measurable',
    evaluate: (s) => s.activeInterviews == null ? unk('no tracker data yet')
      : s.activeInterviews >= ACTIVE_MIN ? pass(`${s.activeInterviews} active interview process(es)`) : fail(`${s.activeInterviews} active — need overlap for leverage`) },
  { gate: 4, id: 'comp-segment', label: 'Comp target aimed at a segment that pays it', kind: 'measurable',
    evaluate: (s) => (s.compDesired == null || s.compAdvertised == null) ? unk('no comp observations yet')
      : s.compAdvertised >= s.compDesired * 0.9 ? pass(`advertised ~${s.compAdvertised} meets target ~${s.compDesired}`) : fail(`advertised ~${s.compAdvertised} trails target ~${s.compDesired}`) },
  { gate: 4, id: 'decision-makers', label: 'Reaching decision-makers, not just ATS', kind: 'self' },
  { gate: 4, id: 'offer-timing', label: 'Offers timed to cluster', kind: 'self' },
  { gate: 4, id: 'negotiate-data', label: 'Negotiating from data (offer-prep ready)', kind: 'self' },
];

export const GATE_NAMES = {
  1: 'Honest, complete inputs',
  2: 'The loop actually closes',
  3: 'Genuine fit at the target level',
  4: 'Real, concurrent leverage',
};

// ---------------------------------------------------------------------------
// Evaluation + scoring (pure)
// ---------------------------------------------------------------------------

/** Evaluate every check against normalized signals. */
export function evaluateReadiness(signals = {}) {
  return CHECKS.map((c) => c.kind === 'measurable'
    ? { gate: c.gate, id: c.id, label: c.label, kind: 'measurable', ...c.evaluate(signals) }
    : { gate: c.gate, id: c.id, label: c.label, kind: 'self', status: 'self', detail: 'self-assess in data/readiness.md' });
}

/** Per-gate + overall roll-up. A gate is "ready" when all its measurable checks pass. */
export function scoreGates(results) {
  const gates = {};
  for (const g of [1, 2, 3, 4]) {
    const measurable = results.filter((r) => r.gate === g && r.kind === 'measurable');
    const passed = measurable.filter((r) => r.status === 'pass').length;
    const failed = measurable.filter((r) => r.status === 'fail').length;
    const unknown = measurable.filter((r) => r.status === 'unknown').length;
    const self = results.filter((r) => r.gate === g && r.kind === 'self').length;
    gates[g] = {
      name: GATE_NAMES[g],
      measurableTotal: measurable.length,
      measurablePassed: passed,
      failed, unknown, self,
      ready: measurable.length > 0 && passed === measurable.length,
    };
  }
  const allMeasurable = results.filter((r) => r.kind === 'measurable');
  const overall = {
    measurableTotal: allMeasurable.length,
    measurablePassed: allMeasurable.filter((r) => r.status === 'pass').length,
    selfTotal: results.filter((r) => r.kind === 'self').length,
    pushReady: gates[1].ready && gates[2].ready,             // "ready to push hard"
    leverageReady: gates[3].ready && gates[4].ready,         // "negotiating from strength"
  };
  return { gates, overall };
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

const ICON = { pass: '✅', fail: '❌', unknown: '❓', self: '▫️' };

export function formatReadiness(results, scored) {
  const L = [];
  const o = scored.overall;
  L.push(`Readiness — measurable: ${o.measurablePassed}/${o.measurableTotal} passing  ·  self-assess: ${o.selfTotal} items`);
  L.push(`  ${o.pushReady ? '✅' : '⏳'} Ready to push hard (Gates 1–2)     ${o.leverageReady ? '✅' : '⏳'} Negotiating from strength (Gates 3–4)`);
  for (const g of [1, 2, 3, 4]) {
    const gs = scored.gates[g];
    L.push('');
    L.push(`Gate ${g} — ${gs.name}  [${gs.ready ? 'READY' : `${gs.measurablePassed}/${gs.measurableTotal} measurable`}]`);
    for (const r of results.filter((x) => x.gate === g)) {
      L.push(`  ${ICON[r.status] || '•'} ${r.label}${r.kind === 'measurable' ? ` — ${r.detail}` : ''}`);
    }
  }
  const failing = results.filter((r) => r.status === 'fail');
  if (failing.length) {
    L.push('');
    L.push('Fix next: ' + failing.slice(0, 3).map((r) => r.label).join(' · '));
  }
  L.push('');
  L.push('▫️ = self-assess in data/readiness.md (the system can\'t measure these — only you can).');
  return L.join('\n');
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
function runOk(script, args = []) {
  try {
    const res = spawnSync('node', [script, ...args], { cwd: __dirname, encoding: 'utf-8', timeout: 120_000, env: process.env });
    if (res.error) return null;
    return res.status === 0;
  } catch { return null; }
}
function count(rePath, re) {
  try { return existsSync(rePath) ? (readFileSync(rePath, 'utf-8').match(re) || []).length : 0; } catch { return 0; }
}
function countRunLog() {
  try {
    if (!existsSync(RUNLOG_PATH)) return null;
    const lines = readFileSync(RUNLOG_PATH, 'utf-8').split('\n').filter((l) => l.trim());
    return Math.max(0, lines.length - 1); // minus header
  } catch { return null; }
}

/** Gather every normalized signal the pure evaluator needs. */
export function gatherSignals() {
  const stats = runJson('stats.mjs');
  const funnel = stats?.funnel || {};
  const byStatus = stats?.tracker?.byStatus || {};
  const hasTracker = !!stats?.tracker;

  const health = computeHealth(signalsFromStats(stats, {
    pipelinePending: count(PIPELINE_PATH, /^- \[ \] /gm),
    repliesPending: (() => { try { return existsSync(REPLIES_PATH) ? (JSON.parse(readFileSync(REPLIES_PATH, 'utf-8')) || []).length : 0; } catch { return 0; } })(),
  }));
  const conv = computeStageConversion(funnel);

  const salary = runJson('salary-gap.mjs');
  const cvFacts = runOk('verify-cv-facts.mjs');
  const cvSync = runOk('cv-sync-check.mjs');

  return {
    cvFactsOk: (cvFacts == null || cvSync == null) ? null : (cvFacts && cvSync),
    doctorReady: (() => { const d = runJson('doctor.mjs', ['--json']); return d ? d.onboardingNeeded === false : null; })(),
    orchestratorRuns: countRunLog(),
    everApplied: hasTracker ? (funnel.everApplied || 0) : null,
    goldenPass: runOk('eval-golden.mjs', ['--replay', '--model', 'cheap-stub']),
    healthScore: stats ? health.score : null,   // only meaningful once there's a tracker
    conversionHasSample: !!conv.bottleneck,
    bottleneckPct: conv.bottleneck ? conv.bottleneck.conversionPct : null,
    activeInterviews: hasTracker ? (byStatus.Interview || 0) : null,
    compDesired: salary?.desired?.mid ?? salary?.desired?.min ?? null,
    compAdvertised: salary?.advertised?.mid ?? salary?.advertised?.median ?? null,
  };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const fails = [];
  // All measurable pass.
  const good = {
    cvFactsOk: true, doctorReady: true, orchestratorRuns: 5, everApplied: 40, goldenPass: true,
    healthScore: 92, conversionHasSample: true, bottleneckPct: 22, activeInterviews: 3,
    compDesired: 180, compAdvertised: 185,
  };
  let s = scoreGates(evaluateReadiness(good));
  if (!s.overall.pushReady || !s.overall.leverageReady) fails.push('all-pass should be push+leverage ready');
  if (s.overall.measurablePassed !== s.overall.measurableTotal) fails.push('all-pass should pass every measurable');

  // A single failure breaks the owning gate but not others.
  const oneBad = { ...good, healthScore: 40 };
  s = scoreGates(evaluateReadiness(oneBad));
  if (s.gates[2].ready) fails.push('failing health should make Gate 2 not ready');
  if (!s.gates[1].ready) fails.push('Gate 1 should stay ready when only Gate 2 fails');
  if (s.overall.pushReady) fails.push('pushReady should be false when Gate 2 fails');

  // Unknown (no data) is not a pass.
  const noData = { cvFactsOk: null, doctorReady: null, orchestratorRuns: null, everApplied: null, goldenPass: null, healthScore: null, conversionHasSample: false, bottleneckPct: null, activeInterviews: null, compDesired: null, compAdvertised: null };
  s = scoreGates(evaluateReadiness(noData));
  if (s.overall.measurablePassed !== 0) fails.push('no-data should pass nothing measurable');
  if (s.gates[1].ready) fails.push('no-data gate must not be ready');

  // Severe bottleneck fails the conversion check.
  const bottleneck = evaluateReadiness({ ...good, bottleneckPct: 5 }).find((r) => r.id === 'conversion-fit');
  if (bottleneck.status !== 'fail') fails.push('5% bottleneck should fail conversion-fit');

  if (fails.length) { console.error(`readiness self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('readiness self-test OK (evaluate, gate scoring, unknown≠pass, bottleneck fail)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  const json = argv.includes('--json');
  const fi = argv.indexOf('--from');
  const signals = fi !== -1
    ? (() => { const p = path.join(argv[fi + 1], 'signals.json'); try { return JSON.parse(readFileSync(path.isAbsolute(p) ? p : path.join(__dirname, p), 'utf-8')); } catch { return {}; } })()
    : gatherSignals();

  const results = evaluateReadiness(signals);
  const scored = scoreGates(results);

  if (json) console.log(JSON.stringify({ ...scored, results }, null, 2));
  else console.log('\n' + formatReadiness(results, scored));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
