#!/usr/bin/env node

/**
 * conversion.mjs — stage-to-stage funnel conversion + bottleneck finder.
 *
 * stats.mjs reports each stage as a share of "ever applied". funnel-velocity.mjs
 * reports how LONG each hop takes. Neither answers the tactical question:
 * "which HOP am I losing people at?" This does — it computes the conversion
 * rate of each transition (applied→responded→interview→offer), finds the
 * weakest hop, and names the lever that hop responds to.
 *
 * Read-only analysis. Feeds the `patterns` / `learn` narrative; the learn engine
 * already turns weak conversion into archetype/channel proposals.
 *
 * Usage:
 *   node conversion.mjs             # human-readable
 *   node conversion.mjs --json
 *   node conversion.mjs --from ./dir   # cached {stats,funnelVelocity}.json
 *   node conversion.mjs --min-n 8      # min sample at a hop's start to trust it
 *   node conversion.mjs --self-test
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIN_N = 5;

// Which lever each hop responds to — plain, honest guidance (no fabrication).
const HOP_LEVERS = {
  'applied-responded': 'CV/ATS keyword match, application channel, and role-fit targeting (the `learn` channel + archetype proposals).',
  'responded-interview': 'recruiter-screen prep and knock-out answers — you get replies but stall before interviews.',
  'interview-offer': 'interview preparation, closing, and negotiation (`interview/practice`, `interview/debrief`, `offer-prep`).',
};

// ---------------------------------------------------------------------------
// Core (pure)
// ---------------------------------------------------------------------------

/**
 * Compute per-hop conversion from the cumulative ever* funnel.
 * @param {{everApplied?:number, everResponded?:number, everInterview?:number, everOffer?:number}} f
 * @param {{minN?:number}} [opts]
 */
export function computeStageConversion(f = {}, { minN = DEFAULT_MIN_N } = {}) {
  const applied = f.everApplied || 0, responded = f.everResponded || 0,
    interview = f.everInterview || 0, offer = f.everOffer || 0;
  const mk = (id, label, from, to) => {
    const conversionPct = from > 0 ? Math.round((to / from) * 100) : null;
    return { id, label, from, to, lost: Math.max(0, from - to), conversionPct, trusted: from >= minN };
  };
  const hops = [
    mk('applied-responded', 'Applied → Responded', applied, responded),
    mk('responded-interview', 'Responded → Interview', responded, interview),
    mk('interview-offer', 'Interview → Offer', interview, offer),
  ];
  // Bottleneck: lowest conversion among hops with a trustworthy sample.
  const eligible = hops.filter((h) => h.trusted && h.conversionPct !== null);
  let bottleneck = null;
  if (eligible.length) {
    const worst = eligible.reduce((a, b) => (b.conversionPct < a.conversionPct ? b : a));
    bottleneck = { hop: worst.id, label: worst.label, conversionPct: worst.conversionPct, lever: HOP_LEVERS[worst.id] };
  }
  const overall = applied > 0 ? Math.round((offer / applied) * 100) : null;
  return { hops, bottleneck, overallAppliedToOffer: overall, sample: { applied, responded, interview, offer } };
}

/** Fold in the median days-per-hop from funnel-velocity, if available. */
export function attachVelocity(conversion, funnelVelocity) {
  const v = funnelVelocity?.velocity;
  if (!v) return conversion;
  const map = { 'applied-responded': 'appliedToResponded', 'responded-interview': 'respondedToInterview', 'interview-offer': 'interviewToOffer' };
  for (const h of conversion.hops) {
    const key = map[h.id];
    const median = v?.[key]?.median;
    if (median != null) h.medianDays = median;
  }
  return conversion;
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

export function formatConversion(c) {
  const L = [];
  L.push('Funnel conversion (stage → stage)');
  L.push('');
  for (const h of c.hops) {
    if (h.conversionPct === null) { L.push(`  ${h.label}: no data`); continue; }
    const days = h.medianDays != null ? `  ·  ~${h.medianDays}d median` : '';
    const trust = h.trusted ? '' : '  (small sample)';
    L.push(`  ${h.label}: ${h.conversionPct}%  (${h.to}/${h.from}, ${h.lost} lost)${days}${trust}`);
  }
  L.push('');
  L.push(`  Overall Applied → Offer: ${c.overallAppliedToOffer == null ? 'no data' : c.overallAppliedToOffer + '%'}`);
  if (c.bottleneck) {
    L.push('');
    L.push(`⚠️  Weakest hop: ${c.bottleneck.label} at ${c.bottleneck.conversionPct}%.`);
    L.push(`   Lever: ${c.bottleneck.lever}`);
  } else {
    L.push('');
    L.push('Not enough data at any hop yet to call a bottleneck. Keep tracking outcomes.');
  }
  return L.join('\n');
}

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

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const fails = [];
  // Interview→offer is the weakest trustworthy hop here.
  const c = computeStageConversion({ everApplied: 40, everResponded: 20, everInterview: 10, everOffer: 1 }, { minN: 5 });
  if (c.hops[0].conversionPct !== 50) fails.push(`A→R expected 50, got ${c.hops[0].conversionPct}`);
  if (c.hops[2].conversionPct !== 10) fails.push(`I→O expected 10, got ${c.hops[2].conversionPct}`);
  if (!c.bottleneck || c.bottleneck.hop !== 'interview-offer') fails.push('bottleneck should be interview-offer');
  if (c.overallAppliedToOffer !== 3) fails.push(`overall expected 3, got ${c.overallAppliedToOffer}`);
  // small samples excluded from bottleneck
  const c2 = computeStageConversion({ everApplied: 4, everResponded: 1, everInterview: 0, everOffer: 0 }, { minN: 5 });
  if (c2.bottleneck !== null) fails.push('sub-threshold sample must not name a bottleneck');
  // velocity fold-in
  const withV = attachVelocity(computeStageConversion({ everApplied: 10, everResponded: 6, everInterview: 3, everOffer: 1 }), { velocity: { interviewToOffer: { median: 12 } } });
  if (withV.hops[2].medianDays !== 12) fails.push('velocity median not attached');

  if (fails.length) { console.error(`conversion self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('conversion self-test OK (per-hop conversion, bottleneck, sample floor, velocity fold-in)');
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
  const mi = argv.indexOf('--min-n'); const minN = mi !== -1 ? (parseInt(argv[mi + 1], 10) || DEFAULT_MIN_N) : DEFAULT_MIN_N;

  const stats = from ? readCached(from, 'stats') : runJson('stats.mjs');
  const fv = from ? readCached(from, 'funnelVelocity') : runJson('funnel-velocity.mjs');
  const funnel = stats?.funnel || {};

  let conversion = computeStageConversion(funnel, { minN });
  conversion = attachVelocity(conversion, fv);

  if (json) console.log(JSON.stringify(conversion, null, 2));
  else console.log('\n' + formatConversion(conversion));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
