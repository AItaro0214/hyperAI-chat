/* Every registered key must have its own connection test.
 *
 * The bug this guards: the handler fell through to Groq for anything it had no
 * branch for, so a valid RunPod key was reported as "401 Invalid API Key". */
import { readFileSync } from 'node:fs';
import { SECRET_KEYS } from '../src/lib/store.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const src = readFileSync('src/routes/admin.js', 'utf8');

for (const key of SECRET_KEYS) {
  check('  ' + key + ' に専用のテストがある', src.includes('async ' + key + '('), key);
}

// The shape of the old bug: a bare else that sent everything to one provider.
const handler = src.slice(src.indexOf("admin.post('/secrets/test'"));
check('未知のキーを他プロバイダで試さない', handler.includes('接続テストがありません'), '推測せず言う');
check('  Groq へのフォールバックが残っていない', !/else[\s\S]{0,80}GROQ_BASE/.test(handler));

check('RunPod はエンドポイント一覧で検証', src.includes('rest.runpod.io/v1/endpoints'));
check('  401 に対処法を添える', src.includes('Read/Write'), 'キー作り直しの案内');

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
