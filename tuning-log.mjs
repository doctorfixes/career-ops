#!/usr/bin/env node

/**
 * tuning-log.mjs — provenance ledger for applied calibrations.
 *
 * `learn.mjs` proposes tuning changes; when the user approves one and the agent
 * applies it, this records WHAT changed, WHY (the evidence), WHEN, at what
 * confidence, and whether the golden-eval gate passed. Two payoffs:
 *
 *   1. Reversibility + legibility — every calibration has a paper trail, so you
 *      can see how your targeting drifted and roll a change back.
 *   2. A churn guard — if a knob has been flip-flopped repeatedly, the signal
 *      driving it is probably noise, not a trend. The summary flags it so you
 *      hold instead of chasing.
 *
 * User layer, append-only: data/tuning-log.tsv. This script never edits your
 * profile — it only records changes the agent already made on your approval.
 *
 * Usage:
 *   node tuning-log.mjs add --knob auto_pdf_score_threshold --old 3.0 --new 3.7 \
 *        --proposal score-floor --category scoring --confidence medium \
 *        --gate pass --evidence "advanced avg 4.2 vs rejected 3.3" --note "..."
 *   node tuning-log.mjs --summary      # history + churn analysis
 *   node tuning-log.mjs --json
 *   node tuning-log.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, 'data', 'tuning-log.tsv');

export const COLUMNS = ['date', 'proposal_id', 'category', 'knob', 'target', 'old_value', 'new_value', 'confidence', 'golden_gate', 'evidence', 'note'];
const HEADER = COLUMNS.join('\t');

const CHURN_MIN_CHANGES = 3; // flag a knob flip-flopped at least this many times

// ---------------------------------------------------------------------------
// Serialization (pure)
// ---------------------------------------------------------------------------

/** Tabs/newlines would corrupt a TSV row — collapse them to spaces. */
export function sanitize(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/** Serialize an entry object into one TSV line following COLUMNS order. */
export function serializeRow(entry) {
  return COLUMNS.map((c) => sanitize(entry[c])).join('\t');
}

/** Parse a tuning-log TSV into row objects (skips header + blank lines). */
export function parseLog(tsv) {
  const lines = String(tsv || '').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [];
  const start = lines[0].startsWith('date\t') ? 1 : 0;
  const rows = [];
  for (const line of lines.slice(start)) {
    const cells = line.split('\t');
    const row = {};
    COLUMNS.forEach((c, i) => { row[c] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/** Append a row to an existing TSV blob, adding the header if absent. Pure. */
export function appendRowToTsv(existingTsv, entry) {
  const base = existingTsv && existingTsv.trim() ? existingTsv.replace(/\n+$/, '') : HEADER;
  return `${base}\n${serializeRow(entry)}\n`;
}

// ---------------------------------------------------------------------------
// Churn analysis (pure)
// ---------------------------------------------------------------------------

/**
 * Per-knob change history + churn detection. A knob whose value has been
 * revisited across ≥ CHURN_MIN_CHANGES changes is flip-flopping — the signal
 * behind it is likely unstable.
 * @param {Array<Record<string,string>>} rows
 */
export function analyzeChurn(rows) {
  const byKnob = new Map();
  for (const r of rows) {
    const knob = r.knob || '(unknown)';
    if (!byKnob.has(knob)) byKnob.set(knob, []);
    byKnob.get(knob).push(r);
  }
  const out = [];
  for (const [knob, entries] of byKnob) {
    const values = entries.map((e) => e.new_value);
    const distinct = new Set(values);
    const changes = entries.length;
    // flip-flop: a value reappears after the knob moved away from it.
    let flipFlop = false;
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1] && values.slice(0, i - 1).includes(values[i])) { flipFlop = true; break; }
    }
    out.push({
      knob,
      changes,
      distinctValues: distinct.size,
      flipFlop,
      churnFlag: changes >= CHURN_MIN_CHANGES && (flipFlop || distinct.size < changes),
      firstDate: entries[0].date,
      lastDate: entries[entries.length - 1].date,
      lastValue: values[values.length - 1],
    });
  }
  return out.sort((a, b) => b.changes - a.changes || a.knob.localeCompare(b.knob));
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

export function formatSummary(rows, churn) {
  const L = [];
  L.push(`Tuning log — ${rows.length} calibration(s) recorded`);
  if (rows.length === 0) {
    L.push('  (nothing yet — apply a `learn` proposal, then record it with `tuning-log.mjs add`)');
    return L.join('\n');
  }
  L.push('');
  L.push('Recent changes:');
  for (const r of rows.slice(-8)) {
    const gate = r.golden_gate && r.golden_gate !== 'na' ? ` [gate:${r.golden_gate}]` : '';
    L.push(`  ${r.date}  ${r.knob}: ${r.old_value || '?'} → ${r.new_value}  (${r.confidence || 'n/a'})${gate}`);
    if (r.evidence) L.push(`           ↳ ${r.evidence}`);
  }
  const flagged = churn.filter((c) => c.churnFlag);
  L.push('');
  if (flagged.length) {
    L.push('⚠️  Churn detected — possible noise-chasing (hold instead of re-tuning):');
    for (const c of flagged) L.push(`  ${c.knob}: changed ${c.changes}× (now ${c.lastValue})${c.flipFlop ? ', flip-flopped' : ''}`);
  } else {
    L.push('✅ No churn — knobs are stable (no over-tuning detected).');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseAddArgs(argv) {
  const e = { date: new Date().toISOString().slice(0, 10) };
  const map = {
    '--knob': 'knob', '--old': 'old_value', '--new': 'new_value', '--proposal': 'proposal_id',
    '--category': 'category', '--target': 'target', '--confidence': 'confidence',
    '--gate': 'golden_gate', '--evidence': 'evidence', '--note': 'note', '--date': 'date',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.includes('=') ? a.split('=')[0] : a;
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (map[key]) e[map[key]] = val();
  }
  return e;
}

function readLog() { return existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf-8') : ''; }

function cmdAdd(argv) {
  const entry = parseAddArgs(argv);
  if (!entry.knob || entry.new_value === undefined) {
    console.error('Usage: node tuning-log.mjs add --knob <knob> --new <value> [--old <v>] [--proposal id] [--category c] [--confidence c] [--gate pass|fail|na] [--evidence "..."] [--note "..."]');
    return 1;
  }
  const next = appendRowToTsv(readLog(), entry);
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, next, 'utf-8');
  console.log(`Recorded: ${entry.knob}: ${entry.old_value || '?'} → ${entry.new_value} (${entry.confidence || 'n/a'})`);
  const churn = analyzeChurn(parseLog(next)).filter((c) => c.churnFlag && c.knob === entry.knob);
  if (churn.length) console.log(`⚠️  ${entry.knob} has now changed ${churn[0].changes}× — the signal may be noise; consider holding.`);
  return 0;
}

function runSelfTest() {
  const fails = [];
  let tsv = '';
  tsv = appendRowToTsv(tsv, { date: '2026-07-01', knob: 'auto_pdf_score_threshold', old_value: '3.0', new_value: '3.7', confidence: 'medium' });
  tsv = appendRowToTsv(tsv, { date: '2026-07-08', knob: 'auto_pdf_score_threshold', old_value: '3.7', new_value: '3.0', confidence: 'low' });
  tsv = appendRowToTsv(tsv, { date: '2026-07-15', knob: 'auto_pdf_score_threshold', old_value: '3.0', new_value: '3.7', confidence: 'low' });
  const rows = parseLog(tsv);
  if (rows.length !== 3) fails.push(`parse count ${rows.length}`);
  if (rows[0].knob !== 'auto_pdf_score_threshold') fails.push('parse knob');
  const churn = analyzeChurn(rows);
  const k = churn.find((c) => c.knob === 'auto_pdf_score_threshold');
  if (!k || !k.flipFlop) fails.push('flip-flop not detected');
  if (!k.churnFlag) fails.push('churn flag not raised');
  if (serializeRow({ knob: 'x', note: 'a\tb\nc' }).split('\t').length !== COLUMNS.length) fails.push('sanitize/serialize width');
  if (fails.length) { console.error(`tuning-log self-test FAILED: ${fails.join('; ')}`); process.exit(1); }
  console.log('tuning-log self-test OK (serialize, parse, churn/flip-flop detection)');
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  if (argv[0] === 'add') return cmdAdd(argv.slice(1));

  const rows = parseLog(readLog());
  const churn = analyzeChurn(rows);
  if (argv.includes('--json')) console.log(JSON.stringify({ count: rows.length, rows, churn }, null, 2));
  else console.log(formatSummary(rows, churn));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
