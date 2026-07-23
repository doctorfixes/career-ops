# Mode: learn — Calibrate the System From Outcomes

Close the learning loop. `learn.mjs` reads every analytics signal (rejection
patterns, funnel velocity, channel yield, salary gaps, skill gaps) and produces
**prioritized tuning proposals** mapped to specific knobs. This mode is how you
(the agent) walk the user through reviewing and safely applying them.

**Propose → review → approve → apply → re-gate.** Nothing is auto-applied. The
engine proposes; the user approves; you edit the named knob; the golden-eval
gate confirms no scoring regression.

## When to use

- The user asks to "tune", "calibrate", "improve targeting", "learn from my
  results", "what should I change", or "why am I not getting traction".
- Periodically once there are enough tracked outcomes (a handful of applications
  with replies/interviews/rejections). On a fresh tracker it will honestly say
  "not enough data yet".

## Step 1 — Generate proposals

```bash
node learn.mjs            # human-readable, writes data/learn-proposals.md
node learn.mjs --json     # structured
```

Each proposal carries: a **target file + knob**, a **suggestion**, **evidence**
(the outcome data that drove it), a **confidence** (from sample size), and a
`gated` flag. Low-confidence (small-sample) proposals are hidden unless
`--show-low`.

The report header shows the **golden-eval baseline** — the scoring accuracy
gate. If it's red, do NOT apply any `gated` change until it's green again.

## Step 2 — Review with the user

Present the ranked proposals. For each, state the evidence and the exact change.
Do not apply anything yet. Let the user accept, reject, or modify each one. Be
honest about confidence: a `medium (n=6)` signal is a hypothesis, not a law.

## Step 3 — Apply approved changes (user-layer, on approval only)

Apply only what the user approved, to the knob the proposal names:

- **Archetype re-weighting / targeting** → edit `config/profile.yml`
  `target_roles.archetypes[].fit`, and the framing tables in `modes/_profile.md`.
- **Score / apply floor** → `config/profile.yml` `auto_pdf_score_threshold`.
- **Channel strategy** → `modes/_profile.md` channel notes and/or `portals.yml`
  priorities.
- **Comp target** → `config/profile.yml` `compensation`.
- **Follow-up cadence** → `config/profile.yml` `followup_cadence`.
- **Skill focus** → surface real experience more prominently in `cv.md` /
  `article-digest.md`; never invent a skill.

These are **user-layer** files (DATA_CONTRACT.md). You edit them only because the
user approved the specific change — the same "user asks → agent edits" model as
the rest of career-ops. Never fabricate facts; re-weighting and re-framing only.

## Step 4 — Re-run the gate (for any gated change)

After editing anything that affects scoring/archetypes/targeting, confirm you
didn't regress accuracy:

```bash
node eval-golden.mjs --replay --model cheap-stub
```

Must still PASS (archetype agreement ≥ gate). If it fails, revert the change and
tell the user which edit broke the baseline. This is the safety interlock that
makes dynamic tuning safe.

## Guardrails

- **Propose-only engine.** `learn.mjs` never writes user facts. It writes only
  `data/learn-proposals.md` (a report).
- **Evidence-gated.** A proposal fires only above a sample-size floor
  (`--min-n`, default 5). Small samples are labeled low-confidence.
- **Regression-gated.** Scoring/targeting changes are interlocked by the golden
  eval — chase a pattern without silently degrading scoring.
- **Human-in-the-loop, always.** The system proposes direction; the user
  decides; you apply and verify.
