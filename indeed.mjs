#!/usr/bin/env node

/**
 * indeed.mjs — Indeed → pipeline discovery bridge.
 *
 * Indeed has no open public API, so discovery is AGENT-MEDIATED: an AI CLI with
 * the Indeed integration calls its job-search tool, and this normalizes those
 * results into `data/pipeline.md` — deduped against scan history + the tracker,
 * exactly like the zero-token scanner. That keeps Indeed a first-class, honest
 * discovery source without scraping or storing anyone's credentials.
 *
 * Flow:
 *   1. The agent runs the Indeed search tool for your target roles + location.
 *   2. It saves the tool output to a file (or pipes it) and runs:
 *        node indeed.mjs --ingest results.txt
 *   3. New, live, non-duplicate roles land in the pipeline for evaluation.
 *
 * This never applies or submits — it only fills the discovery inbox. Evaluate
 * with the `pipeline` mode; career-ops re-verifies liveness and scores A–F.
 *
 * Usage:
 *   node indeed.mjs --ingest results.txt         # parse + append to pipeline
 *   node indeed.mjs --ingest -                    # read from stdin
 *   node indeed.mjs --ingest results.txt --dry-run --json
 *   node indeed.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = path.join(__dirname, 'data', 'pipeline.md');
const HISTORY_PATH = path.join(__dirname, 'data', 'scan-history.tsv');
const APPS_PATH = path.join(__dirname, 'data', 'applications.md');
const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n';

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/** Unwrap the Indeed tool's `{ "result": "..." }` envelope, or take raw text. */
export function extractResultText(input) {
  if (input == null) return '';
  if (typeof input === 'object') return String(input.result ?? '');
  const s = String(input);
  const t = s.trim();
  if (t.startsWith('{')) {
    try { const o = JSON.parse(t); if (o && typeof o.result === 'string') return o.result; } catch { /* not JSON — treat as text */ }
  }
  return s;
}

/**
 * Parse the Indeed search tool's block format into job records. Tolerant of the
 * leading indentation the tool emits and of the "no results" sentinel.
 * @param {string|object} input
 * @returns {Array<{title,jobId,company,location,postedOn,jobType,compensation,url}>}
 */
export function parseIndeedResults(input) {
  const text = extractResultText(input);
  if (!text.trim() || /no job results found/i.test(text)) return [];
  const jobs = [];
  // Each record begins at a "**Job Title:**" marker.
  for (const part of text.split(/(?=\*\*Job Title:\*\*)/)) {
    if (!/\*\*Job Title:\*\*/.test(part)) continue;
    const get = (label) => {
      const m = part.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
      const v = m ? m[1].trim() : '';
      return v === 'N/A' ? '' : v;
    };
    const title = get('Job Title');
    const url = get('View Job URL');
    if (!title || !/^https?:\/\//.test(url)) continue;
    jobs.push({
      title,
      jobId: get('Job Id'),
      company: get('Company') || 'Unknown',
      location: get('Location'),
      postedOn: get('Posted on'),
      jobType: get('Job Type'),
      compensation: get('Compensation'),
      url,
    });
  }
  return jobs;
}

/** Map job records to the pipeline entry shape. */
export function toPipelineEntries(jobs) {
  return jobs.map((j) => ({ url: j.url, company: j.company, role: j.title, location: j.location || '' }));
}

// ---------------------------------------------------------------------------
// Pipeline append with dedup (pure) — mirrors the scanner's addToPipeline.
// ---------------------------------------------------------------------------

/**
 * Append new entries to the pipeline, deduped against scan history, the tracker,
 * the current pipeline, and within the batch. Returns updated file contents.
 * @returns {{pipeline:string, history:string, added:number, entries:Array}}
 */
export function appendToPipeline(pipelineMd, historyTsv, appsMd, entries, today) {
  const history = historyTsv && historyTsv.trim() ? historyTsv : HISTORY_HEADER;
  const seenUrls = new Set(history.split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean));
  const existingPipeline = pipelineMd && pipelineMd.trim() ? pipelineMd : '# Pipeline\n\n## Pending\n';
  const appliedUrls = new Set(
    String(appsMd || '').split('\n').map((l) => l.match(/https?:\/\/[^\s|)]+/)).filter(Boolean).map((m) => m[0]),
  );

  const batchSeen = new Set();
  const fresh = entries.filter((e) => {
    if (!e.url) return false;
    if (seenUrls.has(e.url)) return false;
    if (appliedUrls.has(e.url)) return false;
    if (existingPipeline.includes(e.url)) return false;
    const key = e.url.toLowerCase();
    if (batchSeen.has(key)) return false;
    batchSeen.add(key);
    return true;
  });

  if (fresh.length === 0) return { pipeline: existingPipeline, history, added: 0, entries: [] };

  const lines = fresh.map((e) => `- [ ] ${e.url} | ${e.company} | ${e.role}`);
  let pipeline = existingPipeline;
  const pendingIdx = pipeline.indexOf('## Pending');
  const processedIdx = pipeline.indexOf('## Processed');
  if (pendingIdx !== -1 && (processedIdx === -1 || processedIdx > pendingIdx)) {
    const insertAt = pendingIdx + '## Pending'.length;
    const head = pipeline.slice(0, insertAt);
    let tail = pipeline.slice(insertAt);
    if (!tail.startsWith('\n')) tail = '\n' + tail;
    pipeline = head + '\n' + lines.join('\n') + tail;
  } else {
    pipeline += lines.join('\n') + '\n';
  }

  let hist = history;
  for (const e of fresh) {
    hist += `${e.url}\t${today}\tindeed\t${e.role}\t${e.company}\tadded\t${e.location ?? ''}\n`;
  }
  return { pipeline, history: hist, added: fresh.length, entries: fresh };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readInput(src) {
  if (src === '-' || src === undefined) return readFileSync(0, 'utf-8');
  const p = path.isAbsolute(src) ? src : path.join(process.cwd(), src);
  return readFileSync(p, 'utf-8');
}
function readFileSafe(p, fallback = '') { try { return existsSync(p) ? readFileSync(p, 'utf-8') : fallback; } catch { return fallback; } }

function runSelfTest() {
  const sample = `**Job Title:** Hotel General Manager
            **Job Id:** JOBSEARCH_63
            **Company:** DoubleTree by Hilton Denver - Aurora
            **Location:** Aurora, CO
            **Posted on:** July 17, 2026
            **Job Type:** Full-time
            **Compensation:** $135,000 - $165,000 a year
            **View Job URL:** https://to.indeed.com/aayrfb6l2246

**Job Title:** General Manager
            **Job Id:** JOBSEARCH_64
            **Company:** Hyatt Centric Downtown Denver
            **Location:** Denver, CO
            **Posted on:** July 14, 2026
            **Job Type:** Full-time
            **Compensation:** $170,000 - $180,000 a year
            **View Job URL:** https://to.indeed.com/aapk4t4pk7f2`;
  const fails = [];
  const jobs = parseIndeedResults(sample);
  if (jobs.length !== 2) fails.push(`parsed ${jobs.length}, expected 2`);
  if (jobs[0].company !== 'DoubleTree by Hilton Denver - Aurora') fails.push('company parse');
  if (jobs[0].url !== 'https://to.indeed.com/aayrfb6l2246') fails.push('url parse');
  if (parseIndeedResults('{"result":"No job results found. Please try expanding your search criteria."}').length !== 0) fails.push('no-results not empty');
  if (parseIndeedResults({ result: sample }).length !== 2) fails.push('object envelope not handled');

  const r = appendToPipeline('# Pipeline\n\n## Pending\n', HISTORY_HEADER, '', toPipelineEntries(jobs), '2026-07-24');
  if (r.added !== 2) fails.push(`append added ${r.added}`);
  if (!r.pipeline.includes('- [ ] https://to.indeed.com/aapk4t4pk7f2 | Hyatt Centric Downtown Denver | General Manager')) fails.push('pipeline line format');
  // dedup: re-ingest against the produced state → 0 new
  const r2 = appendToPipeline(r.pipeline, r.history, '', toPipelineEntries(jobs), '2026-07-24');
  if (r2.added !== 0) fails.push(`dedup failed, added ${r2.added}`);
  // tracker dedup
  const r3 = appendToPipeline('# Pipeline\n\n## Pending\n', HISTORY_HEADER, '| 1 | x | y | z | 4/5 | Applied | ✅ | [1](r) | https://to.indeed.com/aayrfb6l2246 |', toPipelineEntries(jobs), '2026-07-24');
  if (r3.added !== 1) fails.push(`tracker dedup: expected 1 new, got ${r3.added}`);

  if (fails.length) { console.error(`indeed self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('indeed self-test OK (block parse, envelope, no-results, pipeline append, dedup vs history/tracker/batch)');
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const ii = argv.indexOf('--ingest');
  if (ii === -1) { console.error('Usage: node indeed.mjs --ingest <file|-> [--dry-run] [--json]'); return 1; }

  const jobs = parseIndeedResults(readInput(argv[ii + 1]));
  const entries = toPipelineEntries(jobs);
  const today = new Date().toISOString().slice(0, 10);
  const res = appendToPipeline(readFileSafe(PIPELINE_PATH), readFileSafe(HISTORY_PATH), readFileSafe(APPS_PATH), entries, today);

  const summary = { parsed: jobs.length, added: res.added, skipped_duplicates: jobs.length - res.added };
  if (!dryRun && res.added > 0) {
    mkdirSync(path.dirname(PIPELINE_PATH), { recursive: true });
    writeFileSync(PIPELINE_PATH, res.pipeline, 'utf-8');
    writeFileSync(HISTORY_PATH, res.history, 'utf-8');
  }
  if (json) console.log(JSON.stringify({ ...summary, dryRun, added_entries: res.entries }, null, 2));
  else {
    console.log(`Indeed: parsed ${jobs.length} job(s), ${res.added} new to pipeline${dryRun ? ' (dry-run — not written)' : ''}${jobs.length - res.added ? `, ${jobs.length - res.added} duplicate(s) skipped` : ''}.`);
    for (const e of res.entries) console.log(`  + ${e.role} — ${e.company}${e.location ? ` (${e.location})` : ''}`);
    if (res.added > 0 && !dryRun) console.log('\nNext: evaluate with the `pipeline` mode (career-ops re-verifies liveness + scores A–F).');
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
