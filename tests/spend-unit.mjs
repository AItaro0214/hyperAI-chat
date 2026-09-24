/* Settling costs against what OpenRouter billed. */
import { utcWindows, generationCost, keyUsage } from '../src/lib/generation.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};
const iso = (sec) => new Date(sec * 1000).toISOString();

/* ------------------------------- windows --------------------------------- */
// Thursday 2026-09-24 10:19 UTC.
const w = utcWindows(Date.UTC(2026, 8, 24, 10, 19) / 1000);
check('日は UTC 0時から', iso(w.day) === '2026-09-24T00:00:00.000Z', iso(w.day));
check('週は月曜から', iso(w.week) === '2026-09-21T00:00:00.000Z', iso(w.week));
check('月は1日から', iso(w.month) === '2026-09-01T00:00:00.000Z', iso(w.month));
const sunday = utcWindows(Date.UTC(2026, 8, 27, 23, 59) / 1000);
check('日曜は前の月曜の週', iso(sunday.week) === '2026-09-21T00:00:00.000Z', iso(sunday.week));
const monday = utcWindows(Date.UTC(2026, 8, 28, 0, 0) / 1000);
check('月曜0時で週が替わる', iso(monday.week) === '2026-09-28T00:00:00.000Z', iso(monday.week));

/* --------------------------- generation lookup --------------------------- */
const real = globalThis.fetch;
let calls = 0;
// Not settled on the first two looks, as observed for TTS.
globalThis.fetch = async () => {
  calls++;
  if (calls < 3) return { ok: true, json: async () => ({ data: { total_cost: 0 } }) };
  return { ok: true, json: async () => ({ data: { total_cost: 0.000353 } }) };
};
const settled = await generationCost('k', 'gen-tts-1', { tries: 5, delayMs: 1 });
check('確定するまで待って実額を返す', settled === 0.000353 && calls === 3, settled + ' after ' + calls);

calls = 0;
// Server-tool chats keep reporting 0: give up rather than record a false $0.
globalThis.fetch = async () => {
  calls++;
  return { ok: true, json: async () => ({ data: { total_cost: 0 } }) };
};
const never = await generationCost('k', 'gen-1', { tries: 3, delayMs: 1 });
check('0 のままなら null（$0 と記録しない）', never === null && calls === 3);
check('id が無ければ問い合わせない', (await generationCost('k', null)) === null);

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ data: { usage: 0.2691, usage_daily: 0.0859, usage_weekly: 0.2691, usage_monthly: 0.2691, limit: 10, limit_remaining: 9.73 } }),
});
const u = await keyUsage('k');
check('キーの使用額を読む', u.total === 0.2691 && u.day === 0.0859 && u.remaining === 9.73, JSON.stringify(u));
globalThis.fetch = real;

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
