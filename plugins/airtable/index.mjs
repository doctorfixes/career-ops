// @ts-check
// ── Reference seed ── This bundled plugin is a stable, reviewed example. To
// extend it, publish career-ops-plugin-airtable with "supersedesBundled": true
// and your version takes precedence once installed (see docs/PLUGINS.md).
// Bundled seeds take only security/compat fixes — feature work happens in the
// successor repo.
//
// Airtable plugin — mirror your tracker to an Airtable base (export) and read
// records back as job leads (search). A sibling of the Notion plugin: same
// OPT-IN MIRROR posture. data/applications.md stays the canonical source of
// truth (the web reads it); `export` pushes a read-only snapshot of it to your
// own Airtable base. The core never writes to Airtable as primary, and modes are
// not edited — this lives entirely behind `node plugins.mjs run airtable`.
//
// Setup: a base (id starts with "app") containing a table named "Applications"
// with Company / Role / Status / Score fields (add a URL field to use search).
// Enable in config/plugins.yml; put AIRTABLE_TOKEN + AIRTABLE_BASE_ID in .env.
//
//   node plugins.mjs run airtable export             # mirror tracker → Airtable
//   node plugins.mjs run airtable search "platform"  # read matching records → pipeline

import { createAirtableClient, canonicalStatus, parseScore } from './_airtable.mjs';

function clientFromCtx(ctx) {
  return createAirtableClient({
    token: ctx?.env?.AIRTABLE_TOKEN,
    baseId: ctx?.env?.AIRTABLE_BASE_ID,
    table: ctx?.settings?.table || 'Applications',
    fetch: ctx?.fetch, // route through the engine's allowedHosts/redirect guard
  });
}

/**
 * Build the Airtable field set for one tracker row. Pure + exported so the
 * mapping is unit-testable without the network.
 * @param {Record<string,string>} row
 * @returns {Record<string, string|number>|null} fields, or null to skip the row.
 */
export function fieldsForRow(row) {
  const company = (row.company || '').trim();
  const role = (row.role || '').trim();
  if (!company || !role) return null;
  const fields = { Company: company, Role: role };
  const status = canonicalStatus(row.status);
  if (status) fields.Status = status;
  const score = parseScore(row.score);
  if (Number.isFinite(score)) fields.Score = score;
  return fields;
}

export default {
  fieldsForRow,
  parseScore,

  /**
   * export: upsert each tracker row into the user's Airtable "Applications"
   * table. Receives a frozen read-only snapshot — never a file handle.
   * @param {{ applications: Array<Record<string,string>> }} snapshot
   * @param {any} ctx
   */
  async export(snapshot, ctx) {
    const rows = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    if (rows.length === 0) return { pushed: 0 };
    const client = clientFromCtx(ctx);

    // Fetch existing records once and index by company|role for the upsert.
    const index = new Map();
    if (!ctx?.dryRun) {
      for (const rec of await client.listRecords()) {
        const s = client.summarize(rec);
        index.set(`${s.company.toLowerCase()}|${s.role.toLowerCase()}`, rec.id);
      }
    }

    let pushed = 0;
    for (const row of rows) {
      const fields = fieldsForRow(row);
      if (!fields) continue;

      if (ctx?.dryRun) { ctx.log(`would push: ${fields.Company} — ${fields.Role}`); pushed++; continue; }

      const key = `${String(fields.Company).toLowerCase()}|${String(fields.Role).toLowerCase()}`;
      const existingId = index.get(key);
      if (existingId) await client.updateRecord(existingId, fields);
      else {
        const created = await client.createRecord(fields);
        if (created?.id) index.set(key, created.id);
      }
      pushed++;
    }
    return { pushed };
  },

  /**
   * search: return Airtable records carrying a job URL as Job[]. `export` mirrors
   * the tracker (company/role/status/score) and does NOT set a URL, so
   * export-created rows are not round-tripped — that's intentional, they already
   * live in your tracker. The engine writes any results to the pipeline.
   * @param {string} query
   * @param {any} ctx
   */
  async search(query, ctx) {
    const client = clientFromCtx(ctx);
    const hits = await client.findRecords(query);
    return hits
      .filter((h) => h.jobUrl && /^https?:\/\//i.test(h.jobUrl))
      .map((h) => ({ title: h.role || 'Airtable record', url: h.jobUrl, company: h.company || '', location: '' }));
  },
};
