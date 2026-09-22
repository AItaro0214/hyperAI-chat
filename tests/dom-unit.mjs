/* Duplicate element ids are silent: $() returns the first match, so the second
 * element simply never gets its listener. That is how the "有効化する" button
 * came to do nothing — id="bt-on" was already a checkbox above it. */
import { readFileSync } from 'node:fs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const src = readFileSync('public/app.js', 'utf8') + readFileSync('public/index.html', 'utf8');
const ids = [...src.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
const seen = new Map();
for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id);

check('id の重複がない', dup.length === 0, dup.join(', ') || String(ids.length) + ' 個を確認');

// Every listener target must exist somewhere, or the control is inert.
const targets = [...src.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)\??\.addEventListener/g)].map((m) => m[1]);
const missing = [...new Set(targets)].filter((t) => !seen.has(t));
check('リスナーの対象が実在する', missing.length === 0, missing.join(', ') || String(targets.length) + ' 箇所');

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
