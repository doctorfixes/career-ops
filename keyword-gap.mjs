#!/usr/bin/env node

/**
 * keyword-gap.mjs — per-JD ATS keyword-gap report.
 *
 * The Jobscan/Rezi "you're missing these keywords" artifact, done locally and
 * free. Compares a single job description against your CV corpus and reports:
 *   - canonical SKILLS present vs missing (reuses the upskill.mjs tokenizer, so
 *     the vocabulary matches the rest of the system), and
 *   - notable JD KEYWORDS (frequency-ranked terms) not found in your CV.
 *
 * It is an ANALYSIS tool, not a content generator. It tells you where the gaps
 * are; it never rewrites your CV. Per the project rule, a missing keyword is a
 * prompt to reformulate real experience you already have — never to fabricate.
 *
 * Usage:
 *   node keyword-gap.mjs <jd-file>                 # human summary
 *   node keyword-gap.mjs --file jds/acme.md --json
 *   cat jd.txt | node keyword-gap.mjs --stdin
 *   node keyword-gap.mjs jd.txt --cv cv.md --markdown   # report-ready block
 *
 * Flags: --file <path>  --stdin  --cv <path>  --top N  --json  --markdown
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractSkills } from './upskill.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CV corpus: cv.md is canonical; article-digest.md + profile add proof-point
// vocabulary. All are user-layer source-of-truth files (DATA_CONTRACT.md).
const CV_SOURCES = ['cv.md', 'article-digest.md', 'config/profile.yml'];

// Small stopword set for the frequency-ranked keyword layer. Deliberately not
// exhaustive — the skill layer is the precise one; this catches domain terms.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'our', 'are', 'with', 'this', 'that', 'will',
  'have', 'has', 'from', 'they', 'their', 'them', 'was', 'were', 'been', 'being',
  'who', 'what', 'when', 'where', 'which', 'while', 'into', 'over', 'under', 'about',
  'work', 'working', 'role', 'team', 'teams', 'company', 'candidate', 'candidates',
  'experience', 'experienced', 'years', 'year', 'skills', 'ability', 'able', 'strong',
  'excellent', 'good', 'great', 'help', 'helping', 'join', 'looking', 'seeking',
  'responsibilities', 'requirements', 'qualifications', 'preferred', 'plus', 'nice',
  'including', 'include', 'includes', 'across', 'within', 'per', 'via', 'etc', 'such',
  'must', 'should', 'would', 'could', 'also', 'well', 'other', 'others', 'more', 'most',
  'new', 'using', 'use', 'used', 'build', 'building', 'develop', 'developing', 'ensure',
  'position', 'job', 'opportunity', 'apply', 'applicants', 'employer', 'benefits',
  'we', 'us', 'is', 'to', 'of', 'in', 'on', 'as', 'at', 'be', 'by', 'or', 'an', 'a', 'it',
  'not', 'all', 'can', 'may', 'one', 'two', 'three', 'day', 'days', 'week', 'month',
]);

// ---------------------------------------------------------------------------
// Core analysis (pure)
// ---------------------------------------------------------------------------

/**
 * Frequency-ranked notable keywords from free text, minus stopwords.
 * @param {string} text
 * @param {{min?:number, top?:number}} [opts]
 * @returns {Array<{term:string, count:number}>}
 */
export function extractKeywords(text, { min = 3, top = 25 } = {}) {
  const counts = new Map();
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) || [];
  for (let w of words) {
    w = w.replace(/^[.-]+|[.-]+$/g, ''); // trim stray punctuation
    if (w.length < min) continue;
    if (STOPWORDS.has(w)) continue;
    if (/^\d/.test(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, top);
}

/** Does the CV text contain this keyword as a whole word? */
export function cvHasKeyword(cvLower, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(cvLower);
}

/**
 * Compare JD skills/keywords against the CV corpus.
 * @param {string} jdText
 * @param {string} cvText
 * @param {{top?:number}} [opts]
 */
export function analyze(jdText, cvText, { top = 25 } = {}) {
  const jdSkills = [...extractSkills(jdText)].sort();
  const cvSkills = extractSkills(cvText); // a Set
  const presentSkills = jdSkills.filter(s => cvSkills.has(s));
  const missingSkills = jdSkills.filter(s => !cvSkills.has(s));

  const cvLower = String(cvText || '').toLowerCase();
  const jdKeywords = extractKeywords(jdText, { top });
  const missingKeywords = jdKeywords
    .filter(k => !cvHasKeyword(cvLower, k.term))
    // drop keywords already surfaced by the (more precise) skill layer
    .filter(k => !missingSkills.some(s => s.toLowerCase() === k.term))
    .filter(k => !presentSkills.some(s => s.toLowerCase() === k.term));

  const coverage = jdSkills.length === 0
    ? null
    : Math.round((presentSkills.length / jdSkills.length) * 100);

  return {
    coverage_pct: coverage,
    skills_total: jdSkills.length,
    present_skills: presentSkills,
    missing_skills: missingSkills,
    missing_keywords: missingKeywords.map(k => k.term),
  };
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

function coverageBadge(pct) {
  if (pct == null) return 'n/a';
  if (pct >= 75) return `${pct}% ✅ strong`;
  if (pct >= 50) return `${pct}% ⚠️ partial`;
  return `${pct}% ❌ weak`;
}

export function formatHuman(r) {
  const L = [];
  L.push(`ATS keyword-gap  —  skill coverage: ${coverageBadge(r.coverage_pct)}  (${r.present_skills.length}/${r.skills_total} JD skills matched)`);
  L.push('');
  L.push(`Present skills (${r.present_skills.length}): ${r.present_skills.join(', ') || '—'}`);
  L.push('');
  L.push(`MISSING skills (${r.missing_skills.length}): ${r.missing_skills.join(', ') || '—'}`);
  if (r.missing_keywords.length) {
    L.push('');
    L.push(`Other JD terms not in your CV: ${r.missing_keywords.slice(0, 15).join(', ')}`);
  }
  L.push('');
  L.push('Reformulate real experience to surface the missing terms — never add a skill you do not have.');
  return L.join('\n');
}

export function formatMarkdown(r) {
  const L = [];
  L.push('### ATS Keyword Gap');
  L.push('');
  L.push(`- **Skill coverage:** ${coverageBadge(r.coverage_pct)} (${r.present_skills.length}/${r.skills_total})`);
  L.push(`- **Present:** ${r.present_skills.join(', ') || '—'}`);
  L.push(`- **Missing (skills):** ${r.missing_skills.join(', ') || '—'}`);
  if (r.missing_keywords.length) L.push(`- **Missing (other terms):** ${r.missing_keywords.slice(0, 15).join(', ')}`);
  L.push('');
  L.push('> Reformulate real experience to cover the gaps; do not fabricate.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { file: null, stdin: false, cv: null, top: 25, json: false, markdown: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a === '--file' || a.startsWith('--file=')) out.file = val();
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--cv' || a.startsWith('--cv=')) out.cv = val();
    else if (a === '--top' || a.startsWith('--top=')) out.top = parseInt(val(), 10) || 25;
    else if (a === '--json') out.json = true;
    else if (a === '--markdown' || a === '--md') out.markdown = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (!out.file && positional.length) out.file = positional[0];
  return out;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
}

function loadCvCorpus(explicitCv) {
  const sources = explicitCv ? [explicitCv] : CV_SOURCES;
  const parts = [];
  for (const s of sources) {
    const p = path.isAbsolute(s) ? s : path.join(__dirname, s);
    if (fs.existsSync(p)) {
      try { parts.push(fs.readFileSync(p, 'utf-8')); } catch { /* skip */ }
    }
  }
  return parts.join('\n\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let jdText = '';
  if (opts.stdin) jdText = readStdin();
  else if (opts.file) {
    const p = path.isAbsolute(opts.file) ? opts.file : path.join(__dirname, opts.file);
    if (!fs.existsSync(p)) { console.error(`keyword-gap: JD file not found: ${opts.file}`); return 1; }
    jdText = fs.readFileSync(p, 'utf-8');
  } else {
    console.error('Usage: node keyword-gap.mjs <jd-file>   (or --stdin, --file <path>)');
    return 1;
  }
  if (!jdText.trim()) { console.error('keyword-gap: empty job description.'); return 1; }

  const cvText = loadCvCorpus(opts.cv);
  if (!cvText.trim()) console.error('keyword-gap: warning — no CV corpus found (cv.md etc.); everything will read as missing.');

  const result = analyze(jdText, cvText, { top: opts.top });

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else if (opts.markdown) console.log(formatMarkdown(result));
  else console.log(formatHuman(result));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
