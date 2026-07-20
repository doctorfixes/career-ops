# Mode: job — Full A-G Evaluation (CPU-optimized)

When given a job description, deliver the full evaluation following the gates and blocks below.

## Liveness gate (URL inputs)

Before running any evaluation block, confirm the posting is still live.

1. Classify the page content:
   - **active posting evidence:** title/role + a real job description or an apply path
   - **closed posting evidence:** expired/closed/"no longer accepting applications", missing JD with only nav/footer, hard redirect to a generic careers page, or 404/410
2. If the posting appears closed, **stop here**: do not run Block A or beyond. Tell the candidate the link is dead.
3. If only JD text was pasted (no URL), skip the gate and proceed.

Do not continue to Block A until this gate is resolved.

## Blacklist gate

If `data/blacklist.md` exists, check the posting's company against it before running any evaluation — the file is the candidate's own do-not-apply list (user layer, opt-in; absent file = skip this gate). Match case- and punctuation-insensitively.

On a hit, **stop before Block A** and surface the candidate's own recorded decision: tell them which entry matched and quote their recorded reason. Wait for an explicit answer — never silently refuse, never silently proceed. The candidate's call always wins.

## Bounded Research Budget

Company, compensation, and hiring-signal research is single-pass and capped.

- **hard cap: 5 total WebSearch queries** for the entire evaluation
- Do not invoke `deep-research`
- Do not spawn subagents
- Do not continue researching after the query cap is reached
- Use JD text as primary source; web lookups only supplement missing salary/company data

## Block A — Role Summary

Table with:
- Archetype detected
- Domain (rooms/F&B/general management/task force)
- Function (operations/management/leadership)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (if mentioned)
- TL;DR in 1 sentence

### Geo-mismatch check

After filling the Remote field, cross-check the location label against the JD body for any binding attendance requirement (e.g. "must be able to commute", "on-site required", "relocation required"). If the location field says remote but the JD body contains a binding attendance requirement:

> ⚠️ **Geo-mismatch:** location field says remote, but JD body says {exact quoted phrase}. Treat as on-site/hybrid until confirmed otherwise.

silence is absence of signal, not agreement — a JD that does not mention attendance is not equivalent to "remote confirmed".

## Block B — Match with CV

Read cv.md. Create a table with each JD requirement mapped to exact lines in the CV.

**Gaps** section: list any gaps with mitigation strategy for each.

## Block C — Level and Strategy

1. Level detected in the JD vs the candidate's experience
2. "Sell senior without lying" plan: specific phrases adapted to the role
3. "If they downlevel me" plan

## Block D — Comp and Demand

**Company type classification (required):** classify the hiring entity using the taxonomy in `modes/_shared.md`. Use the actual contract / hiring entity. Common types: Public company, Late-stage startup, Growth-stage startup / VC-backed startup, Early-stage startup / pre-revenue startup, PE-backed, Non-profit, Open-source community / education community, Government, Agency/Consulting. If uncertain, default compensation reliability to the conservative canonical tier: `Low`.

**Compensation reliability (required):**

If no advertised number exists, collapse this section to exactly two concise lines: company type and reliability tier. skip component split, detailed market rows, and HR verification questions.

When a salary figure exists, report all components:

- **Advertised (JD):** the salary shown verbatim in the JD (pin the exact figure or range; write to `advertised_comp` in the report header)
- **Advertised range:** the salary shown in the JD
- **Likely guaranteed base:** conservative estimate
- **Variable / conditional cash components:** bonuses, commissions, equity tranches
- **Expected stable cash:** guaranteed base + reliable cash only
- **Non-cash benefits:** healthcare, PTO, equity upside, etc.
- **Market comparison:** Is this competitive for the role/location?
- **Compensation reliability:** High / Medium / Low / Unknown

**Required HR verification questions when a salary figure exists:** include 3-6 questions the candidate should ask to verify the figures.

Do not present advertised compensation as real take-home pay. Label all figures as advertised/unverified until confirmed by a written offer.

If the candidate asks you to record a confirmed actual figure, append a row to `data/salary-observations.tsv`.

## Block E — Red Flags

List any concerns:
- Salary below market
- Location/cost-of-living mismatch
- Role scope concerns
- Company stability signals
- Other warnings

## Block F — Global Score

Average of the above dimensions. Give the final 1-5 score and a recommendation.

## Block G — Posting Legitimacy

Assess the legitimacy of the posting:

| Signal | Assessment |
|--------|-----------|
| Company verifiable | Yes / No |
| Posting source | Direct / Aggregator / Unknown |
| Contact info | Present / Absent |
| Role specificity | High / Medium / Low |
| Red flags | List any legitimacy concerns |

**Tier:** High Confidence / Proceed with Caution / Suspicious

## Score Summary

At the very end, output this exact block:

---SCORE_SUMMARY---
COMPANY: <company name>
ROLE: <role title>
SCORE: <global score as decimal>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---