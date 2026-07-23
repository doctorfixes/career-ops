/**
 * weekly-review.test.mjs — tests for the strategic growth digest.
 * Run: node weekly-review.test.mjs
 */

import { computeConcentration, buildReview, formatReview } from './weekly-review.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

// ── concentration guard ──────────────────────────────────────────────────────
const conc = computeConcentration({
  archetypeBreakdown: [
    { archetype: 'AI PM', total: 14, positive: 0, conversionRate: 0 },
    { archetype: 'Platform', total: 6, positive: 2, conversionRate: 33 },
  ],
  vendorAnalysis: { overallAdvanceRate: 15, breakdown: [{ vendor: 'workday', total: 12, advanced: 0, advanceRate: 0, sharePct: 55, sufficientSample: true }] },
});
eq('top archetype identified', conc.archetype.top, 'AI PM');
eq('archetype share computed', conc.archetype.sharePct, 70);
ok('archetype concentration flagged (70% ≥ 50%)', conc.archetype.flagged);
eq('top vendor identified', conc.vendor.top, 'workday');
ok('vendor monoculture flagged (55%, 0% advance ≤ overall)', conc.vendor.flagged);
eq('two concentration flags produced', conc.flags.length, 2);

// not flagged when spread out
const spread = computeConcentration({
  archetypeBreakdown: [{ archetype: 'A', total: 5, conversionRate: 20 }, { archetype: 'B', total: 5, conversionRate: 20 }, { archetype: 'C', total: 5, conversionRate: 20 }],
  vendorAnalysis: { overallAdvanceRate: 20, breakdown: [{ vendor: 'ashby', total: 5, advanceRate: 25, sharePct: 30 }] },
});
ok('balanced archetypes not flagged', !spread.archetype.flagged);
ok('converting vendor not flagged even if share high-ish', !spread.vendor.flagged);
eq('no flags when balanced', spread.flags.length, 0);

// single archetype (only one) is not "concentration" to act on
const single = computeConcentration({ archetypeBreakdown: [{ archetype: 'Only', total: 10, conversionRate: 30 }] });
ok('single archetype not flagged (nothing to diversify into)', !single.archetype.flagged);

// missing data → nulls, no crash
const empty = computeConcentration({});
eq('empty patterns → no archetype/vendor', [empty.archetype, empty.vendor, empty.flags.length], [null, null, 0]);

// ── buildReview ──────────────────────────────────────────────────────────────
const review = buildReview({
  stats: { funnel: { everApplied: 20, responseRate: 5, interviewRate: 0, offerRate: 0 }, tracker: { total: 20, active: 18 } },
  learn: { proposals: [
    { title: 'Down-weight "AI PM"', confidence: 'high', category: 'targeting' },
    { title: 'Route around workday', confidence: 'medium', category: 'channel' },
  ] },
  patterns: {
    archetypeBreakdown: [{ archetype: 'AI PM', total: 14, conversionRate: 0 }, { archetype: 'Platform', total: 6, conversionRate: 33 }],
    vendorAnalysis: { overallAdvanceRate: 15, breakdown: [{ vendor: 'workday', total: 12, advanceRate: 0, sharePct: 55 }] },
  },
  tuning: { churn: [{ knob: 'auto_pdf_score_threshold', changes: 3, churnFlag: true }, { knob: 'stable', changes: 1, churnFlag: false }] },
  date: '2026-07-23',
});
eq('funnel carried through', review.funnel.responseRate, 5);
eq('top proposals capped and mapped', review.topProposals.length, 2);
eq('only churn-flagged knobs surfaced', review.churnFlags.map((c) => c.knob), ['auto_pdf_score_threshold']);
ok('actions include proposal review', review.actions.some((a) => /tuning proposal/.test(a)));
ok('actions include concentration flags', review.actions.some((a) => /monoculture|concentration/i.test(a)));
ok('actions include churn hold advice', review.actions.some((a) => /flip-flopping|noise/i.test(a)));
ok('actions include low-response lever', review.actions.some((a) => /response rate/i.test(a)));

// clean state → single "nothing flagged" action
const clean = buildReview({ stats: { funnel: { everApplied: 3, responseRate: 33 }, tracker: { total: 3, active: 3 } }, learn: { proposals: [] }, patterns: {}, tuning: { churn: [] } });
ok('clean review has a nothing-flagged action', clean.actions.some((a) => /Nothing flagged/.test(a)));

// ── formatReview ─────────────────────────────────────────────────────────────
const md = formatReview(review);
ok('renders all five sections', ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.'].every((s) => md.includes(s)));
ok('renders monoculture warning', /monoculture risk/.test(md));
ok('renders churn warning', /Flip-flopping knobs/.test(md));
ok('read-only footer present', /Read-only strategic review/.test(md));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
