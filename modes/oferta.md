# Mode: job — Full A-G Evaluation (CPU-optimized)

When given a job description, deliver the 6 blocks (A-F evaluation).

## Block A — Role Summary

Table with:
- Archetype detected
- Domain (rooms/F&B/general management/task force)
- Function (operations/management/leadership)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (if mentioned)
- TL;DR in 1 sentence

## Block B — Match with CV

Read cv.md. Create a table with each JD requirement mapped to exact lines in the CV.

**Gaps** section: list any gaps with mitigation strategy for each.

## Block C — Level and Strategy

1. Level detected in the JD vs the candidate's experience
2. "Sell senior without lying" plan: specific phrases adapted to the role
3. "If they downlevel me" plan

## Block D — Comp and Demand

Analyze the advertised salary. Report:
- **Advertised range:** the salary shown in the JD
- **Likely guaranteed base:** conservative estimate
- **Market comparison:** Is this competitive for the role/location?
- **Compensation reliability:** High / Medium / Low / Unknown

## Block E — Red Flags

List any concerns:
- Salary below market
- Location/cost-of-living mismatch
- Role scope concerns
- Company stability signals
- Other warnings

## Block F — Global Score

Average of the above dimensions. Give the final 1-5 score and a recommendation.

## Score Summary

At the very end, output this exact block:

---SCORE_SUMMARY---
COMPANY: <company name>
ROLE: <role title>
SCORE: <global score as decimal>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---