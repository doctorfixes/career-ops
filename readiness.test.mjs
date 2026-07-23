/**
 * readiness.test.mjs — tests for the readiness scorer's pure logic.
 * Run: node readiness.test.mjs
 */

import {
  CHECKS, evaluateReadiness, scoreGates, formatReadiness,
  MIN_OUTCOMES, HEALTH_MIN, ACTIVE_MIN, SEVERE_CONV_PCT,
} from './readiness.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }
const byId = (results, id) => results.find((r) => r.id === id);

// ── check inventory mirrors the checklist (23 items, 9 measurable) ───────────
eq('23 checks total', CHECKS.length, 23);
eq('9 measurable checks', CHECKS.filter((c) => c.kind === 'measurable').length, 9);
eq('14 self-assessed checks', CHECKS.filter((c) => c.kind === 'self').length, 14);
ok('every check has a gate 1-4', CHECKS.every((c) => [1, 2, 3, 4].includes(c.gate)));

// ── all-pass signals ─────────────────────────────────────────────────────────
const good = {
  cvFactsOk: true, doctorReady: true, orchestratorRuns: 5, everApplied: 40, goldenPass: true,
  healthScore: 92, conversionHasSample: true, bottleneckPct: 22, activeInterviews: 3,
  compDesired: 180, compAdvertised: 185,
};
const gr = evaluateReadiness(good);
const gs = scoreGates(gr);
eq('all measurable pass', gs.overall.measurablePassed, 9);
ok('push-ready when gates 1-2 pass', gs.overall.pushReady);
ok('leverage-ready when gates 3-4 pass', gs.overall.leverageReady);
ok('every gate ready', [1, 2, 3, 4].every((g) => gs.gates[g].ready));
eq('self items still counted', gs.overall.selfTotal, 14);

// ── thresholds are boundaries, not vibes ─────────────────────────────────────
eq('outcomes exactly at floor passes', byId(evaluateReadiness({ ...good, everApplied: MIN_OUTCOMES }), 'outcomes-volume').status, 'pass');
eq('outcomes below floor fails', byId(evaluateReadiness({ ...good, everApplied: MIN_OUTCOMES - 1 }), 'outcomes-volume').status, 'fail');
eq('health at floor passes', byId(evaluateReadiness({ ...good, healthScore: HEALTH_MIN }), 'pipeline-health').status, 'pass');
eq('health below floor fails', byId(evaluateReadiness({ ...good, healthScore: HEALTH_MIN - 1 }), 'pipeline-health').status, 'fail');
eq('active at floor passes', byId(evaluateReadiness({ ...good, activeInterviews: ACTIVE_MIN }), 'concurrent-processes').status, 'pass');
eq('active below floor fails', byId(evaluateReadiness({ ...good, activeInterviews: ACTIVE_MIN - 1 }), 'concurrent-processes').status, 'fail');

// ── conversion bottleneck ────────────────────────────────────────────────────
eq('severe bottleneck fails', byId(evaluateReadiness({ ...good, bottleneckPct: SEVERE_CONV_PCT - 1 }), 'conversion-fit').status, 'fail');
eq('healthy conversion passes', byId(evaluateReadiness({ ...good, bottleneckPct: 30 }), 'conversion-fit').status, 'pass');
eq('no funnel sample → unknown', byId(evaluateReadiness({ ...good, conversionHasSample: false }), 'conversion-fit').status, 'unknown');

// ── comp segment ─────────────────────────────────────────────────────────────
eq('advertised meeting target passes', byId(evaluateReadiness({ ...good, compDesired: 200, compAdvertised: 190 }), 'comp-segment').status, 'pass');
eq('advertised trailing target fails', byId(evaluateReadiness({ ...good, compDesired: 200, compAdvertised: 150 }), 'comp-segment').status, 'fail');
eq('no comp data → unknown', byId(evaluateReadiness({ ...good, compDesired: null }), 'comp-segment').status, 'unknown');

// ── unknown is never a pass ─────────────────────────────────────────────────
const noData = { cvFactsOk: null, doctorReady: null, orchestratorRuns: null, everApplied: null, goldenPass: null, healthScore: null, conversionHasSample: false, bottleneckPct: null, activeInterviews: null, compDesired: null, compAdvertised: null };
const ns = scoreGates(evaluateReadiness(noData));
eq('no data → zero measurable passed', ns.overall.measurablePassed, 0);
ok('no data → not push ready', !ns.overall.pushReady);
ok('no data → no gate ready', [1, 2, 3, 4].every((g) => !ns.gates[g].ready));
eq('unknown status rendered, not counted as fail', evaluateReadiness(noData).filter((r) => r.status === 'unknown').length, 9);

// ── one failure isolates to its gate ─────────────────────────────────────────
const oneBad = scoreGates(evaluateReadiness({ ...good, healthScore: 40 }));
ok('failing health breaks Gate 2', !oneBad.gates[2].ready);
ok('Gate 1 unaffected', oneBad.gates[1].ready);
ok('push-ready false when Gate 2 fails', !oneBad.overall.pushReady);
ok('leverage-ready unaffected by Gate 2', oneBad.overall.leverageReady);

// ── self items are never auto-scored pass/fail ───────────────────────────────
ok('self items carry self status', gr.filter((r) => r.kind === 'self').every((r) => r.status === 'self'));

// ── formatting ───────────────────────────────────────────────────────────────
const md = formatReadiness(gr, gs);
ok('renders four gates', ['Gate 1', 'Gate 2', 'Gate 3', 'Gate 4'].every((s) => md.includes(s)));
ok('shows push-ready check', md.includes('Ready to push hard'));
ok('explains self items', md.includes('self-assess in data/readiness.md'));
ok('fix-next appears when something fails', formatReadiness(evaluateReadiness({ ...good, healthScore: 40 }), oneBad).includes('Fix next'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
