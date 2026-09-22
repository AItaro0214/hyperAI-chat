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
check('4つの方式を持つ', BACKENDS.join(',') === 'ollama,searxng,brave,xai', BACKENDS.join(','));
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

void realGet;
const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
