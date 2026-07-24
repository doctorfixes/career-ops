/**
 * keyword-gap.test.mjs — tests for the per-JD ATS keyword-gap analyzer.
 *
 * Run: node keyword-gap.test.mjs
 */

import {
  extractKeywords, cvHasKeyword, analyze, formatHuman, formatMarkdown, parseArgs,
} from './keyword-gap.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++; failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}
function ok(label, cond) { eq(label, Boolean(cond), true); }

// ── extractKeywords ─────────────────────────────────────────────────────────
const kw = extractKeywords('Kubernetes kubernetes orchestration orchestration orchestration the the the', { min: 3, top: 5 });
eq('keywords ranked by frequency', kw[0].term, 'orchestration');
ok('stopwords excluded', !kw.some(k => k.term === 'the'));
ok('respects min length', extractKeywords('go go go ml ml', { min: 3 }).length === 0);

// ── cvHasKeyword (whole-word) ───────────────────────────────────────────────
ok('cvHasKeyword whole word', cvHasKeyword('i use terraform daily', 'terraform'));
ok('cvHasKeyword not substring', !cvHasKeyword('scala developer', 'cala'));
ok('cvHasKeyword handles c++ style', cvHasKeyword('built in c++ and rust', 'c++'));

// ── analyze ─────────────────────────────────────────────────────────────────
const JD = `
We need a Senior Platform Engineer skilled in Kubernetes, Terraform, AWS, and Python.
Experience with GraphQL and observability (Prometheus) is a strong plus. You will
build CI/CD pipelines and orchestrate microservices.
`;
const CV = `
Platform engineer. Deep experience with Kubernetes and AWS. Built Python services and
CI/CD pipelines. Comfortable with Prometheus dashboards.
`;
const r = analyze(JD, CV);

ok('present skills include Kubernetes', r.present_skills.includes('Kubernetes'));
ok('present skills include AWS', r.present_skills.includes('AWS'));
ok('present skills include Python', r.present_skills.includes('Python'));
ok('missing skills include Terraform', r.missing_skills.includes('Terraform'));
ok('missing skills include GraphQL', r.missing_skills.includes('GraphQL'));
ok('coverage is a percentage', typeof r.coverage_pct === 'number' && r.coverage_pct > 0 && r.coverage_pct <= 100);
ok('a skill is never both present and missing',
  !r.present_skills.some(s => r.missing_skills.includes(s)));
ok('missing keywords do not duplicate missing skills (case-insensitive)',
  !r.missing_keywords.some(k => r.missing_skills.some(s => s.toLowerCase() === k)));

// empty CV → everything missing, 0% coverage
const empty = analyze(JD, '');
eq('empty CV coverage 0', empty.coverage_pct, 0);
eq('empty CV no present skills', empty.present_skills.length, 0);

// JD with no recognizable skills → coverage null (n/a), not a divide-by-zero
const noSkill = analyze('We value passion, curiosity, and teamwork.', CV);
eq('no JD skills → coverage null', noSkill.coverage_pct, null);

// ── formatters ──────────────────────────────────────────────────────────────
ok('formatHuman shows coverage', formatHuman(r).includes('skill coverage'));
ok('formatHuman warns against fabrication', /never add a skill you do not have/i.test(formatHuman(r)));
ok('formatMarkdown has heading', formatMarkdown(r).startsWith('### ATS Keyword Gap'));
ok('formatMarkdown warns against fabrication', /do not fabricate/i.test(formatMarkdown(r)));

// ── parseArgs ───────────────────────────────────────────────────────────────
eq('args positional jd file', parseArgs(['jds/acme.md']).file, 'jds/acme.md');
eq('args --file + --json', (() => { const o = parseArgs(['--file', 'x.md', '--json']); return [o.file, o.json]; })(), ['x.md', true]);
eq('args --cv + --top', (() => { const o = parseArgs(['jd.md', '--cv', 'cv.md', '--top', '10']); return [o.cv, o.top]; })(), ['cv.md', 10]);
eq('args --md alias', parseArgs(['jd.md', '--md']).markdown, true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('Failures:', failures.join(', ')); process.exit(1); }
