/**
 * learn.test.mjs — tests for the calibration engine's pure synthesis logic.
 * The impure parts (spawning analytics, the golden gate) are exercised by the
 * tool and the self-test; here we lock down the generators, sample-size floors,
 * gating, ranking, and formatting.
 *
 * Run: node learn.test.mjs
 */

import {
  confidenceFor, rankProposals, proposeArchetypeChanges, proposeScoreThreshold,
  proposeChannelStrategy, proposeCompAdjustment, proposeSkillFocus, proposeCadence,
  synthesizeProposals, formatProposals, parseArgs,
} from './learn.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

// ── confidence bands ────────────────────────────────────────────────────────
eq('confidence high', confidenceFor(10), 'high');
eq('confidence medium', confidenceFor(5), 'medium');
eq('confidence low', confidenceFor(4), 'low');

// ── archetype changes: demote 0-conversion, promote strong, respect floor ────
const arche = {
  archetypeBreakdown: [
    { archetype: 'AI Product Manager', total: 9, positive: 0, negative: 6, self_filtered: 0, pending: 3, conversionRate: 0 },
    { archetype: 'AI Platform Engineer', total: 8, positive: 3, negative: 3, self_filtered: 0, pending: 2, conversionRate: 38 },
    { archetype: 'Thin', total: 2, positive: 0, negative: 2, self_filtered: 0, pending: 0, conversionRate: 0 },
    { archetype: 'Unknown', total: 20, positive: 0, negative: 20, self_filtered: 0, pending: 0, conversionRate: 0 },
  ],
};
const ap = proposeArchetypeChanges(arche, { minN: 5 });
ok('demotes 0-conversion archetype', ap.some(p => p.id === 'archetype-demote-ai-product-manager'));
ok('promotes strong archetype', ap.some(p => p.id === 'archetype-promote-ai-platform-engineer'));
ok('skips sub-threshold sample', !ap.some(p => p.id === 'archetype-demote-thin'));
ok('skips Unknown archetype', !ap.some(p => /unknown/i.test(p.id)));
ok('archetype changes are gated', ap.every(p => p.gated === true));
eq('archetype targets profile.yml', ap[0].target, 'config/profile.yml');

// ── score threshold: only when advanced outscore rejected ────────────────────
const st = proposeScoreThreshold({ scoreComparison: { positive: { avg: 4.1, min: 3.6, max: 4.6, count: 6 }, negative: { avg: 3.3, min: 2.0, max: 4.0, count: 9 } } }, { minN: 5 });
ok('proposes a score floor', st.length === 1 && st[0].id === 'score-floor');
ok('floor is at least 3.0', st.length === 1);
ok('score floor is not gated (operational)', st[0].gated === false);
eq('no floor when advanced do not outscore', proposeScoreThreshold({ scoreComparison: { positive: { avg: 3.4, min: 2.0, count: 6 }, negative: { avg: 3.3, min: 2.0, count: 6 } } }), []);
eq('no floor under sample floor', proposeScoreThreshold({ scoreComparison: { positive: { avg: 4.1, min: 3.6, count: 3 }, negative: { avg: 3.0, min: 2.0, count: 3 } } }, { minN: 5 }), []);

// ── channel strategy: vendor divert + agency review ─────────────────────────
const chan = proposeChannelStrategy({
  vendorAnalysis: { minSampleForClaim: 5, overallAdvanceRate: 20, breakdown: [
    { vendor: 'workday', total: 7, advanced: 0, advanceRate: 0, sharePct: 40, sufficientSample: true },
    { vendor: 'ashby', total: 6, advanced: 2, advanceRate: 33, sharePct: 20, sufficientSample: true },
    { vendor: 'lever', total: 3, advanced: 0, advanceRate: 0, sharePct: 10, sufficientSample: false },
  ] },
  viaChannelAnalysis: { directSubmitted: 10, directAdvanced: 4, breakdown: [{ agency: 'Hays', total: 6, advanced: 0, advanceRate: 0 }] },
});
ok('diverts 0-yield vendor with enough sample', chan.some(p => p.id === 'channel-divert-workday'));
ok('does not divert a converting vendor', !chan.some(p => p.id === 'channel-divert-ashby'));
ok('does not divert insufficient-sample vendor', !chan.some(p => p.id === 'channel-divert-lever'));
ok('flags 0-yield agency', chan.some(p => p.id === 'agency-review-hays'));

// ── comp adjustment ──────────────────────────────────────────────────────────
eq('comp fires when advertised trails desired', proposeCompAdjustment({ desired: { mid: 180 }, advertised: { mid: 150, count: 5 } }).length, 1);
eq('comp silent when advertised meets desired', proposeCompAdjustment({ desired: { mid: 150 }, advertised: { mid: 155, count: 5 } }), []);
eq('comp silent under sample floor', proposeCompAdjustment({ desired: { mid: 180 }, advertised: { mid: 150, count: 2 } }), []);
eq('comp silent on error', proposeCompAdjustment({ error: 'no data' }), []);

// ── skill focus ──────────────────────────────────────────────────────────────
const sk = proposeSkillFocus({ metadata: { lowFitReports: 12 }, gaps: [
  { skill: 'Kubernetes', reports: 8, weightedScore: 12.3 }, { skill: 'Terraform', reports: 5, weightedScore: 7.1 },
] });
eq('skill focus produced', sk.length, 1);
ok('skill focus names top gaps', sk[0].title.includes('Kubernetes'));
ok('skill focus not gated', sk[0].gated === false);
eq('skill focus silent with no gaps', proposeSkillFocus({ gaps: [] }), []);

// ── cadence ──────────────────────────────────────────────────────────────────
eq('cadence fires on high ghosting', proposeCadence({ waiting: { ghostedPct: 61 }, dataQuality: { trackerRows: 20 } }).length, 1);
eq('cadence silent on low ghosting', proposeCadence({ waiting: { ghostedPct: 20 }, dataQuality: { trackerRows: 20 } }), []);
eq('cadence silent without data', proposeCadence({ waiting: {}, dataQuality: { trackerRows: 0 } }), []);

// ── synthesize: ranking + low-confidence filtering ──────────────────────────
const all = synthesizeProposals({ patterns: arche }, { minN: 5 });
const CONF = { high: 0, medium: 1, low: 2 };
ok('proposals ordered by confidence (non-decreasing)', all.every((p, i) => i === 0 || CONF[all[i - 1].confidence] <= CONF[p.confidence]));
ok('low-confidence filtered out by default', all.every(p => p.confidence !== 'low'));
ok('showLow includes low-confidence', synthesizeProposals({ patterns: { archetypeBreakdown: [{ archetype: 'X', total: 4, positive: 0, negative: 4, conversionRate: 0 }] } }, { minN: 3, showLow: true }).length >= 1);
eq('empty inputs → no proposals', synthesizeProposals({}), []);

// rankProposals ordering is deterministic
const r = rankProposals([
  { id: 'b', category: 'scoring', confidence: 'medium', n: 5 },
  { id: 'a', category: 'targeting', confidence: 'high', n: 8 },
  { id: 'c', category: 'channel', confidence: 'high', n: 20 },
]);
// both c and a are high-confidence; category tiebreak puts targeting (a) before channel (c)
eq('rank: high confidence before medium, targeting before channel', r.map(p => p.id), ['a', 'c', 'b']);

// ── formatting ───────────────────────────────────────────────────────────────
const md = formatProposals(all, { passed: true, summary: 'archetype agreement 90%' }, { date: '2026-07-23' });
ok('format shows gate pass', md.includes('✅ PASS'));
ok('format marks gated items', md.includes('🔒 gated'));
ok('format has propose-only footer', /Proposals only/.test(md));
const mdFail = formatProposals(all, { passed: false, summary: 'archetype agreement 60%' });
ok('format warns on red baseline', mdFail.includes('must NOT be applied'));
const mdEmpty = formatProposals([], { passed: true, summary: 'ok' });
ok('empty proposals message', /No tuning proposals yet/.test(mdEmpty));

// ── parseArgs ────────────────────────────────────────────────────────────────
eq('args --from + --no-gate', (() => { const o = parseArgs(['--from', './d', '--no-gate']); return [o.from, o.noGate]; })(), ['./d', true]);
eq('args --min-n + --show-low + --json', (() => { const o = parseArgs(['--min-n', '8', '--show-low', '--json']); return [o.minN, o.showLow, o.json]; })(), [8, true, true]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
