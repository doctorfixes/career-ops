#!/usr/bin/env node

/**
 * weekly-review.mjs — the strategic "growth" digest.
 *
 * orchestrate.mjs answers "what needs me today" (operational). This answers
 * "how is the search trending and what should I tune" (strategic). It composes
 * the lifetime stats, the learn-engine proposals, and a concentration guard
 * into one periodic review you run weekly (or after a batch of outcomes).
 *
 * Sections:
 *   1. Funnel & volume            (stats.mjs)
 *   2. Concentration guard        (analyze-patterns.mjs) — flags over-reliance
 *      on one archetype or one ATS vendor (algorithmic-monoculture aware).
 *   3. Top tuning proposals       (learn.mjs)
 *   4. Tuning stability           (tuning-log.mjs churn)
 *   5. Next actions
 *
 * Read-only. Writes only data/weekly-review.md. Human-in-the-loop: it points a
 * direction; you decide and the agent applies via the `learn` mode.
 *
 * Usage:
 *   node weekly-review.mjs            # human-readable, writes data/weekly-review.md
 *   node weekly-review.mjs --json
 *   node weekly-review.mjs --from ./dir   # cached {stats,learn,patterns,tuning}.json
 *   node weekly-review.mjs --self-test
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_PATH = path.join(__dirname, 'data', 'weekly-review.md');

const ARCHETYPE_CONCENTRATION_PCT = 50; // one archetype ≥ this share of volume = concentrated
const VENDOR_MONOCULTURE_PCT = 40;      // one ATS vendor ≥ this share of submissions = monoculture risk

// ---------------------------------------------------------------------------
// Concentration / monoculture guard (pure)
// ---------------------------------------------------------------------------

/**
 * Flag over-reliance on a single archetype or ATS channel. Diversification is a
 * safety property: correlated rejections through one screening vendor mean a
 * concentrated channel that yields nothing has diminishing returns.
 * @param {object} patterns  analyze-patterns.mjs JSON
 */
export function computeConcentration(patterns) {
  const flags = [];
  const result = { archetype: null, vendor: null, flags };

  const arch = patterns?.archetypeBreakdown;
  if (Array.isArray(arch) && arch.length) {
    const total = arch.reduce((s, a) => s + (a.total || 0), 0);
    const top = [...arch].sort((a, b) => (b.total || 0) - (a.total || 0))[0];
    if (total > 0 && top) {
      const sharePct = Math.round((top.total / total) * 100);
      const flagged = sharePct >= ARCHETYPE_CONCENTRATION_PCT && arch.length > 1;
      result.archetype = { top: top.archetype, sharePct, total, conversionRate: top.conversionRate ?? null, flagged };
      if (flagged) flags.push(`Archetype concentration: ${sharePct}% of volume is "${top.archetype}". If it under-converts, diversify targets before scaling it further.`);
    }
  }

  const vend = patterns?.vendorAnalysis;
  const vb = vend?.breakdown;
  if (Array.isArray(vb) && vb.length) {
    const top = [...vb].sort((a, b) => (b.sharePct || 0) - (a.sharePct || 0))[0];
    if (top) {
      const flagged = (top.sharePct || 0) >= VENDOR_MONOCULTURE_PCT && (top.advanceRate || 0) <= (vend.overallAdvanceRate || 0);
      result.vendor = { top: top.vendor, sharePct: top.sharePct || 0, advanceRate: top.advanceRate || 0, overallAdvanceRate: vend.overallAdvanceRate ?? null, flagged };
      if (flagged) flags.push(`ATS monoculture: ${top.sharePct}% of applications route through ${top.vendor} (advancing ${top.advanceRate}% vs overall ${vend.overallAdvanceRate}%). Prefer referral/direct for those companies.`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Review assembly (pure)
// ---------------------------------------------------------------------------

/**
 * @param {{stats?:object, learn?:object, patterns?:object, tuning?:object, date?:string}} inputs
 */
export function buildReview({ stats, learn, patterns, tuning, date } = {}) {
  const funnel = stats?.funnel || null;
  const tracker = stats?.tracker || null;
  const concentration = computeConcentration(patterns || {});
  const proposals = Array.isArray(learn?.proposals) ? learn.proposals : [];
  const churnFlags = (tuning?.churn || []).filter((c) => c.churnFlag);

  const actions = [];
  if (proposals.length) actions.push(`Review ${proposals.length} tuning proposal(s): run \`node learn.mjs\`, then apply approved ones via the \`learn\` mode.`);
  for (const f of concentration.flags) actions.push(f);
  if (churnFlags.length) actions.push(`Hold on re-tuning ${churnFlags.map((c) => c.knob).join(', ')} — flip-flopping suggests the signal is noise.`);
  if (funnel && funnel.everApplied >= 10 && funnel.responseRate != null && funnel.responseRate < 10) {
    actions.push(`Low response rate (${funnel.responseRate}%). The learn engine's channel + archetype proposals are the first levers.`);
  }
  if (actions.length === 0) actions.push('Nothing flagged. Keep applying + tracking outcomes; re-run once you have more data.');

  return {
    date: date || new Date().toISOString().slice(0, 10),
    volume: tracker ? { total: tracker.total ?? null, active: tracker.activeApps ?? tracker.active ?? null } : null,
    funnel: funnel ? {
      everApplied: funnel.everApplied ?? null,
      responseRate: funnel.responseRate ?? null,
      interviewRate: funnel.interviewRate ?? null,
      offerRate: funnel.offerRate ?? null,
    } : null,
    concentration,
    topProposals: proposals.slice(0, 5).map((p) => ({ title: p.title, confidence: p.confidence, category: p.category })),
    churnFlags: churnFlags.map((c) => ({ knob: c.knob, changes: c.changes })),
    actions,
  };
}

export function formatReview(r) {
  const L = [];
  L.push(`# Weekly review — ${r.date}`);
  L.push('');
  // 1. Funnel & volume
  L.push('## 1. Funnel & volume');
  if (r.funnel) {
    L.push(`- Ever applied: ${r.funnel.everApplied ?? '—'}  ·  response ${pct(r.funnel.responseRate)}  ·  interview ${pct(r.funnel.interviewRate)}  ·  offer ${pct(r.funnel.offerRate)}`);
    if (r.volume) L.push(`- Tracker: ${r.volume.total ?? '—'} rows (${r.volume.active ?? '—'} active)`);
  } else {
    L.push('- No tracker data yet.');
  }
  L.push('');
  // 2. Concentration guard
  L.push('## 2. Concentration guard');
  const c = r.concentration;
  if (c.archetype) L.push(`- Top archetype: **${c.archetype.top}** — ${c.archetype.sharePct}% of volume${c.archetype.flagged ? '  ⚠️ concentrated' : ''}`);
  if (c.vendor) L.push(`- Top ATS channel: **${c.vendor.top}** — ${c.vendor.sharePct}% of submissions, advancing ${c.vendor.advanceRate}%${c.vendor.flagged ? '  ⚠️ monoculture risk' : ''}`);
  if (!c.archetype && !c.vendor) L.push('- Not enough data to assess concentration.');
  if (c.flags.length) { L.push(''); for (const f of c.flags) L.push(`  > ${f}`); }
  L.push('');
  // 3. Tuning proposals
  L.push('## 3. Top tuning proposals');
  if (r.topProposals.length) {
    r.topProposals.forEach((p, i) => L.push(`${i + 1}. ${p.title}  _(${p.confidence}, ${p.category})_`));
    L.push('');
    L.push('Run `node learn.mjs` for the full evidence + apply via the `learn` mode.');
  } else {
    L.push('- No proposals — not enough outcome data, or nothing crossed the sample floor.');
  }
  L.push('');
  // 4. Tuning stability
  L.push('## 4. Tuning stability');
  if (r.churnFlags.length) {
    L.push('⚠️ Flip-flopping knobs (possible noise-chasing):');
    for (const f of r.churnFlags) L.push(`- ${f.knob} (changed ${f.changes}×)`);
  } else {
    L.push('- Stable — no over-tuning detected.');
  }
  L.push('');
  // 5. Next actions
  L.push('## 5. Next actions');
  for (const a of r.actions) L.push(`- ${a}`);
  L.push('');
  L.push('---');
  L.push('_Read-only strategic review. Direction only — you approve every change, the agent applies it._');
  return L.join('\n');
}

function pct(v) { return v == null ? '—' : `${v}%`; }

// ---------------------------------------------------------------------------
// Input gathering (impure)
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
function gather(opts) {
  if (opts.from) {
    return {
      stats: readCached(opts.from, 'stats'), learn: readCached(opts.from, 'learn'),
      patterns: readCached(opts.from, 'patterns'), tuning: readCached(opts.from, 'tuning'),
    };
  }
  return {
    stats: runJson('stats.mjs'),
    learn: runJson('learn.mjs', ['--json', '--no-gate']),
    patterns: runJson('analyze-patterns.mjs'),
    tuning: runJson('tuning-log.mjs', ['--json']),
  };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const patterns = {
    archetypeBreakdown: [
      { archetype: 'AI PM', total: 14, positive: 0, conversionRate: 0 },
      { archetype: 'Platform', total: 6, positive: 2, conversionRate: 33 },
    ],
    vendorAnalysis: { overallAdvanceRate: 15, breakdown: [{ vendor: 'workday', total: 12, advanced: 0, advanceRate: 0, sharePct: 55, sufficientSample: true }] },
  };
  const con = computeConcentration(patterns);
  const fails = [];
  if (!con.archetype.flagged) fails.push('archetype concentration not flagged (70%)');
  if (!con.vendor.flagged) fails.push('vendor monoculture not flagged (55%, 0% advance)');
  if (con.flags.length !== 2) fails.push(`expected 2 flags, got ${con.flags.length}`);

  const review = buildReview({
    stats: { funnel: { everApplied: 20, responseRate: 5, interviewRate: 0, offerRate: 0 }, tracker: { total: 20, active: 18 } },
    learn: { proposals: [{ title: 'Down-weight "AI PM"', confidence: 'high', category: 'targeting' }] },
    patterns,
    tuning: { churn: [{ knob: 'auto_pdf_score_threshold', changes: 3, churnFlag: true }] },
    date: '2026-07-23',
  });
  if (review.actions.length < 3) fails.push('expected several actions');
  if (!review.churnFlags.length) fails.push('churn flag not surfaced');
  const md = formatReview(review);
  if (!/monoculture risk/.test(md)) fails.push('monoculture not rendered');
  if (!/Weekly review — 2026-07-23/.test(md)) fails.push('header missing');

  if (fails.length) { console.error(`weekly-review self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('weekly-review self-test OK (concentration guard, review assembly, formatting)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  const opts = { json: argv.includes('--json'), from: null };
  const fi = argv.indexOf('--from');
  if (fi !== -1) opts.from = argv[fi + 1];

  const review = buildReview({ ...gather(opts), date: new Date().toISOString().slice(0, 10) });
  const md = formatReview(review);
  try { mkdirSync(path.dirname(REVIEW_PATH), { recursive: true }); writeFileSync(REVIEW_PATH, md, 'utf-8'); } catch { /* non-fatal */ }

  if (opts.json) console.log(JSON.stringify(review, null, 2));
  else { console.log('\n' + md); console.log(`\n(written to ${path.relative(__dirname, REVIEW_PATH)})`); }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
