import { filterRows, listModels, KINDS } from '../src/lib/catalogues.js';
import { TOOLS } from '../src/lib/agent.js';
import { SKILLS, SKILL_IDS, renderSkill } from '../src/lib/skills.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

/* ------------------------------ filtering ------------------------------- */
const rows = [
  { id: 'google/gemini-3.8-flash-image', note: '参照画像可' },
  { id: 'google/gemini-3.1-flash-lite-image', note: '一括4枚' },
  { id: 'recraft/recraft-v4.1-vector', note: 'SVG可・一括6枚' },
  { id: 'deepgram/flux-tts:free', note: '無料' },
];

check('絞り込みなしは全件', filterRows(rows, '').length === 4);
check('  null でも全件', filterRows(rows, null).length === 4);
check('id で絞る', filterRows(rows, 'recraft').length === 1);
check('備考でも絞れる', filterRows(rows, 'SVG').map((r) => r.id).join() === 'recraft/recraft-v4.1-vector');
check('  日本語の備考も', filterRows(rows, '無料').length === 1);
check('大文字小文字を無視', filterRows(rows, 'GEMINI').length === 2);
check('区切り文字を無視', filterRows(rows, 'gemini3.8').length === 1, '「3.8」と「3-8」を同一視');
check('語は全部含む必要がある', filterRows(rows, 'gemini flash').length === 2);
check('  絞り込みは広がらない', filterRows(rows, 'gemini recraft').length === 0);
check('一致しなければ空', filterRows(rows, 'ないもの').length === 0);

/* ------------------------------ listing --------------------------------- */
// A stand-in catalogue, so the shape is checked without a network call.
const fakeEnv = (ids) => ({
  KV: {
    async get() {
      return { at: Date.now(), data: ids.map((id) => ({ id, maxN: 1, outputFormats: [], maxReferences: 0 })) };
    },
    async put() {},
  },
});

const env = fakeEnv(['a/one-1', 'a/two-2', 'a/three-3']);
const all = await listModels(env, 'image', {});
check('件数と本文を返す', all.total === 3 && all.text.includes('a/one-1'), all.text.split('\n')[0]);
check('  kind を返す', all.kind === 'image');

const capped = await listModels(env, 'image', { limit: 2 });
check('limit で切る', capped.shown === 2, String(capped.shown));
check('  切ったと伝える', capped.text.includes('limit で増やせます'));

const one = await listModels(env, 'image', { query: 'two' });
check('絞り込みが効く', one.shown === 1 && one.text.includes('a/two-2'));

// A dead end should hand back alternatives rather than just "no results".
const none = await listModels(env, 'image', { query: 'ないもの' });
check('不一致でも候補を見せる', none.shown === 0 && none.text.includes('a/one-1'), '行き止まりにしない');
check('  全体件数を伝える', none.text.includes('全3件'));

let threw = '';
try {
  await listModels(env, 'bogus', {});
} catch (e) {
  threw = e.message;
}
check('未知の kind は理由を返す', threw.includes('image') && threw.includes('bogus'), threw);
check('kind が揃っている', KINDS.join(',') === 'image,video,speech,chat,xai', KINDS.join(','));

/* ------------------------------- wiring --------------------------------- */
const tool = TOOLS.find((t) => t.function.name === 'list_models');
check('list_models ツールがある', !!tool);
check('  kind が必須', tool.function.parameters.required.join(',') === 'kind');
check('  kind の候補が実装と一致', tool.function.parameters.properties.kind.enum.join(',') === KINDS.join(','));
check('  推測で書くなと 明記されている', tool.function.description.includes('推測'));

/* ---------------------- skills carry no model ids ----------------------- */
for (const id of SKILL_IDS) {
  const text = renderSkill({}, id);
  // A provider/model slug with a digit in it is what goes stale.
  check('  ' + id + ' はIDを焼き込んでいない', !/[a-z-]+\/[a-z0-9.-]*\d/.test(SKILLS[id].guide));
  if (SKILLS[id].models) check('  ' + id + ' は list_models を案内する', text.includes('list_models'));
}
const total = SKILL_IDS.reduce((n, id) => n + renderSkill({}, id).length, 0);
check('スキル全体が軽くなった', total < 5000, total + '文字（以前 9438）');

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
