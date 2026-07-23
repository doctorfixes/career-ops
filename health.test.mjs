/**
 * health.test.mjs — tests for the pipeline health score.
 * Run: node health.test.mjs
 */

import { computeHealth, gradeFor, formatHealth, healthLine, signalsFromStats } from './health.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }
const check = (h, name) => h.checks.find((c) => c.name === name);

// ── grade bands ──────────────────────────────────────────────────────────────
eq('grade A', gradeFor(95), 'A');
eq('grade B', gradeFor(82), 'B');
eq('grade C', gradeFor(70), 'C');
eq('grade D', gradeFor(55), 'D');
eq('grade F', gradeFor(40), 'F');

// ── perfect pipeline ─────────────────────────────────────────────────────────
const perfect = computeHealth({ trackerTotal: 10, applied: 5, appliedWithoutFollowup: 0, reportPct: 100, nonCanonical: 0, pipelinePending: 3, repliesPending: 0 });
eq('healthy pipeline scores 100', perfect.score, 100);
eq('healthy pipeline grade A', perfect.grade, 'A');
ok('all checks ok when healthy', perfect.checks.every((c) => c.status === 'ok'));

// ── each deduction fires independently ───────────────────────────────────────
eq('all-missing follow-ups deducts 25', check(computeHealth({ applied: 8, appliedWithoutFollowup: 8, trackerTotal: 8, reportPct: 100 }), 'follow-up compliance').deduction, 25);
eq('half-missing follow-ups warns', check(computeHealth({ applied: 8, appliedWithoutFollowup: 4, trackerTotal: 8, reportPct: 100 }), 'follow-up compliance').status, 'warn');
eq('zero report coverage caps at 15', check(computeHealth({ trackerTotal: 10, reportPct: 0 }), 'report coverage').deduction, 15);
eq('non-canonical statuses fail + cap 20', (() => { const c = check(computeHealth({ trackerTotal: 10, nonCanonical: 9, reportPct: 100 }), 'status hygiene'); return [c.status, c.deduction]; })(), ['fail', 20]);
eq('replies pending warns + caps 10', (() => { const c = check(computeHealth({ trackerTotal: 5, reportPct: 100, repliesPending: 20 }), 'reply triage'); return [c.status, c.deduction]; })(), ['warn', 10]);
eq('pipeline backlog only past threshold', check(computeHealth({ trackerTotal: 5, reportPct: 100, pipelinePending: 40 }), 'pipeline backlog').deduction, 0);
ok('pipeline backlog deducts above threshold', check(computeHealth({ trackerTotal: 5, reportPct: 100, pipelinePending: 90 }), 'pipeline backlog').deduction > 0);

// ── empty pipeline is not penalized ──────────────────────────────────────────
const empty = computeHealth({ trackerTotal: 0, applied: 0 });
eq('empty pipeline still 100', empty.score, 100);
eq('no applied → follow-up ok', check(empty, 'follow-up compliance').status, 'ok');
eq('no rows → report coverage ok', check(empty, 'report coverage').status, 'ok');

// ── drift scores lower + never below 0 ───────────────────────────────────────
const drift = computeHealth({ trackerTotal: 20, applied: 10, appliedWithoutFollowup: 10, reportPct: 30, nonCanonical: 5, pipelinePending: 200, repliesPending: 10 });
ok('drift scores below perfect', drift.score < perfect.score);
ok('score floored at 0', drift.score >= 0);
ok('score is an integer', Number.isInteger(drift.score));

// ── signalsFromStats mapping ─────────────────────────────────────────────────
const sig = signalsFromStats({ tracker: { total: 12, reportPct: 75, byStatus: { Applied: 4, Unknown: 2 } }, followups: { appliedWithoutFollowup: 1 } }, { pipelinePending: 6, repliesPending: 3 });
eq('maps applied from byStatus', sig.applied, 4);
eq('maps nonCanonical from Unknown bucket', sig.nonCanonical, 2);
eq('maps reportPct', sig.reportPct, 75);
eq('threads pipeline/replies extras', [sig.pipelinePending, sig.repliesPending], [6, 3]);
eq('missing stats → safe defaults', signalsFromStats(null), { trackerTotal: 0, applied: 0, appliedWithoutFollowup: 0, reportPct: 100, nonCanonical: 0, pipelinePending: 0, repliesPending: 0 });

// ── formatting ───────────────────────────────────────────────────────────────
ok('format shows score + grade', formatHealth(drift).includes('/100'));
ok('format lists a fix-first', formatHealth(drift).includes('Fix first'));
ok('healthLine one-liner with watch list', healthLine(drift).includes('watch:'));
ok('healthLine clean when perfect', healthLine(perfect) === 'Pipeline health: 100/100 (A)');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
