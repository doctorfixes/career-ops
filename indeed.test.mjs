/**
 * indeed.test.mjs — tests for the Indeed → pipeline bridge.
 * Run: node indeed.test.mjs
 */

import { extractResultText, parseIndeedResults, toPipelineEntries, appendToPipeline } from './indeed.mjs';

let passed = 0, failed = 0;
const failures = [];
function eq(label, a, e) {
  if (JSON.stringify(a) === JSON.stringify(e)) passed++;
  else { failed++; failures.push(label); console.log(`  FAIL: ${label}\n    expected: ${JSON.stringify(e)}\n    actual:   ${JSON.stringify(a)}`); }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n';
const SAMPLE = `**Job Title:** Hotel General Manager
            **Job Id:** JOBSEARCH_63
            **Company:** DoubleTree by Hilton Denver - Aurora
            **Location:** Aurora, CO
            **Posted on:** July 17, 2026
            **Job Type:** Full-time
            **Compensation:** $135,000 - $165,000 a year
            **View Job URL:** https://to.indeed.com/aayrfb6l2246

**Job Title:** General Manager - Populus Denver
            **Job Id:** JOBSEARCH_70
            **Company:** Crescent Hotels & Resorts
            **Location:** Denver, CO
            **Posted on:** July 08, 2026
            **Job Type:** N/A
            **Compensation:** $200,000 a year
            **View Job URL:** https://to.indeed.com/aaxj27qvm8pl`;

// ── extractResultText ────────────────────────────────────────────────────────
eq('unwraps {result} object', extractResultText({ result: 'hello' }), 'hello');
eq('unwraps {result} JSON string', extractResultText('{"result":"hi"}'), 'hi');
eq('passes raw text through', extractResultText('**Job Title:** X'), '**Job Title:** X');
eq('null → empty', extractResultText(null), '');

// ── parseIndeedResults ───────────────────────────────────────────────────────
const jobs = parseIndeedResults(SAMPLE);
eq('parses both records', jobs.length, 2);
eq('title', jobs[0].title, 'Hotel General Manager');
eq('company with hyphens', jobs[0].company, 'DoubleTree by Hilton Denver - Aurora');
eq('location', jobs[0].location, 'Aurora, CO');
eq('url intact', jobs[1].url, 'https://to.indeed.com/aaxj27qvm8pl');
eq('compensation captured', jobs[1].compensation, '$200,000 a year');
eq('N/A job type normalized to empty', jobs[1].jobType, '');
eq('role with suffix', jobs[1].title, 'General Manager - Populus Denver');

// no-results + envelope forms
eq('no results → empty', parseIndeedResults('{"result":"No job results found. Please try expanding your search criteria."}'), []);
eq('object envelope parsed', parseIndeedResults({ result: SAMPLE }).length, 2);
eq('empty input → empty', parseIndeedResults(''), []);
// a record missing a URL is dropped
eq('record without url dropped', parseIndeedResults('**Job Title:** No URL Job\n            **Company:** X'), []);

// ── toPipelineEntries ────────────────────────────────────────────────────────
const entries = toPipelineEntries(jobs);
eq('entry shape', entries[0], { url: 'https://to.indeed.com/aayrfb6l2246', company: 'DoubleTree by Hilton Denver - Aurora', role: 'Hotel General Manager', location: 'Aurora, CO' });

// ── appendToPipeline ─────────────────────────────────────────────────────────
const fresh = appendToPipeline('# Pipeline\n\n## Pending\n', HISTORY_HEADER, '', entries, '2026-07-24');
eq('adds both new', fresh.added, 2);
ok('pipeline line format', fresh.pipeline.includes('- [ ] https://to.indeed.com/aayrfb6l2246 | DoubleTree by Hilton Denver - Aurora | Hotel General Manager'));
ok('new entries inserted under ## Pending', fresh.pipeline.indexOf('## Pending') < fresh.pipeline.indexOf('- [ ]'));
ok('history row tagged portal=indeed', fresh.history.includes('\tindeed\t'));

// dedup vs scan-history / current pipeline
const again = appendToPipeline(fresh.pipeline, fresh.history, '', entries, '2026-07-24');
eq('re-ingest adds nothing (history + pipeline dedup)', again.added, 0);

// dedup vs tracker (already applied)
const trackerHit = appendToPipeline('# Pipeline\n\n## Pending\n', HISTORY_HEADER,
  '| 1 | 2026-07-01 | Acme | GM | 4.2/5 | Applied | ✅ | [1](r) | https://to.indeed.com/aayrfb6l2246 |', entries, '2026-07-24');
eq('skips a URL already in the tracker', trackerHit.added, 1);

// dedup within a batch (same url twice)
const dupBatch = appendToPipeline('# Pipeline\n\n## Pending\n', HISTORY_HEADER, '',
  [entries[0], { ...entries[0] }], '2026-07-24');
eq('collapses in-batch duplicate url', dupBatch.added, 1);

// empty entries → no-op, pipeline unchanged
const noop = appendToPipeline('# Pipeline\n\n## Pending\n', HISTORY_HEADER, '', [], '2026-07-24');
eq('empty batch adds nothing', noop.added, 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
