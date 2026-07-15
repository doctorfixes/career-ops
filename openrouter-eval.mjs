#!/usr/bin/env node
/**
 * openrouter-eval.mjs — OpenRouter-powered Job Offer Evaluator
 *
 * Uses the same mode files as ollama-eval.mjs but sends requests
 * through OpenRouter API instead of local Ollama.
 *
 * Usage:
 *   node openrouter-eval.mjs --file ./jds/my-job.txt
 *   node openrouter-eval.mjs --model openai/gpt-4o --file ./jds/my-job.txt
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const { config } = await import('dotenv');
  config();
} catch {}

const PATHS = {
  shared:  join(ROOT, 'modes', '_shared.md'),
  oferta:  join(ROOT, 'modes', 'oferta.md'),
  cv:      join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
};

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`OpenRouter Eval — Usage: node openrouter-eval.mjs --file <jd-file>`);
  process.exit(0);
}

let jdText = '';
let modelName = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
let saveReport = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) { console.error(`❌ File not found: ${filePath}`); process.exit(1); }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) { console.error('❌ No JD provided.'); process.exit(1); }

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error('❌ OPENROUTER_API_KEY not set in .env'); process.exit(1); }

// Load context
const sharedContext = existsSync(PATHS.shared) ? readFileSync(PATHS.shared, 'utf-8').trim() : '[shared not found]';
const ofertaLogic   = existsSync(PATHS.oferta) ? readFileSync(PATHS.oferta, 'utf-8').trim() : '[oferta not found]';
const cvContent     = existsSync(PATHS.cv) ? readFileSync(PATHS.cv, 'utf-8').trim() : '[cv not found]';

const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - Block D (Comp research): use training-data salary estimates; note them as estimates.
   - Block G (Legitimacy): analyze JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through F in full.
3. At the very end, output this exact machine-readable block:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

console.log(`🤖  Calling OpenRouter (${modelName})...\n`);

let evaluationText;
try {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://career-ops.local',
      'X-Title': 'career-ops',
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
      ],
      temperature: 0.4,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ OpenRouter API error: HTTP ${res.status}`);
    console.error(`   ${body.slice(0, 500)}`);
    process.exit(1);
  }

  const data = await res.json();
  evaluationText = data.choices?.[0]?.message?.content?.trim();
  if (!evaluationText) { console.error('❌ Empty response.'); process.exit(1); }
} catch (err) {
  console.error(`❌ API call failed: ${err.message}`);
  process.exit(1);
}

// Display
console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by OpenRouter (' + modelName + ')');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// Parse score summary
const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
let company = 'unknown', role = 'unknown', score = '?', archetype = 'unknown', legitimacy = 'unknown';

if (summaryMatch) {
  const extract = (key) => {
    const m = summaryMatch[1].match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };
  company = extract('COMPANY');
  role = extract('ROLE');
  score = extract('SCORE');
  archetype = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// Save report
if (saveReport) {
  if (!existsSync(PATHS.reports)) mkdirSync(PATHS.reports, { recursive: true });
  const num = (() => {
    if (!existsSync(PATHS.reports)) return '001';
    const files = readdirSync(PATHS.reports).map(f => { const m = f.match(/^(\d+)-/); return m ? parseInt(m[1], 10) : NaN; }).filter(n => !isNaN(n));
    return files.length === 0 ? '001' : String(Math.max(...files) + 1).padStart(3, '0');
  })();
  const today = new Date().toISOString().split('T')[0];
  const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = `${num}-${companySlug}-${today}.md`;
  const reportPath = join(PATHS.reports, filename);
  const reportContent = `# Evaluation: ${company} — ${role}\n\n**Date:** ${today}\n**Archetype:** ${archetype}\n**Score:** ${score}/5\n**Legitimacy:** ${legitimacy}\n**Tool:** OpenRouter (${modelName})\n\n---\n\n${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}\n`;
  writeFileSync(reportPath, reportContent, 'utf-8');
  console.log(`\n✅ Report saved: reports/${filename}`);
  console.log(`\n📊  Tracker: ${num} | ${today} | ${company} | ${role} | ${score}/5 | Evaluated`);
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');