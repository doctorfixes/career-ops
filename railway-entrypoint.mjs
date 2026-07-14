#!/usr/bin/env node

/**
 * Railway Entrypoint — career-ops API server
 *
 * Exposes webhook endpoints for:
 *   - Railway cron triggers (scan, pipeline)
 *   - Hermes agent webhook calls (evaluate, status)
 *   - Health checks
 *
 * Runs the openrouter-runner.mjs scripts via child_process.
 * Output is written to Railway Volumes and returned as JSON.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

// reports index count — recomputed on demand so /api/data can reference it
function countReports() {
  const reportsDir = join(__dirname, 'reports');
  if (!existsSync(reportsDir)) return 0;
  const idx = join(reportsDir, 'index.json');
  if (!existsSync(idx)) return 0;
  try { return readFileSync(idx, 'utf-8').split('\n').filter(l => l.trim()).length; }
  catch { return 0; }
}

// Ensure data directories exist
for (const dir of ['data', 'reports', 'output']) {
  const p = join(__dirname, dir);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function runScript(script, args = []) {
  return new Promise((resolve) => {
    const proc = spawn('node', [script, ...args], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000, // 5 min
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function serveStatic(res, filePath, contentType) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
  const body = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  res.end(body);
}

function splitRow(line) {
  // split a markdown table row on | but ignore leading/trailing pipes
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
}

function parsePipelineEntry(rest) {
  let parts = splitRow(rest).map(s => s.trim());
  const entry = {};
  // pull labeled segments (note: / posted:) out before positional mapping
  const labels = {};
  parts = parts.filter(p => {
    const m = p.match(/^(note|posted):\s*(.*)$/i);
    if (m) { labels[m[1].toLowerCase()] = m[2]; return false; }
    return true;
  });
  // numbered/processed entry:  #NNN | url | Company | Role | Score/5 | PDF ✅
  if (parts[0] && /^#\d+/.test(parts[0])) {
    entry.num = parts[0];
    entry.url = parts[1] || '';
    entry.company = parts[2] || '';
    entry.title = parts[3] || '';
    entry.score = parts[4] || '';
    entry.pdf = parts[5] || '';
  } else {
    entry.url = parts[0] || '';
    entry.company = parts[1] || '';
    entry.title = parts[2] || '';
    entry.location = parts[3] || '';
    entry.compensation = parts[4] || '';
  }
  if (labels.note) entry.note = labels.note;
  if (labels.posted) entry.posted = labels.posted;
  return entry;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS for Hermes webhooks
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Health check ──────────────────────────────────────────
  if (method === 'GET' && path === '/health') {
    return jsonResponse(res, 200, { status: 'ok', version: '1.0.0' });
  }

  // ── Status — pipeline + tracker summary ──────────────────
  if (method === 'GET' && path === '/api/status') {
    const stats = { pipeline: [], tracker: [], reports: [] };

    // Read pipeline
    const pipelinePath = join(__dirname, 'data', 'pipeline.md');
    if (existsSync(pipelinePath)) {
      stats.pipeline = readFileSync(pipelinePath, 'utf-8').split('\n').filter(l => l.trim()).length;
    }

    // Read tracker
    const trackerPath = join(__dirname, 'data', 'applications.md');
    if (existsSync(trackerPath)) {
      stats.tracker = readFileSync(trackerPath, 'utf-8').split('\n').filter(l => l.trim()).length;
    }

    stats.reports = countReports();

    return jsonResponse(res, 200, stats);
  }

  // ── Scan (triggers ATS scanner) ──────────────────────────
  if (method === 'POST' && path === '/api/scan') {
    const result = await runScript(join(__dirname, 'openrouter-runner.mjs'), ['scan']);
    return jsonResponse(res, result.code === 0 ? 200 : 500, {
      success: result.code === 0,
      stdout: result.stdout.slice(0, 5000),
      stderr: result.stderr.slice(0, 2000),
      exit_code: result.code,
    });
  }

  // ── Pipeline (process pending offers) ────────────────────
  if (method === 'POST' && path === '/api/pipeline') {
    const result = await runScript(join(__dirname, 'openrouter-runner.mjs'), ['pipeline']);
    return jsonResponse(res, result.code === 0 ? 200 : 500, {
      success: result.code === 0,
      stdout: result.stdout.slice(0, 10000),
      stderr: result.stderr.slice(0, 2000),
      exit_code: result.code,
    });
  }

  // ── Evaluate a single URL (one-off) ─────────────────────
  if (method === 'POST' && path === '/api/evaluate') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = {}; }
      const url = payload.url;
      if (!url) return jsonResponse(res, 400, { error: 'url required' });

      const result = await runScript(
        join(__dirname, 'openrouter-runner.mjs'),
        ['evaluate', url]
      );
      return jsonResponse(res, result.code === 0 ? 200 : 500, {
        success: result.code === 0,
        url,
        stdout: result.stdout.slice(0, 10000),
        stderr: result.stderr.slice(0, 2000),
        exit_code: result.code,
      });
    });
    return;
  }

  // ── Served dashboard (visual tracker) ────────────────────
  if (method === 'GET' && path === '/web') {
    return serveStatic(res, join(__dirname, 'web-dashboard', 'index.html'), 'text/html');
  }

  // Static assets under /web-dashboard/*
  if (method === 'GET' && path.startsWith('/web-dashboard/')) {
    const rel = path.replace('/web-dashboard/', '');
    const safe = rel.replace(/\.\.+/g, '');
    const fp = join(__dirname, 'web-dashboard', safe);
    const ext = fp.split('.').pop().toLowerCase();
    const ct = { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', png: 'image/png', json: 'application/json' }[ext] || 'application/octet-stream';
    return serveStatic(res, fp, ct);
  }

  // ── Full data (parsed pipeline + tracker + stats) ────────
  if (method === 'GET' && path === '/api/data') {
    const out = { stats: {}, pipeline: { pending: [], processed: [] }, tracker: [] };

    // pipeline.md → parse Pending / Processed checkbox rows
    const pipelinePath = join(__dirname, 'data', 'pipeline.md');
    if (existsSync(pipelinePath)) {
      const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
      let section = null;
      for (const line of lines) {
        const m = line.match(/^##\s+(Pending|Processed)\s*$/);
        if (m) { section = m[1].toLowerCase(); continue; }
        if (!section) continue;
        const cb = line.match(/^-\s*\[([ x!])\]\s+(.*)$/);
        if (!cb) continue;
        const checked = cb[1] === 'x';
        if ((section === 'pending' && checked) || (section === 'processed' && !checked)) continue;
        const entry = parsePipelineEntry(cb[2]);
        (checked ? out.pipeline.processed : out.pipeline.pending).push(entry);
      }
    }

    // applications.md → parse markdown table rows (skip header + separator)
    const trackerPath = join(__dirname, 'data', 'applications.md');
    if (existsSync(trackerPath)) {
      const rows = readFileSync(trackerPath, 'utf-8').split('\n').filter(l => l.trim().startsWith('|'));
      if (rows.length > 1) {
        const headers = splitRow(rows[0]).map(h => h.trim());
        for (let i = 2; i < rows.length; i++) {
          const cells = splitRow(rows[i]).map(c => c.trim());
          if (cells.length < headers.length) continue;
          const obj = {}; headers.forEach((h, idx) => { obj[h] = cells[idx]; });
          if (obj['#'] === '' || obj['#'] === undefined) continue;
          out.tracker.push(obj);
        }
      }
    }

    // derived stats
    const statuses = out.tracker.map(r => (r.Status || '').trim());
    out.stats = {
      pending: out.pipeline.pending.length,
      processed: out.pipeline.processed.length,
      applications: out.tracker.length,
      reports: countReports(),
      interviews: statuses.filter(s => s === 'Interview').length,
      offers: statuses.filter(s => s === 'Offer').length,
    };
    return jsonResponse(res, 200, out);
  }


});

server.listen(PORT, () => {
  console.log(`career-ops API server listening on port ${PORT}`);
});