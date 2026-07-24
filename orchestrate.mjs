#!/usr/bin/env node

/**
 * orchestrate.mjs — the daily automation spine.
 *
 * Chains the existing local-first steps into ONE command so a scheduler (cron,
 * systemd timer, launchd, GitHub Actions, Railway cron) can run the whole
 * discovery + hygiene loop unattended:
 *
 *   scan → plugin ingests → liveness sweep → merge-tracker → followup-seed
 *        → (optional reply ingest) → plugin export → digest
 *
 * Human-in-the-loop by design (ARCHITECTURE.md, AGENTS.md → Ethical Use):
 * this DISCOVERS jobs, keeps the pipeline/tracker tidy, and REPORTS what needs
 * a human — new leads to evaluate, replies to review, follow-ups due. It never
 * evaluates with an LLM, never tailors, never applies, and never submits. The
 * clicking always stays with you.
 *
 * Usage:
 *   node orchestrate.mjs                      # full daily run
 *   node orchestrate.mjs --dry-run            # print the plan, run nothing
 *   node orchestrate.mjs --only scan,liveness # run just these steps
 *   node orchestrate.mjs --skip export        # run all but these
 *   node orchestrate.mjs --no-plugins         # skip ingest/export plugin steps
 *   node orchestrate.mjs --replies eml:./mail # also refresh reply-candidates.json
 *   node orchestrate.mjs --liveness-limit 40  # cap the liveness sweep (default 25)
 *   node orchestrate.mjs --json               # machine-readable summary to stdout
 *   node orchestrate.mjs --quiet              # only the digest, no step chatter
 *   node orchestrate.mjs --strict             # exit 1 if any step fails
 *
 * Outputs (user layer, never auto-updated by the updater):
 *   data/orchestrator-digest.md   — the latest run's digest
 *   data/orchestrator-runs.tsv    — append-only per-run summary log
 */

import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PIPELINE_PATH = path.join(__dirname, 'data', 'pipeline.md');
const APPS_PATH = path.join(__dirname, 'data', 'applications.md');
const REPLIES_PATH = path.join(__dirname, 'data', 'reply-candidates.json');
const DIGEST_PATH = path.join(__dirname, 'data', 'orchestrator-digest.md');
const RUNLOG_PATH = path.join(__dirname, 'data', 'orchestrator-runs.tsv');
const LIVENESS_TMP = path.join(__dirname, 'data', '.orchestrator-liveness-urls.txt');

const STEP_TIMEOUT_MS = 5 * 60_000; // per-step ceiling; scan/liveness are the slow ones

// The canonical step order. `--only` / `--skip` filter this list; the plan
// expands `ingest`/`export` into one concrete step per enabled plugin.
export const STEP_ORDER = [
  'scan', 'ingest', 'liveness', 'merge', 'followups', 'replies', 'export', 'digest',
];

// Steps that run by default (a bare `node orchestrate.mjs`). `replies` is opt-in
// because it needs a source (--replies), and `digest` always runs implicitly.
export const DEFAULT_STEPS = ['scan', 'ingest', 'liveness', 'merge', 'followups', 'export'];

// ---------------------------------------------------------------------------
// Arg parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Parse orchestrate CLI argv into an options object.
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{only:string[]|null, skip:string[], dryRun:boolean, json:boolean,
 *   quiet:boolean, strict:boolean, noPlugins:boolean, livenessLimit:number,
 *   replies:{source:string, arg:string|null}|null}}
 */
export function parseArgs(argv) {
  const out = {
    only: null, skip: [], dryRun: false, json: false, quiet: false,
    strict: false, noPlugins: false, livenessLimit: 25, replies: null,
  };
  const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--no-plugins') out.noPlugins = true;
    else if (a === '--only' || a.startsWith('--only=')) out.only = list(val());
    else if (a === '--skip' || a.startsWith('--skip=')) out.skip.push(...list(val()));
    else if (a === '--liveness-limit' || a.startsWith('--liveness-limit=')) {
      const n = parseInt(val(), 10);
      if (Number.isFinite(n) && n >= 0) out.livenessLimit = n;
    } else if (a === '--replies' || a.startsWith('--replies=')) {
      out.replies = parseRepliesSpec(val());
    }
  }
  return out;
}

/**
 * Parse a `--replies` value into {source, arg}. Accepts `gmail`, `eml:./dir`,
 * `mbox:/path/inbox.mbox`, `json:./exported.json`.
 * @param {string} spec
 */
export function parseRepliesSpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx === -1) return { source: raw, arg: null };
  return { source: raw.slice(0, idx), arg: raw.slice(idx + 1) || null };
}

// ---------------------------------------------------------------------------
// Plan building (pure)
// ---------------------------------------------------------------------------

/**
 * Build the concrete, ordered execution plan from options + discovered context.
 * Pure: no filesystem or process side effects, so it is unit-testable.
 *
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{enabledIngest:string[], enabledExport:string[]}} ctx
 * @returns {Array<{id:string, label:string, kind:string, cmd?:string,
 *   args?:string[], critical:boolean}>}
 */
export function buildPlan(opts, ctx) {
  const wanted = (id) => {
    if (opts.skip.includes(id)) return false;
    if (opts.only) return opts.only.includes(id);
    if (id === 'replies') return Boolean(opts.replies);
    return DEFAULT_STEPS.includes(id);
  };

  const plan = [];
  for (const id of STEP_ORDER) {
    if (!wanted(id)) continue;
    switch (id) {
      case 'scan':
        plan.push({ id, label: 'Scan portals', kind: 'spawn', cmd: 'scan.mjs', args: [], critical: false });
        break;
      case 'ingest':
        if (opts.noPlugins) break;
        for (const pid of ctx.enabledIngest) {
          plan.push({
            id: `ingest:${pid}`, label: `Ingest via ${pid}`, kind: 'spawn',
            cmd: 'plugins.mjs', args: ['run', pid, 'ingest'], critical: false,
          });
        }
        break;
      case 'liveness':
        plan.push({ id, label: 'Liveness sweep', kind: 'liveness', critical: false });
        break;
      case 'merge':
        plan.push({ id, label: 'Merge tracker additions', kind: 'spawn', cmd: 'merge-tracker.mjs', args: [], critical: false });
        break;
      case 'followups':
        plan.push({ id, label: 'Seed follow-up dates', kind: 'spawn', cmd: 'followup-seed.mjs', args: ['--backfill'], critical: false });
        break;
      case 'replies':
        if (!opts.replies) break;
        plan.push({
          id, label: `Ingest replies (${opts.replies.source})`, kind: 'spawn',
          cmd: 'ingest-replies.mjs',
          args: ['--source', opts.replies.source, ...(opts.replies.arg ? [opts.replies.arg] : [])],
          critical: false,
        });
        break;
      case 'export':
        if (opts.noPlugins) break;
        for (const pid of ctx.enabledExport) {
          plan.push({
            id: `export:${pid}`, label: `Export to ${pid}`, kind: 'spawn',
            cmd: 'plugins.mjs', args: ['run', pid, 'export'], critical: false,
          });
        }
        break;
      case 'digest':
        break; // the digest is computed in-process after the plan runs
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Pipeline / tracker inspection (pure over strings)
// ---------------------------------------------------------------------------

/**
 * Count pipeline entries. Pending = `- [ ]`, Processed = `- [x]`.
 * @param {string} md  contents of data/pipeline.md
 * @returns {{pending:number, processed:number, total:number}}
 */
export function countPipelineEntries(md) {
  let pending = 0, processed = 0;
  for (const line of String(md || '').split('\n')) {
    if (/^- \[ \] /.test(line)) pending++;
    else if (/^- \[[xX]\] /.test(line)) processed++;
  }
  return { pending, processed, total: pending + processed };
}

/**
 * Extract pending job URLs from pipeline.md (for the liveness sweep).
 * @param {string} md
 * @returns {string[]}
 */
export function pendingPipelineUrls(md) {
  const urls = [];
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^- \[ \] (https?:\/\/[^\s|]+)/);
    if (m) urls.push(m[1]);
  }
  return urls;
}

/**
 * Roll up tracker rows by canonical status. Deliberately tolerant — it parses
 * the markdown table without importing the tracker parser so the digest never
 * crashes on a slightly-off row.
 * @param {string} md  contents of data/applications.md
 * @returns {{total:number, byStatus:Record<string, number>}}
 */
export function summarizeTracker(md) {
  const lines = String(md || '').split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length === 0) return { total: 0, byStatus: {} };
  // Locate the header row to find the Status column index.
  const header = lines.find(l => /(^|\|)\s*#\s*\|/.test(l)) || lines[0];
  const headerCells = header.split('|').map(s => s.trim().toLowerCase());
  const statusIdx = headerCells.findIndex(c => c === 'status');
  const byStatus = {};
  let total = 0;
  for (const line of lines) {
    if (line === header) continue;
    const cells = line.split('|').map(s => s.trim());
    // Skip the separator row (---|---) and any non-data row.
    if (cells.every(c => c === '' || /^:?-{2,}:?$/.test(c))) continue;
    const numCell = cells[1];
    if (!/^\d+$/.test(numCell || '')) continue; // real rows lead with a number
    total++;
    const status = (statusIdx >= 0 ? cells[statusIdx] : '') || 'Unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return { total, byStatus };
}

/** Count reply candidates awaiting review in reply-candidates.json. */
export function countReplyCandidates(json) {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Plugin discovery (best-effort, async)
// ---------------------------------------------------------------------------

/**
 * Discover which ingest/export plugins are enabled AND fully configured.
 * Fail-open: any problem loading the plugin engine yields empty lists, so the
 * core loop still runs.
 * @param {string} root
 * @returns {Promise<{enabledIngest:string[], enabledExport:string[]}>}
 */
export async function discoverEnabledPlugins(root) {
  try {
    const engine = await import('./plugins/_engine.mjs');
    const cfg = await engine.loadPluginConfig(root);
    const overrideIds = engine.resolveSuccessorIds(root);
    const manifests = engine.discoverPlugins(engine.pluginRoots(root), overrideIds);
    const enabledIngest = [];
    const enabledExport = [];
    for (const m of manifests) {
      const { enabled } = engine.pluginStatus(m, cfg);
      if (!enabled) continue;
      if (m.hooks.includes('ingest')) enabledIngest.push(m.id);
      if (m.hooks.includes('export')) enabledExport.push(m.id);
    }
    return { enabledIngest, enabledExport };
  } catch {
    return { enabledIngest: [], enabledExport: [] };
  }
}

// ---------------------------------------------------------------------------
// Execution (impure)
// ---------------------------------------------------------------------------

function readFileSafe(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf-8') : ''; } catch { return ''; }
}

/** First non-empty, meaningful line of output — the one-line step note. */
function firstMeaningfulLine(text) {
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 160);
  }
  return '';
}

function runSpawn(step, { quiet }) {
  const res = spawnSync('node', [step.cmd, ...step.args], {
    cwd: __dirname,
    encoding: 'utf-8',
    timeout: STEP_TIMEOUT_MS,
    env: process.env,
  });
  if (!quiet && res.stdout) process.stdout.write(res.stdout);
  if (!quiet && res.stderr) process.stderr.write(res.stderr);
  const ok = res.status === 0 && !res.error;
  const note = res.error
    ? String(res.error.message || res.error)
    : firstMeaningfulLine(res.stdout) || firstMeaningfulLine(res.stderr) || (ok ? 'ok' : `exit ${res.status}`);
  return { ok, note };
}

function runLiveness(step, opts) {
  const md = readFileSafe(PIPELINE_PATH);
  let urls = pendingPipelineUrls(md);
  if (urls.length === 0) return { ok: true, note: 'no pending URLs to check' };
  if (opts.livenessLimit > 0) urls = urls.slice(0, opts.livenessLimit);
  try {
    mkdirSync(path.dirname(LIVENESS_TMP), { recursive: true });
    writeFileSync(LIVENESS_TMP, urls.join('\n') + '\n', 'utf-8');
  } catch (err) {
    return { ok: false, note: `could not stage URL list — ${err.message}` };
  }
  // --no-fallback keeps it fully headless (safe for a scheduled/headless run).
  const res = spawnSync('node', ['check-liveness.mjs', '--no-fallback', '--file', LIVENESS_TMP], {
    cwd: __dirname, encoding: 'utf-8', timeout: STEP_TIMEOUT_MS, env: process.env,
  });
  if (!opts.quiet && res.stdout) process.stdout.write(res.stdout);
  const ok = res.status === 0 && !res.error;
  const note = res.error
    ? String(res.error.message || res.error)
    : `checked ${urls.length} pending URL(s)`;
  return { ok, note };
}

function runStep(step, opts) {
  const started = Date.now();
  let result;
  if (step.kind === 'liveness') result = runLiveness(step, opts);
  else result = runSpawn(step, opts);
  return { id: step.id, label: step.label, ok: result.ok, note: result.note, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Digest (pure formatter + impure writers)
// ---------------------------------------------------------------------------

/**
 * Build the digest data object from before/after snapshots and step results.
 */
export function buildDigest({ before, after, steps, tracker, replies, followupsDue, health, date }) {
  const newLeads = Math.max(0, after.pending - before.pending) + Math.max(0, after.processed - before.processed);
  return {
    date,
    new_leads: newLeads,
    pipeline_pending: after.pending,
    pipeline_total: after.total,
    tracker_total: tracker.total,
    tracker_by_status: tracker.byStatus,
    replies_pending: replies,
    followups_due: followupsDue,
    health: health ? { score: health.score, grade: health.grade } : null,
    steps: steps.map(s => ({ id: s.id, ok: s.ok, ms: s.ms, note: s.note })),
    ok: steps.every(s => s.ok),
  };
}

/** Render the human-readable digest markdown. */
export function formatDigest(d) {
  const L = [];
  L.push(`# Orchestrator digest — ${d.date}`);
  L.push('');
  L.push(`- **New leads this run:** ${d.new_leads}`);
  L.push(`- **Pipeline pending (to evaluate):** ${d.pipeline_pending}`);
  L.push(`- **Replies awaiting review:** ${d.replies_pending}${d.replies_pending ? '  → `node reply-watch.mjs`' : ''}`);
  if (d.followups_due != null) {
    L.push(`- **Follow-ups due:** ${d.followups_due}${d.followups_due ? '  → `node followup-cadence.mjs --summary`' : ''}`);
  }
  L.push(`- **Tracker rows:** ${d.tracker_total}`);
  if (d.health) L.push(`- **Pipeline health:** ${d.health.score}/100 (${d.health.grade})`);
  const statuses = Object.entries(d.tracker_by_status).sort((a, b) => b[1] - a[1]);
  if (statuses.length) {
    L.push('');
    L.push('## Tracker by status');
    for (const [s, n] of statuses) L.push(`- ${s}: ${n}`);
  }
  L.push('');
  L.push('## Steps');
  for (const s of d.steps) {
    const icon = s.ok ? '✅' : '❌';
    L.push(`- ${icon} ${s.id} (${(s.ms / 1000).toFixed(1)}s) — ${s.note}`);
  }
  L.push('');
  L.push('## Next actions (human-in-the-loop)');
  if (d.pipeline_pending > 0) L.push(`- Evaluate ${d.pipeline_pending} pending lead(s): run the \`pipeline\` mode.`);
  if (d.replies_pending > 0) L.push('- Review classified replies: `node reply-watch.mjs`.');
  if (d.followups_due) L.push('- Send due follow-ups: `node followup-cadence.mjs --summary`.');
  if (d.pipeline_pending === 0 && !d.replies_pending && !d.followups_due) L.push('- Nothing needs you right now. 🎉');
  L.push('');
  return L.join('\n');
}

/** Best-effort follow-up-due count via followup-cadence.mjs --json. */
function getFollowupsDue() {
  try {
    const res = spawnSync('node', ['followup-cadence.mjs', '--json'], {
      cwd: __dirname, encoding: 'utf-8', timeout: 60_000, env: process.env,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const data = JSON.parse(res.stdout);
    // Tolerate a few plausible shapes without hard-coupling to the schema.
    if (Array.isArray(data?.due)) return data.due.length;
    if (typeof data?.due_count === 'number') return data.due_count;
    if (Array.isArray(data?.followups)) return data.followups.filter(f => f?.due || f?.overdue).length;
    return null;
  } catch {
    return null;
  }
}

/** Best-effort pipeline health score via health.mjs --json. */
function getHealth() {
  try {
    const res = spawnSync('node', ['health.mjs', '--json'], { cwd: __dirname, encoding: 'utf-8', timeout: 60_000, env: process.env });
    if (res.status !== 0 || !res.stdout) return null;
    const d = JSON.parse(res.stdout);
    return typeof d?.score === 'number' ? d : null;
  } catch {
    return null;
  }
}

function appendRunLog(d) {
  try {
    const header = 'date\tnew_leads\tpipeline_pending\treplies_pending\tfollowups_due\tsteps_ok\tsteps_total\n';
    if (!existsSync(RUNLOG_PATH)) {
      mkdirSync(path.dirname(RUNLOG_PATH), { recursive: true });
      writeFileSync(RUNLOG_PATH, header, 'utf-8');
    }
    const okCount = d.steps.filter(s => s.ok).length;
    appendFileSync(
      RUNLOG_PATH,
      `${d.date}\t${d.new_leads}\t${d.pipeline_pending}\t${d.replies_pending}\t${d.followups_due ?? ''}\t${okCount}\t${d.steps.length}\n`,
      'utf-8',
    );
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = opts.noPlugins
    ? { enabledIngest: [], enabledExport: [] }
    : await discoverEnabledPlugins(__dirname);
  const plan = buildPlan(opts, ctx);
  const date = new Date().toISOString().slice(0, 10);

  if (opts.dryRun) {
    const lines = plan.map((s, i) => `  ${i + 1}. ${s.id} — ${s.label}`);
    const text = ['Orchestrator plan (dry run — nothing executed):', ...lines,
      '', 'Digest would be written to data/orchestrator-digest.md.'].join('\n');
    if (opts.json) console.log(JSON.stringify({ dryRun: true, date, plan: plan.map(s => s.id) }, null, 2));
    else console.log(text);
    return 0;
  }

  const before = countPipelineEntries(readFileSafe(PIPELINE_PATH));
  const steps = [];
  for (const step of plan) {
    if (!opts.quiet && !opts.json) console.log(`\n▶ ${step.label} …`);
    const result = runStep(step, opts);
    steps.push(result);
    if (!result.ok && opts.strict && step.critical) break;
  }

  const after = countPipelineEntries(readFileSafe(PIPELINE_PATH));
  const tracker = summarizeTracker(readFileSafe(APPS_PATH));
  const replies = existsSync(REPLIES_PATH) ? countReplyCandidates(readFileSafe(REPLIES_PATH)) : 0;
  const followupsDue = getFollowupsDue();
  const health = getHealth();

  const digest = buildDigest({ before, after, steps, tracker, replies, followupsDue, health, date });
  const md = formatDigest(digest);

  try {
    mkdirSync(path.dirname(DIGEST_PATH), { recursive: true });
    writeFileSync(DIGEST_PATH, md, 'utf-8');
  } catch { /* non-fatal */ }
  appendRunLog(digest);

  if (opts.json) console.log(JSON.stringify(digest, null, 2));
  else {
    console.log('\n' + '─'.repeat(60));
    console.log(md);
  }

  const anyFailed = steps.some(s => !s.ok);
  return opts.strict && anyFailed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('orchestrate: fatal —', err?.message || err);
    process.exit(1);
  });
}
