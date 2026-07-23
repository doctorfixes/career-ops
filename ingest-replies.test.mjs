/**
 * ingest-replies.test.mjs — tests for the email → reply-candidate normalizer.
 *
 * Covers the offline, pure paths (eml/mbox/json parsing, MIME decoding, signal
 * inference, dedup merge). The gmail path is network and documented, not tested
 * here.
 *
 * Run: node ingest-replies.test.mjs
 */

import {
  decodeMimeWords, parseRfc822, extractBodyText, snippet, parseEmail,
  splitMbox, inferSignal, withSignals, normalizeJsonRecords, mergeCandidates,
  parseArgs,
} from './ingest-replies.mjs';

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

// ── decodeMimeWords ─────────────────────────────────────────────────────────
eq('decode B encoded-word', decodeMimeWords('=?utf-8?B?SGVsbG8gV29ybGQ=?='), 'Hello World');
eq('decode Q encoded-word', decodeMimeWords('=?utf-8?Q?Hi=20there?='), 'Hi there');
eq('plain header untouched', decodeMimeWords('Plain Subject'), 'Plain Subject');

// ── parseRfc822 ─────────────────────────────────────────────────────────────
const RAW = [
  'From: Recruiting <hr@acme.com>',
  'Subject: Interview invitation for Backend Engineer',
  'Message-ID: <abc123@acme.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'We would like to schedule an interview with you next week.',
].join('\n');
const parsed = parseRfc822(RAW);
eq('parse from header', parsed.headers.get('from'), 'Recruiting <hr@acme.com>');
eq('parse subject header', parsed.headers.get('subject'), 'Interview invitation for Backend Engineer');
ok('parse body captured', parsed.body.includes('schedule an interview'));

// header folding is unfolded
const FOLDED = ['Subject: A very long', ' folded subject line', '', 'body'].join('\n');
eq('unfold folded header', parseRfc822(FOLDED).headers.get('subject'), 'A very long folded subject line');

// ── parseEmail (whole) ──────────────────────────────────────────────────────
const cand = parseEmail(RAW);
eq('email message_id stripped of <>', cand.message_id, 'abc123@acme.com');
eq('email from', cand.from, 'Recruiting <hr@acme.com>');
eq('email subject', cand.subject, 'Interview invitation for Backend Engineer');
ok('email snippet', cand.body_snippet.includes('schedule an interview'));

// missing Message-ID → deterministic fallback id
const noId = parseEmail('From: a@b.com\nSubject: Hi\n\nbody');
ok('fallback id when no Message-ID', noId.message_id.startsWith('gen-'));
eq('fallback id is deterministic', parseEmail('From: a@b.com\nSubject: Hi\n\nbody').message_id, noId.message_id);

// ── base64 + quoted-printable bodies ────────────────────────────────────────
const B64 = [
  'From: hr@x.com', 'Subject: Offer',
  'Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('We are pleased to extend an offer letter.').toString('base64'),
].join('\n');
ok('base64 body decoded', parseEmail(B64).body_snippet.includes('offer letter'));

const QP = [
  'From: hr@x.com', 'Subject: Update',
  'Content-Transfer-Encoding: quoted-printable', '',
  'Thanks=20for=20your=20time.',
].join('\n');
ok('quoted-printable decoded', parseEmail(QP).body_snippet.includes('Thanks for your time'));

// ── multipart: prefer text/plain, fall back to stripped html ────────────────
const MULTI = [
  'From: hr@x.com', 'Subject: Multi',
  'Content-Type: multipart/alternative; boundary="BND"', '',
  '--BND', 'Content-Type: text/plain', '', 'Plain part wins.', '',
  '--BND', 'Content-Type: text/html', '', '<p>HTML part loses</p>', '',
  '--BND--',
].join('\n');
eq('multipart picks text/plain', extractBodyText(parseRfc822(MULTI).headers, parseRfc822(MULTI).body), 'Plain part wins.');

const HTMLONLY = [
  'From: hr@x.com', 'Subject: H',
  'Content-Type: text/html', '',
  '<html><body><p>Hello <b>there</b></p></body></html>',
].join('\n');
eq('html-only stripped', parseEmail(HTMLONLY).body_snippet, 'Hello there');

// ── snippet cap ─────────────────────────────────────────────────────────────
eq('snippet collapses whitespace', snippet('a\n\n  b   c'), 'a b c');
eq('snippet caps length', snippet('x'.repeat(600)).length, 500);

// ── splitMbox ───────────────────────────────────────────────────────────────
const MBOX = [
  'From hr@a.com Mon Jul 20 10:00:00 2026',
  'From: hr@a.com', 'Subject: First', '', 'body one',
  'From hr@b.com Mon Jul 21 10:00:00 2026',
  'From: hr@b.com', 'Subject: Second', '', 'body two',
].join('\n');
const msgs = splitMbox(MBOX);
eq('mbox split count', msgs.length, 2);
eq('mbox first parsed subject', parseEmail(msgs[0]).subject, 'First');
eq('mbox second parsed subject', parseEmail(msgs[1]).subject, 'Second');

// ── inferSignal via shared classifier ───────────────────────────────────────
eq('signal: interview', inferSignal({ subject: 'Interview invitation', body_snippet: 'schedule an interview' }), 'interview_invite');
eq('signal: rejection', inferSignal({ subject: 'Update', body_snippet: 'Unfortunately, not a match' }), 'rejection');
eq('signal: offer', inferSignal({ subject: 'Great news', body_snippet: 'we are pleased to send your offer letter' }), 'offer');
eq('signal: none for job alert noise', inferSignal({ subject: 'Job alert', body_snippet: 'recommended jobs for you' }), null);

// withSignals respects a pre-set signal
eq('withSignals fills missing', withSignals([{ subject: 'Interview invitation', body_snippet: 'x' }])[0].signal, 'interview_invite');
eq('withSignals keeps explicit', withSignals([{ subject: 'Interview invitation', body_snippet: 'x', signal: 'offer' }])[0].signal, 'offer');

// ── normalizeJsonRecords ────────────────────────────────────────────────────
const norm = normalizeJsonRecords([
  { from: 'a@b.com', subject: 'S1', body: 'B1', id: 'm1' },
  { sender: 'c@d.com', title: 'S2', text: 'B2' },
]);
eq('json normalize maps fields', [norm[0].message_id, norm[0].from, norm[0].subject, norm[0].body_snippet], ['m1', 'a@b.com', 'S1', 'B1']);
eq('json normalize alt field names', [norm[1].from, norm[1].subject, norm[1].body_snippet], ['c@d.com', 'S2', 'B2']);
eq('json normalize non-array → []', normalizeJsonRecords('nope'), []);

// ── mergeCandidates dedup ───────────────────────────────────────────────────
const existing = [{ message_id: 'a', subject: 'A' }];
const incoming = [{ message_id: 'a', subject: 'A-dup' }, { message_id: 'b', subject: 'B' }];
const { merged, added } = mergeCandidates(existing, incoming);
eq('merge added count', added, 1);
eq('merge total', merged.length, 2);
eq('merge keeps original on id clash', merged.find(c => c.message_id === 'a').subject, 'A');

// ── parseArgs ───────────────────────────────────────────────────────────────
eq('args source + positional path', (() => { const o = parseArgs(['--source', 'eml', './mail']); return [o.source, o.arg]; })(), ['eml', './mail']);
eq('args replace + limit', (() => { const o = parseArgs(['--source', 'mbox', 'in.mbox', '--replace', '--limit', '5']); return [o.replace, o.limit]; })(), [true, 5]);
eq('args gmail label + days-back', (() => { const o = parseArgs(['--source', 'gmail', '--label', 'Applications', '--days-back', '30']); return [o.label, o.daysBack]; })(), ['Applications', 30]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
