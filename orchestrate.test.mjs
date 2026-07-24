/**
 * orchestrate.test.mjs — tests for the pure planning/inspection helpers of the
 * orchestrator. The impure step runners (spawn, liveness, digest writers) are
 * exercised end-to-end by the tool itself; here we lock down the logic that
 * decides WHAT runs and HOW the digest is shaped.
 *
 * Run: node orchestrate.test.mjs
 */

import {
  parseArgs, parseRepliesSpec, buildPlan, DEFAULT_STEPS,
  countPipelineEntries, pendingPipelineUrls, summarizeTracker,
  countReplyCandidates, buildDigest, formatDigest,
} from './orchestrate.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++; failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

// ── parseArgs ──────────────────────────────────────────────────────────────
eq('parseArgs defaults', parseArgs([]), {
  only: null, skip: [], dryRun: false, json: false, quiet: false,
  strict: false, noPlugins: false, livenessLimit: 25, replies: null,
});
eq('parseArgs --only splits', parseArgs(['--only', 'scan,liveness']).only, ['scan', 'liveness']);
eq('parseArgs --only= form', parseArgs(['--only=scan']).only, ['scan']);
eq('parseArgs --skip accumulates', parseArgs(['--skip', 'export', '--skip=merge']).skip, ['export', 'merge']);
ok('parseArgs flags', (() => {
  const o = parseArgs(['--dry-run', '--json', '--quiet', '--strict', '--no-plugins']);
  return o.dryRun && o.json && o.quiet && o.strict && o.noPlugins;
})());
eq('parseArgs --liveness-limit', parseArgs(['--liveness-limit', '40']).livenessLimit, 40);
eq('parseArgs bad liveness-limit keeps default', parseArgs(['--liveness-limit', 'x']).livenessLimit, 25);

// ── parseRepliesSpec ────────────────────────────────────────────────────────
eq('replies bare source', parseRepliesSpec('gmail'), { source: 'gmail', arg: null });
eq('replies source:arg', parseRepliesSpec('eml:./mail'), { source: 'eml', arg: './mail' });
eq('replies keeps path colons', parseRepliesSpec('mbox:/var/mail/inbox.mbox'), { source: 'mbox', arg: '/var/mail/inbox.mbox' });
eq('replies empty → null', parseRepliesSpec(''), null);

// ── buildPlan ───────────────────────────────────────────────────────────────
const noPlugins = { enabledIngest: [], enabledExport: [] };
const withPlugins = { enabledIngest: ['gmail'], enabledExport: ['notion'] };

eq('default plan step ids (no plugins enabled)',
  buildPlan(parseArgs([]), noPlugins).map(s => s.id),
  ['scan', 'liveness', 'merge', 'followups']);

eq('default plan expands enabled plugins in order',
  buildPlan(parseArgs([]), withPlugins).map(s => s.id),
  ['scan', 'ingest:gmail', 'liveness', 'merge', 'followups', 'export:notion']);

eq('--no-plugins drops ingest/export even when enabled',
  buildPlan(parseArgs(['--no-plugins']), withPlugins).map(s => s.id),
  ['scan', 'liveness', 'merge', 'followups']);

eq('--only restricts',
  buildPlan(parseArgs(['--only', 'scan,liveness']), withPlugins).map(s => s.id),
  ['scan', 'liveness']);

eq('--skip removes',
  buildPlan(parseArgs(['--skip', 'liveness']), noPlugins).map(s => s.id),
  ['scan', 'merge', 'followups']);

eq('replies step is opt-in (absent by default)',
  buildPlan(parseArgs([]), noPlugins).some(s => s.id === 'replies'), false);

eq('replies step appears with --replies',
  buildPlan(parseArgs(['--replies', 'eml:./mail']), noPlugins).map(s => s.id),
  ['scan', 'liveness', 'merge', 'followups', 'replies']);

eq('replies step carries the right args',
  buildPlan(parseArgs(['--replies', 'eml:./mail']), noPlugins).find(s => s.id === 'replies').args,
  ['--source', 'eml', './mail']);

ok('digest is never a spawn step', !buildPlan(parseArgs([]), withPlugins).some(s => s.id === 'digest'));
ok('DEFAULT_STEPS excludes replies + digest', !DEFAULT_STEPS.includes('replies') && !DEFAULT_STEPS.includes('digest'));

// ── countPipelineEntries ────────────────────────────────────────────────────
const PIPE = [
  '# Pipeline', '', '## Pending',
  '- [ ] https://a.com/1 | Acme | Engineer',
  '- [ ] https://b.com/2 | Beta | Lead',
  '## Processed',
  '- [x] https://c.com/3 | Gamma | Staff',
].join('\n');
eq('countPipelineEntries', countPipelineEntries(PIPE), { pending: 2, processed: 1, total: 3 });
eq('countPipelineEntries empty', countPipelineEntries(''), { pending: 0, processed: 0, total: 0 });

// ── pendingPipelineUrls ─────────────────────────────────────────────────────
eq('pendingPipelineUrls extracts only pending', pendingPipelineUrls(PIPE), ['https://a.com/1', 'https://b.com/2']);

// ── summarizeTracker ────────────────────────────────────────────────────────
const APPS = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-07-01 | Acme | Eng | 4.2/5 | Applied | ✅ | [1](reports/1.md) | ok |',
  '| 2 | 2026-07-02 | Beta | Lead | 3.9/5 | Applied | ✅ | [2](reports/2.md) | ok |',
  '| 3 | 2026-07-03 | Gamma | Staff | 4.5/5 | Interview | ✅ | [3](reports/3.md) | ok |',
].join('\n');
eq('summarizeTracker total', summarizeTracker(APPS).total, 3);
eq('summarizeTracker byStatus', summarizeTracker(APPS).byStatus, { Applied: 2, Interview: 1 });
eq('summarizeTracker skips separator/header', summarizeTracker(APPS).byStatus.Status, undefined);
eq('summarizeTracker empty', summarizeTracker(''), { total: 0, byStatus: {} });

// ── countReplyCandidates ────────────────────────────────────────────────────
eq('countReplyCandidates array', countReplyCandidates('[{"a":1},{"b":2}]'), 2);
eq('countReplyCandidates bad json → 0', countReplyCandidates('not json'), 0);
eq('countReplyCandidates non-array → 0', countReplyCandidates('{"x":1}'), 0);

// ── buildDigest + formatDigest ──────────────────────────────────────────────
const digest = buildDigest({
  before: { pending: 1, processed: 0, total: 1 },
  after: { pending: 3, processed: 0, total: 3 },
  steps: [
    { id: 'scan', ok: true, ms: 1200, note: '2 new' },
    { id: 'merge', ok: false, ms: 300, note: 'exit 1' },
  ],
  tracker: { total: 3, byStatus: { Applied: 2, Interview: 1 } },
  replies: 2,
  followupsDue: 1,
  date: '2026-07-23',
});
eq('buildDigest new_leads = pending delta', digest.new_leads, 2);
eq('buildDigest ok reflects step failure', digest.ok, false);
eq('buildDigest carries replies + followups', [digest.replies_pending, digest.followups_due], [2, 1]);
eq('buildDigest health null when absent', digest.health, null);

// health, when provided, is carried + rendered; absent → omitted
const withHealth = buildDigest({
  before: { pending: 0, processed: 0, total: 0 }, after: { pending: 0, processed: 0, total: 0 },
  steps: [{ id: 'scan', ok: true, ms: 10, note: 'ok' }], tracker: { total: 3, byStatus: {} },
  replies: 0, followupsDue: 0, health: { score: 82, grade: 'B' }, date: '2026-07-23',
});
eq('buildDigest carries health score/grade', withHealth.health, { score: 82, grade: 'B' });
ok('formatDigest renders health line when present', formatDigest(withHealth).includes('Pipeline health:** 82/100 (B)'));
ok('formatDigest omits health line when absent', !formatDigest(digest).includes('Pipeline health'));

const md = formatDigest(digest);
ok('formatDigest mentions new leads', md.includes('New leads this run:** 2'));
ok('formatDigest flags replies review', md.includes('node reply-watch.mjs'));
ok('formatDigest shows failed step icon', md.includes('❌ merge'));
ok('formatDigest lists tracker statuses', md.includes('Applied: 2'));

// clean-run digest should say nothing needs you
const clean = buildDigest({
  before: { pending: 0, processed: 0, total: 0 },
  after: { pending: 0, processed: 0, total: 0 },
  steps: [{ id: 'scan', ok: true, ms: 100, note: 'ok' }],
  tracker: { total: 0, byStatus: {} },
  replies: 0, followupsDue: 0, date: '2026-07-23',
});
ok('clean digest says nothing needed', formatDigest(clean).includes('Nothing needs you'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
