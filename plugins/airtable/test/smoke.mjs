// Zero-network smoke test for the airtable plugin: the entry imports cleanly,
// every declared manifest hook is a function, and the pure field mapping is
// correct. Run: node plugins/airtable/test/smoke.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const KINDS = ['provider', 'ingest', 'search', 'notify', 'export'];

const manifest = JSON.parse(readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));
const mod = await import(path.join(here, '..', manifest.entry || 'index.mjs'));
const hooks = mod.default;

assert(hooks && typeof hooks === 'object', 'default export must be an object of hooks');
for (const h of manifest.hooks) {
  assert(KINDS.includes(h), `manifest declares unknown hook "${h}"`);
  assert(typeof hooks[h] === 'function', `index.mjs must export a "${h}" function`);
}

// Pure field mapping — exercises the real templates/states.yml status canon.
// Both helpers ride the default export (parseScore is not a named export).
const { fieldsForRow, parseScore } = hooks;
assert.strictEqual(parseScore('4.2/5'), 4.2, 'parseScore keeps 4.2/5 → 4.2');
assert(Number.isNaN(parseScore('n/a')), 'parseScore returns NaN for junk');

const f = fieldsForRow({ company: 'Acme', role: 'Engineer', status: 'Applied', score: '4.2/5' });
assert.deepStrictEqual(f, { Company: 'Acme', Role: 'Engineer', Status: 'Applied', Score: 4.2 }, 'fieldsForRow maps a full row');

assert.strictEqual(fieldsForRow({ company: '', role: 'Engineer' }), null, 'row without company is skipped');
assert.strictEqual(fieldsForRow({ company: 'Acme', role: '' }), null, 'row without role is skipped');

const noScore = fieldsForRow({ company: 'Acme', role: 'Eng', status: 'Applied', score: '' });
assert(!('Score' in noScore), 'missing score omits the Score field');

console.log('✓ airtable smoke ok:', manifest.hooks.join(', '));
