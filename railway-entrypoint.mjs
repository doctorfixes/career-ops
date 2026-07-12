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

    // Count reports
    const reportsDir = join(__dirname, 'reports');
    if (existsSync(reportsDir)) {
      stats.reports = readFileSync(join(reportsDir, 'index.json'), 'utf-8')
        .split('\n').filter(l => l.trim()).length;
    }

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

  // ── 404 ──────────────────────────────────────────────────
  jsonResponse(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`career-ops API server listening on port ${PORT}`);
});