#!/usr/bin/env node
/**
 * discover-feeds.mjs — probe DISABLED tracked_companies for a reachable feed.
 *
 * HONEST VERSION: checks the raw HTTP status of each candidate feed endpoint.
 * The earlier attempt routed phenom candidates through phenom.fetch(), which
 * swallows fetch errors (catch { break }) — so a 404 was misreported as
 * "empty (0)". Here we probe the endpoint directly and report the real status
 * so a dead board is never confused with a live-but-empty one.
 *
 * Usage: node discover-feeds.mjs
 */

import { existsSync, readFileSync } from 'fs';
import yaml from 'js-yaml';
import { ATS, deriveSlugCandidates } from './verify-portals.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const UA = 'Mozilla/5.0 (compatible; career-ops/1.3)';

function httpStatus(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);
  return fetch(url, {
    method: opts.method || 'GET',
    headers: { 'user-agent': UA, ...(opts.headers || {}) },
    body: opts.body || undefined,
    redirect: 'error',
    signal: controller.signal,
  }).then(r => ({ status: r.status, ok: r.ok, body: r }))
    .catch(e => ({ status: e.status || 0, ok: false, err: e.message }))
    .finally(() => clearTimeout(t));
}

const PHENOM_BODY = JSON.stringify({
  lang: "en_global", country: "global", pageName: "search-results", ddoKey: "refineSearch",
  sortBy: "", subsearch: "", from: 0, jobs: true, counts: true,
  all_fields: ["category", "country", "city"], size: 100, clearAll: false,
  jdsource: "facets", isSliderEnable: false, pageId: "page10", siteType: "external",
  keywords: "", global: true, selected_fields: {}, locationData: {},
});

function buildCandidates(company) {
  const url = company.careers_url || '';
  const name = company.name || '';
  const cands = [];

  // Phenom /widgets POST (branded hosts).
  if (url.startsWith('http')) {
    let origin;
    try { origin = new URL(url).origin; } catch { origin = null; }
    if (origin) {
      cands.push({ via: 'phenom/widgets', method: 'POST',
        url: `${origin}/widgets`, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: PHENOM_BODY });
    }
  }

  // ATS slug GETs.
  for (const slug of deriveSlugCandidates(name)) {
    for (const ats of Object.keys(ATS)) {
      cands.push({ via: `${ats}/${slug}`, method: 'GET', url: ATS[ats].probeUrl(slug), headers: { accept: 'application/json' } });
    }
  }

  // Workday CXS POST (only if a tenant is apparent).
  const wd = (url.match(/([\w-]+)\.wd[\w-]*\.myworkdayjobs\.com/) || []);
  if (wd[1]) {
    const tenant = wd[1];
    const site = company.workday_site || tenant;
    cands.push({ via: `workday/${tenant}/${site}`, method: 'POST',
      url: `https://${tenant}.wd5.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0, searchText: '', appliedFacets: {} }) });
  }

  return cands;
}

async function main() {
  if (!existsSync(PORTALS_PATH)) { console.error('portals.yml not found'); process.exit(1); }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = (config.tracked_companies || []).filter(c => c.enabled === false);
  console.log(`Probing ${companies.length} disabled brands (honest HTTP status)...\n`);

  let liveCount = 0;
  const hits = [];
  for (const company of companies) {
    const cands = buildCandidates(company);
    let best = null;
    for (const c of cands) {
      const res = await httpStatus(c.url, { method: c.method, headers: c.headers, body: c.body });
      const code = res.status;
      // 2xx = live. 200 with a job-bearing body is the real target; we treat any
      // 2xx as "endpoint reachable" and note it. 3xx/4xx/5xx/0 = dead for our purposes.
      if (code >= 200 && code < 300) {
        best = { via: c.via, status: code };
        break;
      }
    }
    if (best) { liveCount++; hits.push({ name: company.name, ...best }); }
    console.log(`  ${best ? '✅' : '❌'} ${company.name} — ${best ? best.via + ' (' + best.status + ')' : 'all dead'}`);
  }

  console.log(`\n=== ${liveCount}/${companies.length} disabled brands have a reachable feed ===`);
  for (const h of hits) console.log(`  ${h.name}: ${h.via} (${h.status})`);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
