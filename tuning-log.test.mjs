/**
 * tuning-log.test.mjs — tests for the calibration provenance ledger.
 * Run: node tuning-log.test.mjs
 */

import {
  COLUMNS, sanitize, serializeRow, parseLog, appendRowToTsv, analyzeChurn,
  formatSummary, parseAddArgs,
} from './tuning-log.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

// ── sanitize / serialize ────────────────────────────────────────────────────
eq('sanitize strips tabs/newlines', sanitize('a\tb\nc'), 'a b c');
eq('serializeRow has full column width', serializeRow({ knob: 'x', note: 'multi\tval' }).split('\t').length, COLUMNS.length);
ok('serializeRow places knob in the knob column', serializeRow({ knob: 'kkk' }).split('\t')[COLUMNS.indexOf('knob')] === 'kkk');

// ── append + parse round-trip ───────────────────────────────────────────────
let tsv = '';
tsv = appendRowToTsv(tsv, { date: '2026-07-01', knob: 'k1', old_value: '1', new_value: '2', confidence: 'high' });
ok('first append writes a header', tsv.startsWith('date\t'));
tsv = appendRowToTsv(tsv, { date: '2026-07-02', knob: 'k2', old_value: 'a', new_value: 'b' });
const rows = parseLog(tsv);
eq('parse count', rows.length, 2);
eq('parse first knob', rows[0].knob, 'k1');
eq('parse maps columns', [rows[0].old_value, rows[0].new_value, rows[0].confidence], ['1', '2', 'high']);
eq('parseLog ignores header-only', parseLog('date\tproposal_id\tcategory\tknob\ttarget\told_value\tnew_value\tconfidence\tgolden_gate\tevidence\tnote'), []);
eq('parseLog handles empty', parseLog(''), []);

// ── churn / flip-flop ────────────────────────────────────────────────────────
let ff = '';
ff = appendRowToTsv(ff, { date: '2026-07-01', knob: 'thr', old_value: '3.0', new_value: '3.7' });
ff = appendRowToTsv(ff, { date: '2026-07-08', knob: 'thr', old_value: '3.7', new_value: '3.0' });
ff = appendRowToTsv(ff, { date: '2026-07-15', knob: 'thr', old_value: '3.0', new_value: '3.7' });
const c = analyzeChurn(parseLog(ff)).find((x) => x.knob === 'thr');
eq('churn counts changes', c.changes, 3);
ok('flip-flop detected', c.flipFlop);
ok('churn flag raised at 3 revisited changes', c.churnFlag);
eq('lastValue tracked', c.lastValue, '3.7');

// stable knob (monotonic, few changes) is not flagged
let stable = '';
stable = appendRowToTsv(stable, { date: '2026-07-01', knob: 'comp', old_value: '150', new_value: '160' });
stable = appendRowToTsv(stable, { date: '2026-07-08', knob: 'comp', old_value: '160', new_value: '170' });
const sc = analyzeChurn(parseLog(stable)).find((x) => x.knob === 'comp');
ok('monotonic knob not flip-flopped', !sc.flipFlop);
ok('monotonic knob under churn threshold not flagged', !sc.churnFlag);

// a knob changed 3× but always to NEW distinct values (no revisit) → not flip-flop
let drift = '';
for (const [d, o, n] of [['a', '1', '2'], ['b', '2', '3'], ['c', '3', '4']]) drift = appendRowToTsv(drift, { date: d, knob: 'd', old_value: o, new_value: n });
const dc = analyzeChurn(parseLog(drift)).find((x) => x.knob === 'd');
ok('monotonic drift is not a flip-flop', !dc.flipFlop);
ok('monotonic drift (all distinct) not churn-flagged', !dc.churnFlag);

// ── formatting ──────────────────────────────────────────────────────────────
ok('summary flags churn', formatSummary(parseLog(ff), analyzeChurn(parseLog(ff))).includes('Churn detected'));
ok('summary clean when stable', formatSummary(parseLog(stable), analyzeChurn(parseLog(stable))).includes('No churn'));
ok('summary empty message', formatSummary([], []).includes('nothing yet'));

// ── parseAddArgs ─────────────────────────────────────────────────────────────
const e = parseAddArgs(['--knob', 'auto_pdf_score_threshold', '--old', '3.0', '--new', '3.7', '--proposal', 'score-floor', '--gate', 'pass', '--evidence', 'x y z']);
eq('add args map knob/old/new', [e.knob, e.old_value, e.new_value], ['auto_pdf_score_threshold', '3.0', '3.7']);
eq('add args map proposal/gate/evidence', [e.proposal_id, e.golden_gate, e.evidence], ['score-floor', 'pass', 'x y z']);
ok('add args default date', /^\d{4}-\d{2}-\d{2}$/.test(e.date));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
