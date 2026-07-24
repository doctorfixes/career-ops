---
name: career-ops-plugin-airtable
description: How to mirror the career-ops tracker to an Airtable base and read records back as job leads.
license: MIT
---

# airtable plugin

Mirrors your application tracker to an Airtable base (export) and reads records
back into the pipeline (search). `data/applications.md` stays the source of
truth — Airtable is an additive mirror, a sibling of the Notion plugin.

## Commands

- `node plugins.mjs run airtable export` — push each tracker row (Company / Role
  / Status / Score) to the "Applications" table in your base. Existing
  company+role rows are updated in place; new ones are created. Add `--dry-run`
  to preview without writing.
- `node plugins.mjs run airtable search "<query>"` — return records that carry a
  job URL, matching the query, and append them to the pipeline.

## Setup

An Airtable base (its id starts with `app`) containing a table named
"Applications" with these fields:

- **Company** — single line text
- **Role** — single line text
- **Status** — single select (or single line text)
- **Score** — number
- **URL** — single line text (only needed for `search`)

Create a personal access token with `data.records:read` + `data.records:write`
scoped to that base. Put both in `.env`:

```
AIRTABLE_TOKEN=pat...
AIRTABLE_BASE_ID=app...
```

Enable in `config/plugins.yml`:

```yaml
plugins:
  airtable:
    enabled: true
    # table: "Applications"   # override the table name if yours differs
```

## Data it produces

`search` returns `Job[]` ({ title, url, company, location }) for records that
have a job URL; the engine writes them to the pipeline. `export` returns
{ pushed: N } — it never writes local files.
