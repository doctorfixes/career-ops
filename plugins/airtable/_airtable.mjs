// @ts-check
// Airtable API helper for the airtable plugin. Mirrors the Notion plugin's
// _notion.mjs contract so the two CRM mirrors behave identically:
//
//  - No module-level secrets. The token + base id come from the plugin's scoped
//    ctx.env; nothing reads process.env at import time.
//  - templates/states.yml (the canonical status source of truth) is resolved
//    from the repo root, two levels up from this bundled plugin.
//  - Network goes through the injected fetchFn (ctx.fetch → the engine's
//    allowedHosts/HTTPS/redirect guard); falls back to global fetch standalone.
//
// Files prefixed with _ are never discovered as plugins.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const DIR = dirname(fileURLToPath(import.meta.url));
const STATES_PATH = join(DIR, '..', '..', 'templates', 'states.yml');

// ── canonical states (templates/states.yml is the source of truth) ──────────
let _states;
function loadStates() {
  if (_states) return _states;
  const doc = yaml.load(readFileSync(STATES_PATH, 'utf-8'));
  const labels = [], aliasMap = {};
  for (const s of doc.states) {
    labels.push(s.label);
    aliasMap[s.label.toLowerCase()] = s.label;
    for (const a of (s.aliases || [])) aliasMap[String(a).toLowerCase()] = s.label;
  }
  _states = { labels, aliasMap };
  return _states;
}

/** Canonical label for a status (case-insensitive, alias-aware), or null. */
export function canonicalStatus(raw) {
  if (!raw) return null;
  const key = String(raw).replace(/\*\*/g, '').trim().toLowerCase();
  return loadStates().aliasMap[key] || null;
}

/**
 * Parse a tracker score cell (e.g. `4.2/5`, `**4.2/5**`, `4.25`) into a number.
 * Matches the Notion plugin's parseScore so both mirrors store the same value.
 * @param {unknown} s
 * @returns {number} parsed score, or NaN.
 */
export function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

/**
 * Build an Airtable client bound to one user's token + base. The table name is
 * resolved by NAME (default "Applications") — no table id embedded.
 * @param {{ token: string, baseId: string, table?: string, fetch?: Function }} cfg
 */
export function createAirtableClient({ token, baseId, table = 'Applications', fetch: fetchFn = globalThis.fetch }) {
  if (!token) throw new Error('AIRTABLE_TOKEN is not set (.env) — the Airtable plugin needs it to read/write.');
  if (!baseId) throw new Error('AIRTABLE_BASE_ID is not set (.env) — the id of your base (starts with "app").');
  const HEADERS = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const BASE = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(url, method, body) {
    await sleep(220); // stay under Airtable's ~5 req/s per base
    const r = await fetchFn(url, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
    // ctx.fetch throws on non-2xx (message carries the body); this branch is the
    // fallback when a plain global fetch is injected (standalone use).
    if (r && typeof r.ok === 'boolean' && !r.ok) {
      let detail = '';
      try { detail = JSON.stringify(await r.json()); } catch { /* ignore */ }
      throw new Error(`Airtable ${method} ${table} -> ${r.status}: ${detail}`);
    }
    return r.json();
  }

  /** All records in the table (paginated). */
  async function listRecords() {
    const all = [];
    let offset;
    do {
      const url = `${BASE}?pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
      const j = await api(url, 'GET');
      all.push(...(j.records || []));
      offset = j.offset;
    } while (offset);
    return all;
  }

  async function createRecord(fields) {
    return api(BASE, 'POST', { fields });
  }

  async function updateRecord(id, fields) {
    return api(`${BASE}/${id}`, 'PATCH', { fields });
  }

  function summarize(r) {
    const f = r.fields || {};
    return {
      id: r.id,
      company: String(f.Company || ''),
      role: String(f.Role || ''),
      status: String(f.Status || ''),
      score: typeof f.Score === 'number' ? f.Score : null,
      jobUrl: String(f.URL || ''),
    };
  }

  /** Records matching "<company> / <role>" (substring) or exact company. */
  async function findRecords(match) {
    const m = String(match).toLowerCase().trim();
    return (await listRecords()).map(summarize).filter((r) => {
      const hay = `${r.company} / ${r.role}`.toLowerCase();
      return hay.includes(m) || r.company.toLowerCase() === m;
    });
  }

  return { api, listRecords, createRecord, updateRecord, findRecords, summarize };
}
