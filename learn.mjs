#!/usr/bin/env node

/**
 * learn.mjs — the calibration engine (closes the learning loop).
 *
 * The analytics scripts (analyze-patterns, funnel-velocity, salary-gap,
 * upskill) each detect *one* signal. learn.mjs reads them together and
 * synthesizes prioritized, evidence-backed TUNING PROPOSALS mapped to specific
 * editable knobs in config/profile.yml / modes/_profile.md / portals.yml.
 *
 * It is PROPOSE-ONLY and never writes user-layer facts (DATA_CONTRACT.md). It
 * hands you a reviewed diff; you (or the agent, on your approval) apply it. Any
 * proposal that changes scoring / archetypes / targeting is `gated`: it carries
 * the golden-eval baseline (eval-golden.mjs) so a scoring change can't be
 * applied onto a red baseline, and re-running the gate after an edit catches
 * regressions. This is the "safe operations" half of dynamic tuning.
 *
 * Usage:
 *   node learn.mjs                 # gather live analytics, print proposals
 *   node learn.mjs --json          # machine-readable
 *   node learn.mjs --from ./dir    # read cached {patterns,funnel,salary,upskill}.json
 *   node learn.mjs --no-gate       # skip the golden-eval baseline check
 *   node learn.mjs --min-n 8       # sample floor for a proposal to fire (default 5)
 *   node learn.mjs --show-low      # include low-confidence (small-sample) proposals
 *   node learn.mjs --self-test
 *
 * Output (user layer, gitignored): data/learn-proposals.md
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROPOSALS_PATH = path.join(__dirname, 'data', 'learn-proposals.md');

const DEFAULT_MIN_N = 5;                 // sample floor before a proposal fires
const CONV_STRONG = 25;                  // % positive-conversion = "working"
const HIGH_N = 10, MED_N = 5;            // confidence bands

// ---------------------------------------------------------------------------
// Confidence + ranking (pure)
// ---------------------------------------------------------------------------

/** Sample size → confidence band. */
export function confidenceFor(n) {
  if (n >= HIGH_N) return 'high';
  if (n >= MED_N) return 'medium';
  return 'low';
}

const CONF_RANK = { high: 0, medium: 1, low: 2 };
const CAT_RANK = { targeting: 0, scoring: 1, channel: 2, comp: 3, cadence: 4, skills: 5 };

/** Stable ranking: confidence, then category priority, then sample size. */
export function rankProposals(proposals) {
  return [...proposals].sort((a, b) =>
    (CONF_RANK[a.confidence] - CONF_RANK[b.confidence]) ||
    ((CAT_RANK[a.category] ?? 9) - (CAT_RANK[b.category] ?? 9)) ||
    ((b.n || 0) - (a.n || 0)) ||
    a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Proposal generators (pure). Each guards on sample size and returns [] when
// the signal is absent or too thin — no noise on a fresh install.
// ---------------------------------------------------------------------------

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Archetype re-weighting from real outcomes. An archetype that scores well but
 * never advances is a targeting mismatch (down-weight); one that punches above
 * its volume is worth leaning into (up-weight).
 */
export function proposeArchetypeChanges(patterns, { minN = DEFAULT_MIN_N } = {}) {
  const rows = patterns?.archetypeBreakdown;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || r.archetype === 'Unknown' || (r.total || 0) < minN) continue;
    const conv = r.conversionRate ?? (r.total ? Math.round((r.positive / r.total) * 100) : 0);
    if (conv === 0) {
      out.push({
        id: `archetype-demote-${slug(r.archetype)}`,
        category: 'targeting',
        title: `Down-weight "${r.archetype}"`,
        target: 'config/profile.yml',
        knob: 'target_roles.archetypes[].fit',
        suggestion: `Demote "${r.archetype}" one fit tier (primary→secondary, or secondary→adjacent), or re-frame how you position for it. Every application to it has stalled at or before screening.`,
        evidence: [`${r.total} applications, 0 advanced past screening (0% conversion)`,
          `Positive: ${r.positive || 0} · Negative: ${r.negative || 0} · Pending: ${r.pending || 0}`],
        confidence: confidenceFor(r.total),
        n: r.total,
        gated: true,
      });
    } else if (conv >= CONV_STRONG) {
      out.push({
        id: `archetype-promote-${slug(r.archetype)}`,
        category: 'targeting',
        title: `Lean into "${r.archetype}"`,
        target: 'config/profile.yml',
        knob: 'target_roles.archetypes[].fit',
        suggestion: `Promote "${r.archetype}" (adjacent→secondary, or secondary→primary) and widen scan queries toward it — it converts at ${conv}%.`,
        evidence: [`${r.total} applications, ${r.positive} advanced (${conv}% conversion — above the ${CONV_STRONG}% "working" line)`],
        confidence: confidenceFor(r.total),
        n: r.total,
        gated: true,
      });
    }
  }
  return out;
}

/**
 * Apply/PDF score floor. If advanced applications cluster at a higher score
 * than rejected ones, the floor that separates them is a rational apply gate.
 */
export function proposeScoreThreshold(patterns, { minN = DEFAULT_MIN_N } = {}) {
  const sc = patterns?.scoreComparison;
  const pos = sc?.positive, neg = sc?.negative;
  if (!pos || !neg || (pos.count || 0) < minN) return [];
  // Only fire when advanced clearly outscore rejected and a clean floor exists.
  if (!(pos.avg > neg.avg + 0.2) || pos.min == null) return [];
  const floor = Math.max(3.0, Math.floor(pos.min * 10) / 10);
  return [{
    id: 'score-floor',
    category: 'scoring',
    title: `Set an apply/auto-PDF floor near ${floor.toFixed(1)}`,
    target: 'config/profile.yml',
    knob: 'auto_pdf_score_threshold',
    suggestion: `Advanced applications average ${pos.avg}/5 (min ${pos.min}); rejected average ${neg.avg}/5. Consider gating effort at ~${floor.toFixed(1)} so you spend tailoring/PDF time where it converts.`,
    evidence: [`Advanced: avg ${pos.avg}, min ${pos.min}, n=${pos.count}`,
      `Rejected: avg ${neg.avg}, n=${neg.count}`],
    confidence: confidenceFor(pos.count),
    n: pos.count,
    gated: false,
  }];
}

/**
 * Channel strategy from ATS-vendor and agency-vs-direct yield. A concentrated
 * channel that yields nothing is a diversion signal (Bommasani et al. — routed
 * rejections are correlated), not a "try harder" signal.
 */
export function proposeChannelStrategy(patterns) {
  const out = [];
  const vend = patterns?.vendorAnalysis;
  for (const v of vend?.breakdown || []) {
    if (!v?.sufficientSample) continue;
    if (v.advanceRate === 0 && v.total >= (vend.minSampleForClaim || DEFAULT_MIN_N)) {
      out.push({
        id: `channel-divert-${slug(v.vendor)}`,
        category: 'channel',
        title: `Route around ${v.vendor} (0% yield)`,
        target: 'modes/_profile.md',
        knob: 'channel strategy / portals.yml priority',
        suggestion: `${v.total} applications through ${v.vendor} (${v.sharePct}% of your volume) advanced 0. Prefer referral/direct contact for these companies over the ${v.vendor} portal, and lower their scan priority.`,
        evidence: [`${v.vendor}: ${v.advanced}/${v.total} advanced (0%) vs overall ${vend.overallAdvanceRate}%`],
        confidence: confidenceFor(v.total),
        n: v.total,
        gated: false,
      });
    }
  }
  const via = patterns?.viaChannelAnalysis;
  const directN = via?.directSubmitted || 0;
  const directAdv = via?.directAdvanced ?? null;
  for (const a of via?.breakdown || []) {
    if ((a.total || 0) < DEFAULT_MIN_N) continue;
    if (a.advanceRate === 0) {
      out.push({
        id: `agency-review-${slug(a.agency)}`,
        category: 'channel',
        title: `Reconsider agency "${a.agency}"`,
        target: 'modes/_profile.md',
        knob: 'channel strategy',
        suggestion: `Applications via ${a.agency} have not advanced (${a.advanced}/${a.total}). Invest that time in the channels that convert.`,
        evidence: [`${a.agency}: ${a.advanced}/${a.total} advanced (0%)`,
          directN ? `Direct: ${directAdv ?? '?'}/${directN} submitted` : 'No direct-channel baseline yet'],
        confidence: confidenceFor(a.total),
        n: a.total,
        gated: false,
      });
    }
  }
  return out;
}

/** Comp-target sanity from the salary-gap analyzer's desired/advertised deltas. */
export function proposeCompAdjustment(salary) {
  if (!salary || salary.error) return [];
  const desired = salary.desired?.mid ?? salary.desired?.min ?? null;
  const advertised = salary.advertised?.mid ?? salary.advertised?.median ?? null;
  const n = salary.advertised?.count ?? salary.counts?.advertised ?? 0;
  if (desired == null || advertised == null || n < 3) return [];
  if (advertised < desired * 0.9) {
    return [{
      id: 'comp-target-review',
      category: 'comp',
      title: 'Advertised comp trails your target',
      target: 'config/profile.yml',
      knob: 'compensation.target_range',
      suggestion: `The roles you're evaluating advertise ~${advertised} vs your target ~${desired}. Either aim at a higher-paying segment/seniority, or adjust the target to the market you're actually applying into.`,
      evidence: [`Advertised (n=${n}) ~${advertised} · Desired ~${desired}`],
      confidence: confidenceFor(n),
      n,
      gated: false,
    }];
  }
  return [];
}

/** Skill focus from the aggregate weighted gap map (informational, not scoring). */
export function proposeSkillFocus(upskill, { top = 5 } = {}) {
  const gaps = upskill?.gaps;
  if (!Array.isArray(gaps) || gaps.length === 0) return [];
  const picks = gaps.slice(0, top);
  const n = upskill?.metadata?.lowFitReports || picks.reduce((s, g) => s + (g.reports || 0), 0);
  return [{
    id: 'skill-focus',
    category: 'skills',
    title: `Close your top skill gaps: ${picks.map(g => g.skill).join(', ')}`,
    target: 'modes/_profile.md',
    knob: 'emphasis / upskill focus',
    suggestion: `These recur most in low-fit reports. Where you have real (even adjacent) experience, surface it more prominently in cv.md/article-digest.md; where you don't, this is your learning shortlist.`,
    evidence: picks.map(g => `${g.skill} — ${g.reports} report(s), weighted ${g.weightedScore}`),
    confidence: confidenceFor(n),
    n,
    gated: false,
  }];
}

/** Follow-up cadence from funnel ghosting/velocity. */
export function proposeCadence(funnel) {
  const waiting = funnel?.waiting;
  const ghostPct = waiting?.ghostedPct ?? waiting?.ghostPct ?? null;
  const rows = funnel?.dataQuality?.trackerRows || 0;
  if (ghostPct == null || rows < DEFAULT_MIN_N) return [];
  if (ghostPct >= 50) {
    return [{
      id: 'cadence-tighten',
      category: 'cadence',
      title: 'High ghosting — tighten follow-up cadence',
      target: 'config/profile.yml',
      knob: 'followup_cadence',
      suggestion: `~${ghostPct}% of applications go silent. A tighter first/second follow-up (e.g. applied_first_days 5, applied_subsequent_days 5) recovers some before they cool.`,
      evidence: [`Ghosted ~${ghostPct}% across ${rows} tracked rows`],
      confidence: confidenceFor(rows),
      n: rows,
      gated: false,
    }];
  }
  return [];
}

/** Run every generator and return the ranked, filtered proposal list. */
export function synthesizeProposals({ patterns, funnel, salary, upskill } = {}, opts = {}) {
  const minN = opts.minN ?? DEFAULT_MIN_N;
  let proposals = [
    ...proposeArchetypeChanges(patterns, { minN }),
    ...proposeScoreThreshold(patterns, { minN }),
    ...proposeChannelStrategy(patterns),
    ...proposeCompAdjustment(salary),
    ...proposeSkillFocus(upskill),
    ...proposeCadence(funnel),
  ];
  if (!opts.showLow) proposals = proposals.filter(p => p.confidence !== 'low');
  return rankProposals(proposals);
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

export function formatProposals(proposals, gate, meta = {}) {
  const L = [];
  L.push(`# Tuning proposals — ${meta.date || new Date().toISOString().slice(0, 10)}`);
  L.push('');
  if (gate) {
    const icon = gate.passed ? '✅' : '🔴';
    L.push(`**Scoring baseline (golden eval):** ${icon} ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.summary}`);
    if (!gate.passed) L.push('> ⚠️ A gated (scoring/targeting) change must NOT be applied while the baseline is red. Fix the regression first.');
    L.push('');
  }
  if (proposals.length === 0) {
    L.push('_No tuning proposals yet._ Either there isn\'t enough tracked outcome data, or nothing crossed the sample-size floor. Apply to more roles, ingest replies (`reply-watch`), then re-run.');
    return L.join('\n');
  }
  L.push('Each proposal is a reviewed suggestion — apply only what you approve. `gated` items change scoring/targeting; re-run the golden gate after editing.');
  L.push('');
  proposals.forEach((p, i) => {
    L.push(`## ${i + 1}. ${p.title}`);
    L.push(`- **Category:** ${p.category}${p.gated ? '  ·  🔒 gated (re-run golden eval after applying)' : ''}`);
    L.push(`- **Confidence:** ${p.confidence} (n=${p.n})`);
    L.push(`- **Where:** \`${p.target}\` → ${p.knob}`);
    L.push(`- **Suggestion:** ${p.suggestion}`);
    L.push(`- **Evidence:**`);
    for (const e of p.evidence) L.push(`  - ${e}`);
    L.push('');
  });
  L.push('---');
  L.push('_Proposals only — nothing here was written to your profile. The agent applies changes on your explicit approval._');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Input gathering + gate (impure)
// ---------------------------------------------------------------------------

function runJson(script, args = []) {
  try {
    const res = spawnSync('node', [script, ...args], { cwd: __dirname, encoding: 'utf-8', timeout: 120_000, env: process.env });
    if (res.status !== 0 || !res.stdout) return null;
    const data = JSON.parse(res.stdout);
    return data && data.error ? null : data;
  } catch { return null; }
}

function readCached(dir, name) {
  const p = path.join(path.isAbsolute(dir) ? dir : path.join(__dirname, dir), `${name}.json`);
  if (!existsSync(p)) return null;
  try { const d = JSON.parse(readFileSync(p, 'utf-8')); return d && d.error ? null : d; } catch { return null; }
}

function gatherInputs(opts) {
  if (opts.from) {
    return {
      patterns: readCached(opts.from, 'patterns'),
      funnel: readCached(opts.from, 'funnel'),
      salary: readCached(opts.from, 'salary'),
      upskill: readCached(opts.from, 'upskill'),
    };
  }
  return {
    patterns: runJson('analyze-patterns.mjs'),
    funnel: runJson('funnel-velocity.mjs'),
    salary: runJson('salary-gap.mjs'),
    upskill: runJson('upskill.mjs'),
  };
}

/** Run the golden-eval baseline (replay, $0). Returns {passed, summary}. */
export function runGoldenGate() {
  try {
    const res = spawnSync('node', ['eval-golden.mjs', '--replay', '--model', 'cheap-stub'],
      { cwd: __dirname, encoding: 'utf-8', timeout: 120_000, env: process.env });
    const text = `${res.stdout || ''}${res.stderr || ''}`;
    const agree = text.match(/archetype agreement\s*:\s*(\d+)%/);
    const summary = agree ? `archetype agreement ${agree[1]}%` : (res.status === 0 ? 'passed' : 'failed');
    return { passed: res.status === 0, summary };
  } catch (err) {
    return { passed: false, summary: `gate could not run — ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  const patterns = {
    archetypeBreakdown: [
      { archetype: 'AI Product Manager', total: 12, positive: 0, negative: 8, self_filtered: 0, pending: 4, conversionRate: 0 },
      { archetype: 'AI Platform Engineer', total: 8, positive: 3, negative: 3, self_filtered: 0, pending: 2, conversionRate: 38 },
      { archetype: 'Tiny', total: 2, positive: 0, negative: 2, self_filtered: 0, pending: 0, conversionRate: 0 },
    ],
    scoreComparison: { positive: { avg: 4.1, min: 3.6, max: 4.6, count: 6 }, negative: { avg: 3.3, min: 2.1, max: 4.0, count: 9 } },
    vendorAnalysis: { minSampleForClaim: 5, overallAdvanceRate: 20, breakdown: [{ vendor: 'workday', total: 7, advanced: 0, advanceRate: 0, sharePct: 40, sufficientSample: true }] },
    viaChannelAnalysis: { directSubmitted: 10, directAdvanced: 4, breakdown: [{ agency: 'Hays', total: 6, advanced: 0, advanceRate: 0 }] },
  };
  const proposals = synthesizeProposals({ patterns }, { minN: 5 });
  const fails = [];
  const has = (id) => proposals.some(p => p.id === id);
  if (!has('archetype-demote-ai-product-manager')) fails.push('missing archetype demote');
  if (!has('archetype-promote-ai-platform-engineer')) fails.push('missing archetype promote');
  if (has('archetype-demote-tiny')) fails.push('fired on sub-threshold sample (Tiny)');
  if (!has('score-floor')) fails.push('missing score floor');
  if (!has('channel-divert-workday')) fails.push('missing vendor divert');
  if (!has('agency-review-hays')) fails.push('missing agency review');
  if (proposals.some(p => p.gated && p.category !== 'targeting')) fails.push('non-targeting proposal wrongly gated');
  // ranking: high-confidence targeting should precede lower-confidence items
  if (proposals[0].confidence !== 'high') fails.push('ranking did not surface high-confidence first');

  if (fails.length) { console.error(`learn self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('learn self-test OK (generators, sample-size floors, gating, ranking)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { json: false, from: null, noGate: false, minN: DEFAULT_MIN_N, showLow: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a === '--json') out.json = true;
    else if (a === '--from' || a.startsWith('--from=')) out.from = val();
    else if (a === '--no-gate') out.noGate = true;
    else if (a === '--show-low') out.showLow = true;
    else if (a === '--min-n' || a.startsWith('--min-n=')) out.minN = parseInt(val(), 10) || DEFAULT_MIN_N;
    else if (a === '--self-test') out.selfTest = true;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) return runSelfTest();

  const inputs = gatherInputs(opts);
  const proposals = synthesizeProposals(inputs, { minN: opts.minN, showLow: opts.showLow });
  const gate = opts.noGate ? null : runGoldenGate();
  const date = new Date().toISOString().slice(0, 10);
  const md = formatProposals(proposals, gate, { date });

  try { mkdirSync(path.dirname(PROPOSALS_PATH), { recursive: true }); writeFileSync(PROPOSALS_PATH, md, 'utf-8'); } catch { /* non-fatal */ }

  if (opts.json) {
    console.log(JSON.stringify({ date, gate, count: proposals.length, proposals }, null, 2));
  } else {
    console.log('\n' + md);
    console.log(`\n(written to ${path.relative(__dirname, PROPOSALS_PATH)})`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
