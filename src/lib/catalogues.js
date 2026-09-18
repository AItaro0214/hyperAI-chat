/* The live model catalogue, as something the agent can look things up in.
 *
 * Model ids are the fastest-moving fact this app depends on, so nothing should
 * be written down that claims to know them. Baking a rendered list into every
 * skill made the skills two thirds catalogue by volume, and made that two
 * thirds wrong the moment a generation shipped.
 *
 * So the lists are not written down at all: the agent queries them, gets what
 * the provider says today, and uses an id it has actually seen. */

import { fetchImageModels } from './images.js';
import { fetchVideoModels, estimateVideoCost, applyDiscount } from './video.js';
import { fetchSpeechModels } from './speech.js';
import { fetchXaiModels } from './xai.js';
import { getCatalog } from './models.js';

export const KINDS = ['image', 'video', 'speech', 'chat', 'xai'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 60;

const money = (n, digits = 3) => '$' + Number(n).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
const squash = (s) => String(s).toLowerCase().replace(/[\s._\-/]/g, '');

/* --------------------------- per-kind loaders ---------------------------
 * Each returns rows of { id, note, sort } — note being the one line of fact
 * that decides whether this is the right model for the job. */

async function imageRows(env) {
  const models = await fetchImageModels(env);
  return models.map((m) => {
    const notes = [];
    if (m.maxN > 1) notes.push('一括' + m.maxN + '枚');
    if (m.outputFormats?.includes('svg')) notes.push('SVG可');
    if (m.maxReferences > 0) notes.push('参照画像可');
    return { id: m.id, note: notes.join('・'), sort: 0 };
  });
}

/** "4/5/6/7/8秒" is noise; "4〜8秒" is the same fact. */
function durationNote(durations) {
  const ds = durations.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ds.length) return '';
  if (ds.length <= 4) return ds.join('/') + '秒';
  return ds[0] + '〜' + ds[ds.length - 1] + '秒';
}

async function videoRows(env) {
  const models = await fetchVideoModels(env);
  return models.map((m) => {
    const res = m.resolutions?.includes('720p') ? '720p' : m.resolutions?.[0];
    const perSecond = applyDiscount(
      estimateVideoCost(m, { resolution: res, duration: 1, generateAudio: m.generateAudio }),
      m.discount
    );
    const notes = [];
    if (perSecond) notes.push(money(perSecond, 4) + '/秒');
    if (m.generateAudio) notes.push('音声可');
    // Some models accept every integer from 2 to 30; listing them all is noise.
    if (m.durations?.length) notes.push(durationNote(m.durations));
    return { id: m.id, note: notes.join('・'), sort: perSecond || 0 };
  });
}

async function speechRows(env) {
  const models = await fetchSpeechModels(env);
  return models.map((m) => {
    const notes = [];
    if (m.free) notes.push('無料');
    else if (m.perMillionChars) notes.push(money(m.perMillionChars, 2) + '/100万字');
    if (m.voices?.length) notes.push('声: ' + m.voices.slice(0, 6).join(', ') + (m.voices.length > 6 ? ' ほか' : ''));
    return { id: m.id, note: notes.join('・'), sort: m.free ? 0 : m.perMillionChars || 0 };
  });
}

/** Tool-capable chat models, cheapest first — what a sub-agent should run on. */
async function chatRows(env) {
  const data = await getCatalog(env);
  return (data.models || [])
    .filter((m) => m.tools && m.kind === 'chat' && !/:(batch|free)$/.test(m.id))
    .map((m) => ({ id: m.id, out: Number(m.pricing?.output_per_m) || 0 }))
    .filter((m) => m.out > 0)
    .sort((a, b) => a.out - b.out)
    .map((m) => ({ id: m.id, note: '出力 ' + money(m.out, 2) + '/1Mトークン', sort: m.out }));
}

async function xaiRows(env) {
  const models = await fetchXaiModels(env);
  return models.map((m) => {
    const notes = [];
    if (m.perMillionIn) notes.push('入力 ' + money(m.perMillionIn, 2) + '/M');
    if (m.perMillionOut) notes.push('出力 ' + money(m.perMillionOut, 2) + '/M');
    return { id: m.id, note: notes.join('・'), sort: m.perMillionIn || 0 };
  });
}

const LOADERS = { image: imageRows, video: videoRows, speech: speechRows, chat: chatRows, xai: xaiRows };

/**
 * Filters rows by a loose query. Matching ignores separators and case, so
 * "gemini flash" finds google/gemini-3.8-flash-image, and every word has to
 * appear somewhere — a query narrows, it never widens.
 */
export function filterRows(rows, query) {
  const raw = String(query || '').trim();
  if (!raw) return rows;
  const words = raw.toLowerCase().split(/[\s,、]+/).map(squash).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = squash(r.id) + ' ' + squash(r.note);
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Looks the catalogue up for the agent.
 * @returns {Promise<{kind: string, total: number, shown: number, text: string}>}
 */
export async function listModels(env, kind, { query, limit } = {}) {
  const key = String(kind || '').toLowerCase();
  const load = LOADERS[key];
  if (!load) throw new Error('kind は ' + KINDS.join(' / ') + ' のいずれかです（受け取った値: ' + kind + '）');

  const rows = await load(env);
  const matched = filterRows(rows, query);
  const cap = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const shown = matched.slice(0, cap);

  if (!rows.length) return { kind: key, total: 0, shown: 0, text: '（カタログを取得できませんでした）' };
  if (!matched.length) {
    return {
      kind: key,
      total: rows.length,
      shown: 0,
      // A dead end is more useful with the alternatives attached than without.
      text:
        '「' + query + '」に一致するモデルはありません（' + key + ' は全' + rows.length + '件）。\n' +
        '絞り込みなしの先頭:\n' +
        rows.slice(0, 10).map((r) => '- `' + r.id + '`' + (r.note ? ' — ' + r.note : '')).join('\n'),
    };
  }

  const head =
    key + ' モデル ' + matched.length + '件' +
    (matched.length > shown.length ? '（うち' + shown.length + '件を表示。limit で増やせます）' : '') + ':';
  return {
    kind: key,
    total: rows.length,
    shown: shown.length,
    text: head + '\n' + shown.map((r) => '- `' + r.id + '`' + (r.note ? ' — ' + r.note : '')).join('\n'),
  };
}
