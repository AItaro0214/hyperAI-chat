import { webSearch, webFetch, formatResults, stripHtml, BACKENDS, BACKEND_NOTES } from '../src/lib/search.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const realFetch = globalThis.fetch;
const env = (secrets = {}, settings = {}) => ({
  DB: {
    prepare(sql) {
      return {
        bind(key) {
          return {
            async first() {
              if (sql.includes('app_secrets')) return secrets[key] ? { value_enc: 'enc:' + secrets[key] } : null;
              return settings[key] ? { value: JSON.stringify(settings[key]) } : null;
            },
          };
        },
      };
    },
  },
  // getApiKey unseals with MASTER_KEY; the fake ciphertext is just prefixed.
  MASTER_KEY: null,
});

/* ------------------------------- backends ------------------------------- */
check('5つの方式を持つ', BACKENDS.join(',') === 'ollama,searxng,brave,exa,xai', BACKENDS.join(','));
check('exa はキーと料金を説明する', /EXA_API_KEY/.test(BACKEND_NOTES.exa) && /\$0\.007/.test(BACKEND_NOTES.exa) && /\$0\.001/.test(BACKEND_NOTES.exa), BACKEND_NOTES.exa);
check('xai は要約だと明記', BACKEND_NOTES.xai.includes('要約'), BACKEND_NOTES.xai);
check('searxng は第三者なしと明記', BACKEND_NOTES.searxng.includes('第三者'), BACKEND_NOTES.searxng);

let threw = '';
try {
  await webSearch(env(), { query: 'x', backend: 'magic' });
} catch (e) {
  threw = e.message;
}
check('未知の方式を弾く', threw.includes('ollama'), threw);

threw = '';
try {
  await webSearch(env(), { query: '   ', backend: 'ollama' });
} catch (e) {
  threw = e.message;
}
check('空の検索語を弾く', threw.includes('空'), threw);

/* -------------------------- Ollama の形状に従う -------------------------- */
// Documented shape: { results: [{ title, url, content }] }
let seen = null;
globalThis.fetch = async (url, options) => {
  seen = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        results: [
          { title: 'A', url: 'https://a.example', content: '  本文が   空白まみれ  ' },
          { title: 'B', url: 'https://b.example', content: 'x'.repeat(3000) },
        ],
      };
    },
    async text() {
      return '';
    },
  };
};

// getApiKey needs a key present; stub the module boundary instead of D1.
const store = await import('../src/lib/store.js');
const realGet = store.getApiKey;

const out = await webSearch({ ...env(), __key: 'k' }, { query: 'テスト', maxResults: 3, backend: 'ollama' }).catch((e) => e);
check('キーがなければ理由を返す', out instanceof Error && out.message.includes('OLLAMA_API_KEY'), String(out.message || out));

globalThis.fetch = realFetch;

/* ------------------------------ formatting ------------------------------ */
const fmt = formatResults({
  backend: 'ollama',
  results: [
    { title: 'タイトル', url: 'https://example.com/a', snippet: '概要' },
    { title: '', url: 'https://example.com/b', snippet: '' },
  ],
});
check('リンクを残して整形する', fmt.includes('https://example.com/a'), '要約せず生のまま渡す');
check('  件数と方式を書く', fmt.includes('ollama') && fmt.includes('2件'));
check('  無題も壊れない', fmt.includes('(無題)'));
check('  生の結果だと注意書きする', fmt.includes('生の結果'), '内容を保証しないことを明示');
check('空なら空と言う', formatResults({ backend: 'ollama', results: [] }).includes('ありませんでした'));

/* ------------------------------- stripHtml ------------------------------ */
const html = `
<html><head><title>記事</title><style>body{color:red}</style></head>
<body><script>evil()</script><h1>見出し</h1><p>本文です。</p>
<p>&amp; &lt;tag&gt; &quot;引用&quot;</p></body></html>`;
const text = stripHtml(html);
check('スクリプトを落とす', !text.includes('evil'), text.slice(0, 40));
check('  スタイルも落とす', !text.includes('color:red'));
check('  本文は残す', text.includes('見出し') && text.includes('本文です'));
check('  実体参照を戻す', text.includes('&') && text.includes('<tag>') && text.includes('"引用"'), text.slice(-30));
check('  空白を詰める', !/ {3}/.test(text));
check('上限で切る', stripHtml('<p>' + 'x'.repeat(60000) + '</p>').length <= 40000);

/* -------------------------------- fetch --------------------------------- */
threw = '';
try {
  await webFetch(env(), { url: 'ftp://example.com' });
} catch (e) {
  threw = e.message;
}
check('http(s) 以外を弾く', threw.includes('http'), threw);

/* --------------------------------- Exa ---------------------------------- */
// The key comes from the plain Worker secret of the same name (getApiKey's
// fallback), so no sealed row is needed.
const exaEnv = { ...env(), EXA_API_KEY: 'exa_k' };
const exaCalls = [];
const fakeExa = (respond) => {
  exaCalls.length = 0;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), headers: options.headers, body: options.body ? JSON.parse(options.body) : null };
    exaCalls.push(call);
    const { status = 200, json = {}, text = '' } = respond(call);
    return { ok: status < 400, status, json: async () => json, text: async () => text || JSON.stringify(json) };
  };
};

// Documented shape: { results: [{ title, url, text, ... }], costDollars }
fakeExa(({ body }) => ({
  json: {
    results: Array.from({ length: body.numResults + 3 }, (_, i) => ({
      title: 'T' + i,
      url: 'https://e' + i + '.example',
      text: '  本文  ' + 'y'.repeat(5000),
    })),
    costDollars: { total: 0.007 },
  },
}));
const ex = await webSearch(exaEnv, { query: '量子', maxResults: 50, backend: 'exa' });
const sent = exaCalls[0];
check('Exa: /search に送る', sent.url === 'https://api.exa.ai/search', sent.url);
check('  キーは x-api-key', sent.headers['x-api-key'] === 'exa_k');
check('  10 件を超えて頼まない（超過料金なし）', sent.body.numResults === 10, String(sent.body.numResults));
check('  返す件数も 10 件まで', ex.results.length === 10, String(ex.results.length));
check('  深い検索ではない', sent.body.type === 'auto', sent.body.type);
const c = sent.body.contents || {};
check('  抜粋は本文の先頭だけ', c.text?.maxCharacters === 1200, JSON.stringify(c.text));
// The LLM-driven parts are never asked for.
check('  highlights・summary を頼まない', !('highlights' in c) && !('summary' in c), Object.keys(c).join(','));
check('  要約・出力生成の指定がない', !('outputSchema' in sent.body) && !('systemPrompt' in sent.body) && !('stream' in sent.body));
check('  抜粋を詰めて 1200 字まで', ex.results[0].snippet.startsWith('本文 y') && ex.results[0].snippet.length <= 1200, String(ex.results[0].snippet.length));
check('  タイトルと URL を残す', ex.results[0].title === 'T0' && ex.results[0].url === 'https://e0.example');
check('  方式名を返す', ex.backend === 'exa' && formatResults(ex).includes('exa・10件'));

// A page: only when the model asks, through /contents, and only with exa.
fakeExa(() => ({
  json: {
    results: [{ title: '記事', url: 'https://page.example/a', text: '全文'.repeat(30000) }],
    statuses: [{ id: 'https://page.example/a', status: 'success', source: 'cached' }],
    costDollars: { total: 0.001 },
  },
}));
const page = await webFetch(exaEnv, { url: 'https://page.example/a', backend: 'exa' });
const pc = exaCalls[0];
check('Exa: ページは /contents で読む', pc.url === 'https://api.exa.ai/contents' && exaCalls.length === 1, pc.url);
check('  URL は 1 件だけ', JSON.stringify(pc.body.urls) === '["https://page.example/a"]');
check('  本文だけを頼む', Object.keys(pc.body).sort().join(',') === 'text,urls' && pc.body.text.maxCharacters === 40000, JSON.stringify(pc.body));
check('  本文を返す（上限で切る）', page.title === '記事' && page.content.startsWith('全文') && page.content.length <= 40000, String(page.content.length));

// Other backends keep reading pages as before, never through Exa.
fakeExa(({ url }) => (url.startsWith('https://api.exa.ai') ? { status: 500 } : { text: '<title>直</title><p>直接</p>' }));
const direct = await webFetch(exaEnv, { url: 'https://page.example/b', backend: 'brave' });
check('exa 以外では Exa を使わない', !exaCalls.some((x) => x.url.startsWith('https://api.exa.ai')) && direct.content.includes('直接'), exaCalls.map((x) => x.url).join(' '));

// Errors, in words the reader and the model can act on.
const errorOf = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
fakeExa(() => ({ json: {} }));
let msg = await errorOf(() => webSearch(env(), { query: 'x', backend: 'exa' }));
check('キーなし: 理由を言う', msg === 'EXA_API_KEY が未設定です' && exaCalls.length === 0, msg);
fakeExa(() => ({ status: 402, text: '{"error":"out of credits"}' }));
msg = await errorOf(() => webSearch(exaEnv, { query: 'x', backend: 'exa' }));
check('402: クレジット切れと言う', msg.includes('Exa /search 402') && msg.includes('クレジット'), msg);
fakeExa(() => ({ status: 401, text: 'unauthorized' }));
msg = await errorOf(() => webFetch(exaEnv, { url: 'https://p.example', backend: 'exa' }));
check('401: キーが無効と言う', msg.includes('Exa /contents 401') && msg.includes('無効'), msg);
fakeExa(() => ({
  json: { results: [], statuses: [{ id: 'https://down.example', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }] },
}));
msg = await errorOf(() => webFetch(exaEnv, { url: 'https://down.example', backend: 'exa' }));
check('読めないページ: 200 の中のエラーを拾う', msg.includes('取得できませんでした') && msg.includes('CRAWL_NOT_FOUND') && msg.includes('404'), msg);

globalThis.fetch = realFetch;

void realGet;
const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
