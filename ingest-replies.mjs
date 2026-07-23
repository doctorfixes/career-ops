#!/usr/bin/env node

/**
 * ingest-replies.mjs — turn employer replies into reply-candidates.json.
 *
 * Closes the tracking loop. `reply-watch.mjs` already classifies replies and
 * reconciles the tracker, but it reads `data/reply-candidates.json` and nothing
 * populated that file automatically — you fed it by hand. This script does the
 * feeding: it reads emails from a source, normalizes them to the schema
 * reply-watch expects ({ message_id, from, subject, body_snippet, signal }),
 * de-dups against what's already there, and writes the file.
 *
 * Human-in-the-loop: this only PREPARES candidates. It never touches the
 * tracker — `node reply-watch.mjs` still shows you the digest and asks before
 * any status change.
 *
 * Sources:
 *   --source eml   <dir>          parse every *.eml file in a directory (offline)
 *   --source mbox  <file>         parse an mbox export (offline)
 *   --source json  <file>         normalize an arbitrary JSON array of messages
 *   --source gmail                pull from Gmail via the gmail plugin's OAuth
 *
 * Usage:
 *   node ingest-replies.mjs --source eml ./mail
 *   node ingest-replies.mjs --source mbox ~/inbox.mbox --replace
 *   node ingest-replies.mjs --source gmail --label Applications --days-back 14
 *   node ingest-replies.mjs --source json export.json --out data/reply-candidates.json
 *
 * Flags: --out <path>  --replace  --limit N  --label S  --query S  --days-back N
 *        --json  --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyReply } from './reply-matcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, 'data', 'reply-candidates.json');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ---------------------------------------------------------------------------
// Header / MIME helpers (pure)
// ---------------------------------------------------------------------------

/** Decode a run of RFC 2047 encoded-words (=?charset?B/Q?text?=) in a header. */
export function decodeMimeWords(str) {
  if (!str || !str.includes('=?')) return str || '';
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      }
      // Q-encoding: _ is space, =HH is a byte.
      const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, 'binary').toString('utf-8');
    } catch {
      return text;
    }
  }).replace(/\?=\s+=\?/g, ''); // join adjacent encoded-words
}

/** Split a raw RFC822 message into { headers: Map, body: string }. Unfolds headers. */
export function parseRfc822(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const sep = text.indexOf('\n\n');
  const headPart = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? '' : text.slice(sep + 2);
  const headers = new Map();
  const unfolded = headPart.replace(/\n[ \t]+/g, ' '); // header folding
  for (const line of unfolded.split('\n')) {
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (m) {
      const key = m[1].toLowerCase();
      // keep first occurrence for singletons; concatenation not needed for our fields
      if (!headers.has(key)) headers.set(key, m[2]);
    }
  }
  return { headers, body };
}

function cteDecode(body, cte) {
  const enc = (cte || '').toLowerCase().trim();
  try {
    if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
    if (enc === 'quoted-printable') {
      return body
        .replace(/=\r?\n/g, '')                       // soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
  } catch {
    return body;
  }
  return body;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort plain-text extraction from a (possibly multipart) message body. */
export function extractBodyText(headers, body) {
  const ctype = headers.get('content-type') || '';
  const boundaryMatch = ctype.match(/boundary="?([^";]+)"?/i);
  if (/multipart\//i.test(ctype) && boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    let htmlFallback = '';
    for (const part of parts) {
      const trimmed = part.replace(/^\n+/, '');
      if (!trimmed.trim()) continue;
      const sub = parseRfc822(trimmed);
      const subType = (sub.headers.get('content-type') || 'text/plain').toLowerCase();
      const decoded = cteDecode(sub.body, sub.headers.get('content-transfer-encoding'));
      if (subType.includes('text/plain')) return decoded.trim();
      if (subType.includes('text/html') && !htmlFallback) htmlFallback = stripHtml(decoded);
      if (subType.includes('multipart/')) {
        const nested = extractBodyText(sub.headers, sub.body);
        if (nested) return nested;
      }
    }
    return htmlFallback;
  }
  const decoded = cteDecode(body, headers.get('content-transfer-encoding'));
  if (/text\/html/i.test(ctype)) return stripHtml(decoded);
  return decoded.trim();
}

/** Collapse whitespace and cap to n chars for the body snippet. */
export function snippet(text, n = 500) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}

/** Parse one raw RFC822 email into a reply-candidate (without signal). */
export function parseEmail(raw) {
  const { headers, body } = parseRfc822(raw);
  const messageId = (headers.get('message-id') || '').replace(/[<>]/g, '').trim();
  const from = decodeMimeWords(headers.get('from') || '').trim();
  const subject = decodeMimeWords(headers.get('subject') || '').trim();
  const bodyText = extractBodyText(headers, body);
  return {
    message_id: messageId || fallbackId(from, subject, bodyText),
    from,
    subject,
    body_snippet: snippet(bodyText),
  };
}

function fallbackId(from, subject, body) {
  // Deterministic id when a message has no Message-ID header.
  const basis = `${from}|${subject}|${String(body).slice(0, 64)}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) { h = (h * 31 + basis.charCodeAt(i)) | 0; }
  return `gen-${(h >>> 0).toString(16)}`;
}

/** Split an mbox blob into individual raw messages (on `From ` separator lines). */
export function splitMbox(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const messages = [];
  let current = [];
  for (const line of lines) {
    if (/^From .*\d{4}$/.test(line) || /^From \S+@\S+/.test(line)) {
      if (current.length) messages.push(current.join('\n'));
      current = [];
      continue; // drop the mbox "From " envelope line itself
    }
    current.push(line);
  }
  if (current.length && current.join('').trim()) messages.push(current.join('\n'));
  return messages.filter(m => m.trim());
}

// ---------------------------------------------------------------------------
// Signal inference + normalization (pure)
// ---------------------------------------------------------------------------

const TYPE_TO_SIGNAL = {
  Interview: 'interview_invite',
  Offer: 'offer',
  Rejected: 'rejection',
  Responded: 'update',
};

/** Derive a strong signal hint from the shared classifier; null for weak/noise. */
export function inferSignal(cand) {
  try {
    const { type } = classifyReply(cand);
    return TYPE_TO_SIGNAL[type] || null;
  } catch {
    return null;
  }
}

/** Attach an inferred signal to each candidate (unless one is already set). */
export function withSignals(cands) {
  return cands.map(c => ({ ...c, signal: c.signal ?? inferSignal(c) }));
}

/** Normalize an arbitrary JSON array of messages into reply-candidates. */
export function normalizeJsonRecords(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r, i) => {
    const from = r.from || r.sender || r.From || '';
    const subject = r.subject || r.Subject || r.title || '';
    const bodyRaw = r.body_snippet || r.body || r.snippet || r.text || r.Body || '';
    return {
      message_id: String(r.message_id || r.id || r.messageId || fallbackId(from, subject, bodyRaw) || `json-${i}`),
      from: String(from),
      subject: String(subject),
      body_snippet: snippet(bodyRaw),
      signal: r.signal ?? null,
    };
  });
}

/** Merge incoming candidates into existing, de-duping by message_id. */
export function mergeCandidates(existing, incoming) {
  const byId = new Map();
  for (const c of Array.isArray(existing) ? existing : []) {
    if (c && c.message_id) byId.set(c.message_id, c);
  }
  let added = 0;
  for (const c of incoming) {
    if (!byId.has(c.message_id)) { byId.set(c.message_id, c); added++; }
  }
  return { merged: [...byId.values()], added };
}

// ---------------------------------------------------------------------------
// Sources (impure)
// ---------------------------------------------------------------------------

function readEmlDir(dir) {
  const abs = path.resolve(dir);
  const files = fs.readdirSync(abs).filter(f => /\.eml$/i.test(f));
  return files.map(f => parseEmail(fs.readFileSync(path.join(abs, f), 'utf-8')));
}

function readMboxFile(file) {
  const raw = fs.readFileSync(path.resolve(file), 'utf-8');
  return splitMbox(raw).map(parseEmail);
}

function readJsonFile(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8'));
  return normalizeJsonRecords(Array.isArray(data) ? data : data.messages || data.candidates || []);
}

async function getGmailAccessToken(env, fetchFn) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Gmail token refresh returned no access_token');
  return data.access_token;
}

/** Pull employer replies from Gmail. Query defaults to the inbox, last N days. */
export async function fetchGmailReplies(opts, fetchFn = globalThis.fetch) {
  const env = opts.env || process.env;
  for (const k of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) {
    if (!env[k]) throw new Error(`gmail: missing ${k} in .env`);
  }
  const daysBack = Number(opts.daysBack ?? 14);
  const q = opts.query
    || (opts.label ? `label:"${opts.label}" newer_than:${daysBack}d`
      : `in:inbox newer_than:${daysBack}d`);
  const token = await getGmailAccessToken(env, fetchFn);
  const auth = { Authorization: `Bearer ${token}` };

  const ids = [];
  let pageToken = null;
  do {
    let url = `${GMAIL_API}/messages?q=${encodeURIComponent(q)}`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const data = await (await fetchFn(url, { headers: auth })).json();
    if (data.messages) ids.push(...data.messages);
    pageToken = data.nextPageToken;
    if (opts.limit && ids.length >= opts.limit) break;
  } while (pageToken);

  const capped = opts.limit ? ids.slice(0, opts.limit) : ids;
  const cands = [];
  for (const m of capped) {
    try {
      const msg = await (await fetchFn(`${GMAIL_API}/messages/${m.id}?format=raw`, { headers: auth })).json();
      const raw = msg.raw ? Buffer.from(msg.raw, 'base64url').toString('utf-8') : '';
      const cand = parseEmail(raw);
      cand.message_id = cand.message_id || m.id;
      cands.push(cand);
    } catch (err) {
      console.warn(`gmail: skipped message ${m.id} — ${err.message}`);
    }
  }
  return cands;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = {
    source: null, arg: null, out: DEFAULT_OUT, replace: false,
    limit: 0, label: null, query: null, daysBack: 14, json: false, dryRun: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a === '--source' || a.startsWith('--source=')) out.source = val();
    else if (a === '--out' || a.startsWith('--out=')) out.out = val();
    else if (a === '--replace') out.replace = true;
    else if (a === '--limit' || a.startsWith('--limit=')) out.limit = parseInt(val(), 10) || 0;
    else if (a === '--label' || a.startsWith('--label=')) out.label = val();
    else if (a === '--query' || a.startsWith('--query=')) out.query = val();
    else if (a === '--days-back' || a.startsWith('--days-back=')) out.daysBack = parseInt(val(), 10) || 14;
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  // First positional is the source's path arg (eml dir / mbox / json file).
  if (positional.length && !out.arg) out.arg = positional[0];
  return out;
}

async function collectCandidates(opts) {
  switch (opts.source) {
    case 'eml':
      if (!opts.arg) throw new Error('eml source needs a directory: --source eml <dir>');
      return readEmlDir(opts.arg);
    case 'mbox':
      if (!opts.arg) throw new Error('mbox source needs a file: --source mbox <file>');
      return readMboxFile(opts.arg);
    case 'json':
      if (!opts.arg) throw new Error('json source needs a file: --source json <file>');
      return readJsonFile(opts.arg);
    case 'gmail':
      return fetchGmailReplies({ label: opts.label, query: opts.query, daysBack: opts.daysBack, limit: opts.limit });
    default:
      throw new Error(`unknown --source "${opts.source}". Use eml | mbox | json | gmail.`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source) {
    console.error('Usage: node ingest-replies.mjs --source <eml|mbox|json|gmail> [path] [flags]');
    return 1;
  }

  let raw = await collectCandidates(opts);
  if (opts.limit > 0 && opts.source !== 'gmail') raw = raw.slice(0, opts.limit);
  const incoming = withSignals(raw);

  const existing = (!opts.replace && fs.existsSync(opts.out))
    ? safeJson(fs.readFileSync(opts.out, 'utf-8'))
    : [];
  const { merged, added } = opts.replace
    ? { merged: incoming, added: incoming.length }
    : mergeCandidates(existing, incoming);

  const strong = incoming.filter(c => c.signal).length;

  if (opts.dryRun) {
    const summary = { source: opts.source, parsed: incoming.length, added, strong_signals: strong, total: merged.length, out: rel(opts.out), dryRun: true };
    console.log(opts.json ? JSON.stringify(summary, null, 2)
      : `[dry-run] ${incoming.length} parsed, ${added} new, ${strong} with a strong signal → would write ${merged.length} to ${rel(opts.out)}`);
    return 0;
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  const summary = { source: opts.source, parsed: incoming.length, added, strong_signals: strong, total: merged.length, out: rel(opts.out) };
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Ingested ${incoming.length} reply(ies) from ${opts.source}: ${added} new (${strong} with a strong signal).`);
    console.log(`Wrote ${merged.length} candidate(s) to ${rel(opts.out)}.`);
    if (added > 0) console.log('Next: node reply-watch.mjs   (review + confirm tracker updates)');
  }
  return 0;
}

function safeJson(text) { try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; } }
function rel(p) { return path.relative(__dirname, p) || p; }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code || 0)).catch((err) => {
    console.error('ingest-replies: fatal —', err?.message || err);
    process.exit(1);
  });
}
