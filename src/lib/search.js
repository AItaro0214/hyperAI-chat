/* Web search for a self-hosted model.
 *
 * OpenRouter's server tools and its web plugin are OpenRouter features; a model
 * on a rented GPU has neither. So search has to be supplied, and *which* search
 * matters more here than it would elsewhere.
 *
 * The distinction is between raw results and an agentic answer. xAI's
 * web_search, Perplexity and Tavily all have a model of their own do the
 * reading and hand back a summary — which means someone else's judgement, and
 * someone else's refusals, sit in front of a model chosen for not having any.
 * The backends below return links and page text and nothing else; the reading
 * is left to the model that was asked.
 *
 * searxng is the only one with no third party in the path at all: it is the
 * user's own instance querying public engines. */

import { getApiKey, getJsonSetting } from './store.js';

export const BACKENDS = ['ollama', 'searxng', 'brave', 'xai'];

export const BACKEND_NOTES = {
  ollama: '生の検索結果（無料枠あり・OLLAMA_API_KEY が必要）',
  searxng: '自前の SearXNG。第三者が経路にいない',
  brave: '独立インデックス（BRAVE_API_KEY が必要）',
  xai: 'Grok が検索して要約を返す。仲介モデルの判断が入る',
};

const MAX_RESULTS = 10;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/* ------------------------------- backends ------------------------------- */

async function viaOllama(env, query, limit) {
  const key = await getApiKey(env, 'OLLAMA_API_KEY');
  if (!key) throw new Error('OLLAMA_API_KEY が未設定です');
  const res = await fetch('https://ollama.com/api/web_search', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, max_results: limit }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error('Ollama web_search ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  return (json.results || []).map((r) => ({ title: r.title, url: r.url, snippet: clip(r.content, 1200) }));
}

async function viaSearxng(env, query, limit) {
  const base = String((await getJsonSetting(env, 'searxngUrl', '')) || '').replace(/\/+$/, '');
  if (!base) throw new Error('SearXNG の URL が未設定です（管理コンソールで登録してください）');
  /* A localhost URL works from the local app and never from a Worker, which
   * has no route to the user's machine. Failing here with the reason beats a
   * connection error the caller cannot interpret. */
  if (!env.LOCAL && /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(base)) {
    throw new Error(
      'クラウド版から localhost の SearXNG には到達できません。公開URLを設定するか、検索方式を ollama / brave に変えてください。'
    );
  }
  // The JSON format has to be enabled in the instance's settings.yml.
  const url = base + '/search?format=json&language=auto&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) {
    throw new Error(
      'SearXNG ' + res.status + '（settings.yml の search.formats に json が入っているか確認してください）'
    );
  }
  const json = await res.json();
  return (json.results || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: clip(r.content, 1200),
  }));
}

async function viaBrave(env, query, limit) {
  const key = await getApiKey(env, 'BRAVE_API_KEY');
  if (!key) throw new Error('BRAVE_API_KEY が未設定です');
  const url = 'https://api.search.brave.com/res/v1/web/search?count=' + limit + '&q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error('Brave Search ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  return (json.web?.results || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: clip(r.description, 1200),
  }));
}

/* Kept as an option, but it answers rather than searches: the sources come
 * back attached to Grok's summary, not as a result list. */
async function viaXai(env, query) {
  const { xaiKey, searchWeb } = await import('./xai.js');
  const out = await searchWeb(await xaiKey(env), { query });
  return out.sources.map((s) => ({ title: s.title, url: s.url, snippet: '' })).concat(
    out.text ? [{ title: 'Grok の要約', url: '', snippet: clip(out.text, 4000) }] : []
  );
}

const IMPLS = { ollama: viaOllama, searxng: viaSearxng, brave: viaBrave, xai: viaXai };

/* -------------------------------- the API ------------------------------- */

/**
 * @returns {Promise<{backend: string, results: {title,url,snippet}[]}>}
 */
export async function webSearch(env, { query, maxResults = 5, backend = 'ollama' } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('検索語が空です');
  const impl = IMPLS[backend];
  if (!impl) throw new Error('backend は ' + BACKENDS.join(' / ') + ' のいずれかです');
  const limit = Math.max(1, Math.min(Number(maxResults) || 5, MAX_RESULTS));
  return { backend, results: await impl(env, q, limit) };
}

/** Reads one page. Only Ollama offers this; the rest need a plain fetch. */
export async function webFetch(env, { url } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('http(s) の URL を指定してください');

  const key = await getApiKey(env, 'OLLAMA_API_KEY');
  if (key) {
    const res = await fetch('https://ollama.com/api/web_fetch', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ url: target }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      const json = await res.json();
      return { title: json.title || target, content: clip(json.content, 40000), url: target };
    }
  }

  // Fallback: fetch it and strip the markup, which is enough for article text.
  const res = await fetch(target, {
    headers: { accept: 'text/html,text/plain', 'user-agent': 'Mozilla/5.0 (compatible; hyperAI)' },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error('取得できませんでした: HTTP ' + res.status);
  const html = await res.text();
  return { title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || target).trim(), content: stripHtml(html), url: target };
}

export function stripHtml(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 40000);
}

/** Results as a block the model can read, with the links kept intact. */
export function formatResults({ backend, results }) {
  if (!results?.length) return '（検索結果がありませんでした）';
  const lines = ['検索結果（' + backend + '・' + results.length + '件）', ''];
  for (const [i, r] of results.entries()) {
    lines.push(i + 1 + '. ' + (r.title || '(無題)'));
    if (r.url) lines.push('   ' + r.url);
    if (r.snippet) lines.push('   ' + r.snippet);
    lines.push('');
  }
  // Said plainly, because the snippets below are whatever the pages said.
  lines.push('※ 上記は検索エンジンの生の結果です。内容の正確さは保証されません。');
  return lines.join('\n');
}
