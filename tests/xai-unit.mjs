import {
  buildSearchRequest,
  parseSearchResponse,
  formatSearchResult,
  estimateSearchCost,
  DEFAULT_MODEL,
} from '../src/lib/xai.js';
import { SKILLS, SKILL_IDS, skillIndex } from '../src/lib/skills.js';
import { TOOLS } from '../src/lib/agent.js';
import { SECRET_KEYS } from '../src/lib/store.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

/* ---------------------------- request shape ----------------------------- */
const base = buildSearchRequest({ query: '  Cloudflare の障害報告  ' });
check('input を使う（messages ではない）', Array.isArray(base.input) && !base.messages);
check('  クエリは trim される', base.input[0].content === 'Cloudflare の障害報告');
check('  ロールは user', base.input[0].role === 'user');
check('x_search ツールを渡す', base.tools[0].type === 'x_search', JSON.stringify(base.tools));
check('既定モデルが入る', base.model === DEFAULT_MODEL, base.model);
check('未指定の項目は送らない', Object.keys(base.tools[0]).join(',') === 'type', Object.keys(base.tools[0]).join(','));

const dated = buildSearchRequest({ query: 'q', fromDate: '2026-01-01', toDate: '2026-09-01' });
check('日付を渡せる', dated.tools[0].from_date === '2026-01-01' && dated.tools[0].to_date === '2026-09-01');
const badDate = buildSearchRequest({ query: 'q', fromDate: '最近', toDate: '2026/09/01' });
check('不正な日付は落とす', !badDate.tools[0].from_date && !badDate.tools[0].to_date, JSON.stringify(badDate.tools[0]));

const handles = buildSearchRequest({ query: 'q', handles: ['@CloudflareDev', ' elonmusk '] });
check('@ を外す', handles.tools[0].allowed_x_handles.join(',') === 'CloudflareDev,elonmusk');
const csv = buildSearchRequest({ query: 'q', handles: 'a, b ,@c' });
check('カンマ区切りも受ける', csv.tools[0].allowed_x_handles.join(',') === 'a,b,c');
const many = buildSearchRequest({ query: 'q', handles: Array.from({ length: 30 }, (_, i) => 'u' + i) });
check('20件で切る', many.tools[0].allowed_x_handles.length === 20, String(many.tools[0].allowed_x_handles.length));

// Upstream rejects both lists at once, so allow wins and exclude is dropped.
const both = buildSearchRequest({ query: 'q', handles: ['a'], excludeHandles: ['b'] });
check('allow と exclude は排他', !!both.tools[0].allowed_x_handles && !both.tools[0].excluded_x_handles);
const onlyDeny = buildSearchRequest({ query: 'q', excludeHandles: ['b'] });
check('  exclude 単独は通る', onlyDeny.tools[0].excluded_x_handles.join(',') === 'b');

const media = buildSearchRequest({ query: 'q', images: true, videos: true, alsoWeb: true });
check('画像・動画理解を渡せる', media.tools[0].enable_image_understanding && media.tools[0].enable_video_understanding);
check('Web検索を併用できる', media.tools.some((t) => t.type === 'web_search'));
check('  既定ではオフ', !base.tools[0].enable_image_understanding && base.tools.length === 1);

/* --------------------------- response parsing ---------------------------- */
// The documented Responses API shape: a mixed output array with the answer in
// a message item and citations as annotations on the text part.
const canonical = {
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'x_search_call', id: 'call_1', status: 'completed' },
    {
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: '障害の報告が複数あります。',
          annotations: [
            { type: 'url_citation', url: 'https://x.com/a/status/1', title: 'A' },
            { type: 'url_citation', url: 'https://x.com/b/status/2', title: 'B' },
          ],
        },
      ],
    },
  ],
  usage: { total_tokens: 1234, num_sources_used: 7 },
};
const p1 = parseSearchResponse(canonical);
check('本文を取り出す', p1.text === '障害の報告が複数あります。', p1.text);
check('  引用を取り出す', p1.sources.length === 2, JSON.stringify(p1.sources));
check('  ツール呼び出し項目を本文に混ぜない', !p1.text.includes('call_1'));
check('  トークン数', p1.tokens === 1234);
check('  読んだ投稿数', p1.sourcesUsed === 7);

// The other shape seen in the wild: a top-level citations array of bare URLs.
const topLevel = {
  output: [{ type: 'message', content: [{ type: 'output_text', text: '本文' }] }],
  citations: ['https://x.com/c/status/3', { url: 'https://x.com/d/status/4', title: 'D' }],
};
const p2 = parseSearchResponse(topLevel);
check('トップレベルの citations も拾う', p2.sources.length === 2, JSON.stringify(p2.sources));
check('  文字列とオブジェクトが混在しても平気', p2.sources[1].title === 'D');

const dup = parseSearchResponse({
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'x', annotations: [{ url: 'https://x.com/same' }] }],
    },
  ],
  citations: ['https://x.com/same'],
});
check('重複した引用はまとめる', dup.sources.length === 1, String(dup.sources.length));

check('output_text の便宜フィールドに落ちる', parseSearchResponse({ output_text: 'ほんぶん' }).text === 'ほんぶん');
check('空でも例外にしない', parseSearchResponse({}).text === '' && parseSearchResponse(null).sources.length === 0);
check('未知の項目型を無視する', parseSearchResponse({ output: [{ type: 'なにか', text: 'ゴミ' }] }).text === '');

const multi = parseSearchResponse({
  output: [
    { type: 'message', content: [{ type: 'output_text', text: '一つ目' }] },
    { type: 'message', content: [{ type: 'output_text', text: '二つ目' }] },
  ],
});
check('複数メッセージを連結する', multi.text === '一つ目\n\n二つ目', JSON.stringify(multi.text));

/* ------------------------------ formatting ------------------------------- */
const formatted = formatSearchResult(p1);
check('引用元を本文の後に並べる', formatted.includes('## 参照した投稿') && formatted.includes('https://x.com/a/status/1'));
check('  引用ゼロなら見出しを出さない', !formatted.replace(/[\s\S]*参照した投稿/, '').includes('参照した投稿'));
check('  本文だけなら素通し', formatSearchResult({ text: 'のみ', sources: [] }) === 'のみ');

/* -------------------------------- costs ---------------------------------- */
check('投稿数で課金を見積もる', Math.abs(estimateSearchCost(7) - 0.035) < 1e-9, String(estimateSearchCost(7)));
check('  0件なら0', estimateSearchCost(0) === 0 && estimateSearchCost(undefined) === 0);

/* ------------------------------- wiring ---------------------------------- */
check('XAI_API_KEY が登録キーにある', SECRET_KEYS.includes('XAI_API_KEY'), SECRET_KEYS.join(','));
check('search_x ツールが定義されている', TOOLS.some((t) => t.function.name === 'search_x'));
const tool = TOOLS.find((t) => t.function.name === 'search_x');
check('  query が必須', tool.function.parameters.required.join(',') === 'query');
check('  ハンドル指定を受け付ける', !!tool.function.parameters.properties.handles);
check('xsearch スキルがある', SKILL_IDS.includes('xsearch'), SKILL_IDS.join(','));
check('  索引に出る', skillIndex().includes('xsearch'));
check('  ツール名がガイドに書いてある', SKILLS.xsearch.guide.includes('search_x'));
check('  キー未登録の注意がある', SKILLS.xsearch.guide.includes('XAI_API_KEY'));
check('  裏取りの注意がある', SKILLS.xsearch.guide.includes('事実として扱わないでください'));
check('  索引は小さいまま', skillIndex().length < 600, skillIndex().length + '文字');

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
