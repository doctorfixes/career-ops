# Automation — the daily loop, scheduled

career-ops is a toolbox of local-first steps (scan, liveness, tracker hygiene,
follow-ups, reply triage, CRM mirror). `orchestrate.mjs` chains them into **one
command** so a scheduler can run the whole discovery-and-hygiene loop
unattended — while every decision that needs a human still waits for you.

```
scan → plugin ingests → liveness sweep → merge-tracker → followup-seed
     → (optional reply ingest) → plugin export → digest
```

## The human-in-the-loop guarantee

The orchestrator **discovers and tidies**; it never decides. It does **not**:

- evaluate offers with an LLM (that costs tokens and is a judgement call — you
  run the `pipeline`/`oferta` modes when you're ready),
- tailor a CV or cover letter,
- apply to anything, or click Submit — ever.

What it produces is a **digest of what needs you**: new leads to evaluate,
replies to review, follow-ups due. This is the same ethical stance as the rest
of the system (see `ARCHITECTURE.md` → Principles, `AGENTS.md` → Ethical Use).

## Quick start

```bash
node orchestrate.mjs            # full daily run
node orchestrate.mjs --dry-run  # print the plan, run nothing
npm run orchestrate             # same as the first line
```

Outputs (user layer, gitignored, never auto-updated):

| File | What |
|------|------|
| `data/orchestrator-digest.md` | The latest run's digest (leads, replies, follow-ups, per-step status) |
| `data/orchestrator-runs.tsv`  | Append-only one-row-per-run history |

### Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Print the ordered plan, execute nothing |
| `--only scan,liveness` | Run just these steps |
| `--skip export` | Run everything except these |
| `--no-plugins` | Skip ingest/export plugin steps |
| `--replies eml:./mail` | Also refresh `data/reply-candidates.json` from a source (see below) |
| `--liveness-limit N` | Cap the liveness sweep (default 25) so a scheduled run stays bounded |
| `--json` | Machine-readable digest to stdout |
| `--quiet` | Only the digest, no per-step chatter |
| `--strict` | Exit non-zero if any step fails (useful for CI alerting) |

The `ingest` and `export` steps expand to one entry **per enabled plugin**
(`config/plugins.yml`). With nothing enabled, a default run is just
`scan → liveness → merge → followups`.

## Scheduling it

Pick whichever matches where you run career-ops. All of these call the same
command; the tool is stateless between runs (state lives in your files).

### cron (Linux/macOS)

```cron
# Every weekday at 08:00 — scan, tidy, and write the digest.
0 8 * * 1-5 cd /path/to/career-ops && /usr/bin/node orchestrate.mjs --quiet >> data/orchestrator.log 2>&1
```

### systemd timer (Linux)

`~/.config/systemd/user/career-ops.service`:

```ini
[Service]
Type=oneshot
WorkingDirectory=%h/career-ops
ExecStart=/usr/bin/node orchestrate.mjs --quiet
```

`~/.config/systemd/user/career-ops.timer`:

```ini
[Timer]
OnCalendar=Mon..Fri 08:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now career-ops.timer
```

### launchd (macOS)

`~/Library/LaunchAgents/io.careerops.daily.plist` — a `StartCalendarInterval`
job whose `ProgramArguments` are `node /path/to/career-ops/orchestrate.mjs
--quiet`. Load with `launchctl load ~/Library/LaunchAgents/io.careerops.daily.plist`.

### GitHub Actions (cloud, on a schedule)

Commit a workflow that runs on `schedule:` and commits the tracker/pipeline
changes back. Because `data/` is gitignored by default, a cloud run that must
persist state should either un-ignore the specific files it needs or push them
to a private branch. Keep API-key plugins off unless you add the secrets.

```yaml
on:
  schedule: [{ cron: '0 8 * * 1-5' }]
  workflow_dispatch:
jobs:
  loop:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npm install --ignore-scripts
      - run: node orchestrate.mjs --quiet --json
```

### Railway cron

The repo already ships a webhook server (`railway-entrypoint.mjs`) and
`railway.json`. Add a Railway cron trigger that hits the scan/pipeline endpoints,
or run `node orchestrate.mjs` as the scheduled command. See `docs/RAILWAY_SHIP.md`.

### From an AI CLI

If your CLI has a scheduler skill (`/loop`, `/schedule`), point it at
`node orchestrate.mjs` (or the `scan` mode) on the cadence you want.

## The reply loop (close the tracking circle)

`reply-watch.mjs` classifies employer replies and reconciles the tracker, but it
reads `data/reply-candidates.json`. `ingest-replies.mjs` produces that file from
your inbox, so the loop runs end to end:

```bash
# Offline sources (no keys, fully testable):
node ingest-replies.mjs --source eml   ./exported-mail       # a folder of .eml files
node ingest-replies.mjs --source mbox  ~/inbox.mbox          # an mbox export
node ingest-replies.mjs --source json  export.json           # any JSON array of messages

# Gmail (reuses the gmail plugin's OAuth keys in .env):
node ingest-replies.mjs --source gmail --label Applications --days-back 14

# Then review + confirm (nothing auto-updates the tracker):
node reply-watch.mjs
```

Wire it into the daily loop with `--replies`:

```bash
node orchestrate.mjs --replies gmail
```

Each candidate gets a strong-signal hint (interview / offer / rejection) from the
shared classifier; `reply-watch` re-classifies and asks before any status change.

## ATS keyword gap (per JD)

Before you apply, see how your CV reads against a specific posting:

```bash
node keyword-gap.mjs jds/acme.md                 # human summary
node keyword-gap.mjs --file jds/acme.md --json    # structured
cat jd.txt | node keyword-gap.mjs --stdin --markdown   # report-ready block
```

It reports canonical **skills present vs missing** (same vocabulary as
`upskill`) plus notable JD **keywords** absent from your CV. It's analysis only —
a missing keyword is a prompt to **reformulate real experience you already have**,
never to fabricate one.

## The learning loop (calibrate from outcomes)

`orchestrate.mjs` keeps the pipeline moving; `learn.mjs` keeps it *pointed in the
right direction*. Once you have tracked outcomes (applications with
replies/interviews/rejections), it reads every analytics signal and proposes
concrete, evidence-backed tuning:

```bash
node learn.mjs            # ranked proposals → data/learn-proposals.md
node learn.mjs --json     # structured
```

Each proposal names the exact knob to change (archetype fit, score floor,
channel strategy, comp target, follow-up cadence, skill focus), the evidence
behind it, and a confidence from sample size. It is **propose-only** — it never
edits your profile. Scoring/targeting proposals are `gated` by the golden-eval
baseline (`eval-golden.mjs`), so a calibration change can't silently degrade
scoring accuracy. The `learn` mode walks you through review → approve → apply →
re-gate. This is the "grow" half of the system: run it periodically (or after a
batch of outcomes) to keep targeting matched to what's actually converting.

**Provenance + churn guard.** Every calibration you apply is recorded in an
append-only ledger so it's legible and reversible, and so over-tuning is caught:

```bash
node tuning-log.mjs add --knob <knob> --old <v> --new <v> --evidence "..."
node tuning-log.mjs --summary   # history + flip-flop / noise-chasing flags
```

**Weekly strategic review.** Where `orchestrate` reports "what needs me today",
`weekly-review.mjs` reports "how is the search trending and what should I tune":

```bash
node weekly-review.mjs          # → data/weekly-review.md
```

It composes the funnel (`stats`), the top `learn` proposals, a
**concentration/monoculture guard** (flags over-reliance on one archetype or ATS
vendor — correlated rejections through one screening channel are a diversify
signal), and any tuning churn. Run it weekly or after a batch of outcomes.

## Diagnostics: where am I losing, and is the pipeline healthy?

Two read-only analyses complete the picture:

```bash
node conversion.mjs   # per-hop funnel conversion + the weakest hop (bottleneck)
node health.mjs       # 0–100 pipeline health score + hygiene breakdown
```

`conversion.mjs` answers "which stage am I losing people at?" — it computes each
transition (applied→responded→interview→offer), names the weakest trustworthy
hop, and points at the lever it responds to (CV/channel, screen prep, or
interview/closing). `health.mjs` rolls up hygiene drift (un-followed-up
applications, missing report links, non-canonical statuses, reply/pipeline
backlog) into a score the **orchestrator surfaces in its daily digest** — so a
degrading pipeline is visible without you going looking.

## CRM mirror (optional)

The tracker files stay canonical; a mirror is an additive, read-only snapshot for
people who like a Kanban board:

```bash
node plugins.mjs run notion export     # → your Notion "Applications" DB
node plugins.mjs run airtable export   # → your Airtable "Applications" table
```

Enable in `config/plugins.yml` and add the keys to `.env` (see
`plugins/notion/skill.md`, `plugins/airtable/skill.md`). Once enabled, the
orchestrator's `export` step runs them automatically at the end of each loop.
