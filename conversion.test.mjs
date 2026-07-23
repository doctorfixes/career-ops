/**
 * conversion.test.mjs — tests for stage-to-stage conversion + bottleneck.
 * Run: node conversion.test.mjs
 */

import { computeStageConversion, attachVelocity, formatConversion } from './conversion.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

// ── per-hop math ─────────────────────────────────────────────────────────────
const c = computeStageConversion({ everApplied: 40, everResponded: 20, everInterview: 10, everOffer: 1 }, { minN: 5 });
eq('A→R conversion', c.hops[0].conversionPct, 50);
eq('R→I conversion', c.hops[1].conversionPct, 50);
eq('I→O conversion', c.hops[2].conversionPct, 10);
eq('A→R lost count', c.hops[0].lost, 20);
eq('overall applied→offer', c.overallAppliedToOffer, 3);

// ── bottleneck ───────────────────────────────────────────────────────────────
eq('bottleneck is the weakest trustworthy hop', c.bottleneck.hop, 'interview-offer');
ok('bottleneck carries a lever', /interview prep|negotiation/i.test(c.bottleneck.lever));

// weakest hop that is below sample floor is NOT chosen
const c2 = computeStageConversion({ everApplied: 30, everResponded: 15, everInterview: 3, everOffer: 0 }, { minN: 5 });
// interview→offer would be 0% but interview n=3 < 5 → untrusted; bottleneck falls to a trusted hop
ok('sub-threshold hop excluded from bottleneck', c2.bottleneck.hop !== 'interview-offer');
ok('interview-offer hop marked untrusted', c2.hops[2].trusted === false);

// no data at all → no bottleneck, null conversions
const c3 = computeStageConversion({});
eq('empty funnel → null conversions', c3.hops.map((h) => h.conversionPct), [null, null, null]);
eq('empty funnel → no bottleneck', c3.bottleneck, null);
eq('empty funnel → overall null', c3.overallAppliedToOffer, null);

// divide-by-zero safety: responded=0 but interview somehow 0 → null not NaN/Infinity
const c4 = computeStageConversion({ everApplied: 10, everResponded: 0, everInterview: 0, everOffer: 0 }, { minN: 1 });
eq('zero-from hop yields null conversion', c4.hops[1].conversionPct, null);

// ── velocity fold-in ─────────────────────────────────────────────────────────
const withV = attachVelocity(computeStageConversion({ everApplied: 10, everResponded: 6, everInterview: 3, everOffer: 1 }, { minN: 1 }),
  { velocity: { appliedToResponded: { median: 4 }, interviewToOffer: { median: 12 } } });
eq('A→R median attached', withV.hops[0].medianDays, 4);
eq('I→O median attached', withV.hops[2].medianDays, 12);
ok('missing median leaves hop without medianDays', withV.hops[1].medianDays === undefined);
eq('attachVelocity no-op without velocity', attachVelocity(c, {}).hops[0].medianDays, undefined);

// ── formatting ───────────────────────────────────────────────────────────────
const md = formatConversion(c);
ok('format shows a hop line', md.includes('Applied → Responded: 50%'));
ok('format shows overall', md.includes('Overall Applied → Offer: 3%'));
ok('format flags weakest hop', md.includes('Weakest hop'));
ok('format shows no-bottleneck message when empty', formatConversion(c3).includes('Not enough data'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
