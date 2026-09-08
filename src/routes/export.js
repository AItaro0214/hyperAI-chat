/* Turns a model's answer into a downloadable document.
 *
 * The generated file is stored like any upload, so it is served by the existing
 * /api/files route with auth, range support and an attachment disposition. */

import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { logUsage } from '../lib/store.js';
import { requireKey } from '../lib/chat.js';
import { fetchImageModels, buildImageRequest, generateImages, imagesFrom, costOf } from '../lib/images.js';
import {
  buildXlsx,
  buildDocx,
  buildPptx,
  markdownToSlides,
  imageMarkers,
  parseDelimited,
  parseMarkdownTable,
  toCsv,
  THEMES,
  FONTS,
  MIME,
} from '../lib/office.js';

const exportRoute = new Hono();
exportRoute.use('/export', requireAuth);
exportRoute.use('/export/*', requireAuth);

export const FORMATS = ['xlsx', 'csv', 'docx', 'pptx', 'md', 'txt', 'json', 'html'];
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_REMOTE_IMAGE = 8 * 1024 * 1024;
const MAX_GENERATED = 8;
const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image';

exportRoute.get('/export/options', (c) =>
  c.json({
    formats: FORMATS,
    themes: Object.entries(THEMES).map(([id, t]) => ({ id, accent: '#' + t.accent })),
    fonts: Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label })),
    defaultImageModel: DEFAULT_IMAGE_MODEL,
  })
);

/** Strips a ```fence``` wrapper so a pasted code block converts cleanly. */
function unfence(text) {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(String(text || ''));
  return m ? m[1] : String(text || '');
}

/** Finds the grid in a document, whether it is CSV, TSV or a markdown table. */
export function gridFrom(content) {
  const body = unfence(content);
  const table = parseMarkdownTable(body);
  if (table.length > 1) return table;
  const rows = parseDelimited(body);
  return rows.length ? rows : [[body]];
}

/** A filesystem-safe name; Windows rejects the reserved characters outright. */
export function safeName(title, ext) {
  const base = String(title || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (base || 'document') + '.' + ext;
}

/** Which markers ask for a fresh picture rather than pointing at an existing one. */
export const wantsGeneration = (src) => !src || /^(gen|generate|生成|ai)$/i.test(src.trim());

/**
 * Resolves every `![alt](src)` in a document into image bytes.
 * Existing files and http(s) URLs are fetched; `gen` markers are generated.
 */
async function resolveImages(c, userId, markdown, options) {
  const marks = imageMarkers(markdown);
  if (!marks.length) return { images: [], cost: 0, notes: [] };

  const notes = [];
  const images = new Array(marks.length).fill(null);

  // Local files and remote URLs first: they are cheap and cannot fail costly.
  await Promise.all(
    marks.map(async (mark, i) => {
      const src = mark.src;
      if (wantsGeneration(src)) return;

      const fileId = (/(?:^|\/)(file_[A-Za-z0-9]+)/.exec(src) || [])[1];
      if (fileId) {
        const row = await c.env.DB.prepare('SELECT mime FROM files WHERE id = ? AND user_id = ?')
          .bind(fileId, userId)
          .first();
        const buf = row ? await c.env.KV.get('file:' + fileId, 'arrayBuffer') : null;
        if (buf) images[i] = { bytes: new Uint8Array(buf), mime: row.mime || 'image/png' };
        else notes.push('画像が見つかりませんでした: ' + src);
        return;
      }
      if (/^https?:\/\//i.test(src)) {
        try {
          const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
          const type = res.headers.get('content-type') || '';
          if (!res.ok || !type.startsWith('image/')) throw new Error('画像ではありません');
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX_REMOTE_IMAGE) throw new Error('画像が大きすぎます');
          images[i] = { bytes: new Uint8Array(buf), mime: type.split(';')[0] };
        } catch (e) {
          notes.push('画像を取得できませんでした（' + src + '）: ' + e.message);
        }
      }
    })
  );

  const pending = marks.map((m, i) => ({ ...m, i })).filter((m) => wantsGeneration(m.src) && m.alt);
  if (!pending.length || !options.generateImages) {
    if (pending.length && !options.generateImages) {
      notes.push(pending.length + ' 箇所の画像は「画像を生成する」がオフのため空欄になりました');
    }
    return { images, cost: 0, notes };
  }

  let apiKey;
  try {
    apiKey = await requireKey(c.env, 'openrouter');
  } catch (e) {
    notes.push('画像生成をスキップしました: ' + e.message);
    return { images, cost: 0, notes };
  }

  const catalogue = await fetchImageModels(c.env).catch(() => []);
  const model =
    catalogue.find((m) => m.id === options.imageModel) ||
    catalogue.find((m) => m.id === DEFAULT_IMAGE_MODEL) ||
    catalogue[0];
  if (!model) {
    notes.push('画像モデルの一覧を取得できませんでした');
    return { images, cost: 0, notes };
  }

  // One picture per marker, all in flight together.
  let cost = 0;
  const style = String(options.imageStyle || '').trim();
  await Promise.all(
    pending.slice(0, MAX_GENERATED).map(async (mark) => {
      const prompt = style ? mark.alt + '。' + style : mark.alt;
      try {
        const { body } = buildImageRequest(model, {
          prompt,
          n: 1,
          aspectRatio: options.aspectRatio || (model.aspectRatios.includes('16:9') ? '16:9' : undefined),
        });
        const res = await generateImages(apiKey, body);
        const [first] = imagesFrom(res);
        if (first) images[mark.i] = first;
        else notes.push('画像を生成できませんでした: ' + mark.alt);
        cost += costOf(res) || 0;
      } catch (e) {
        notes.push('画像生成に失敗（' + mark.alt + '）: ' + e.message);
      }
    })
  );
  if (pending.length > MAX_GENERATED) {
    notes.push('画像生成は ' + MAX_GENERATED + ' 枚までです（' + (pending.length - MAX_GENERATED) + ' 枚は空欄）');
  }
  if (cost) {
    await logUsage(c.env, {
      userId,
      roomId: options.roomId || null,
      provider: 'openrouter',
      model: model.id,
      kind: 'image',
      units: pending.length,
      cost,
    });
  }
  return { images, cost, notes };
}

export async function renderExport(format, content, title, extra = {}) {
  const { images = [], theme, font } = extra;
  switch (format) {
    case 'xlsx':
      return { bytes: await buildXlsx([{ name: (title || 'Sheet1').slice(0, 31), rows: gridFrom(content) }]), ext: 'xlsx' };
    case 'csv':
      return { bytes: new TextEncoder().encode('﻿' + toCsv(gridFrom(content))), ext: 'csv' };
    case 'docx':
      return { bytes: await buildDocx(content, { images }), ext: 'docx' };
    case 'pptx': {
      const slides = markdownToSlides(content);
      // Markers were numbered across the document, so each slide picks its own.
      for (const slide of slides) {
        const picked = slide.imageRef ? images[slide.imageRef.index] : null;
        if (picked) slide.image = picked;
      }
      return { bytes: await buildPptx(slides, { theme, font }), ext: 'pptx' };
    }
    case 'json':
      return { bytes: new TextEncoder().encode(unfence(content)), ext: 'json' };
    case 'html':
      return { bytes: new TextEncoder().encode(unfence(content)), ext: 'html' };
    case 'txt':
      return { bytes: new TextEncoder().encode(content), ext: 'txt' };
    default:
      return { bytes: new TextEncoder().encode(content), ext: 'md' };
  }
}

exportRoute.post('/export', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const format = String(body.format || '').toLowerCase();
  const content = String(body.content ?? '');
  if (!FORMATS.includes(format)) return c.json({ error: '未対応の形式です: ' + format }, 400);
  if (!content.trim()) return c.json({ error: '書き出す内容がありません' }, 400);
  if (content.length > MAX_INPUT) return c.json({ error: '内容が大きすぎます（上限 2MB）' }, 413);

  let images = [];
  let imageCost = 0;
  let notes = [];
  if (format === 'pptx' || format === 'docx') {
    const resolved = await resolveImages(c, userId, content, body);
    images = resolved.images;
    imageCost = resolved.cost;
    notes = resolved.notes;
  }

  let rendered;
  try {
    rendered = await renderExport(format, content, body.title, {
      images,
      theme: body.theme,
      font: body.font,
    });
  } catch (e) {
    return c.json({ error: 'ファイル生成に失敗しました: ' + e.message }, 500);
  }

  const id = newId('file');
  const name = safeName(body.title, rendered.ext);
  const mime = MIME[rendered.ext] || 'application/octet-stream';
  await c.env.KV.put('file:' + id, rendered.bytes, { metadata: { mime, name } });
  await c.env.DB.prepare(
    'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, body.roomId || null, 'doc', mime, name, rendered.bytes.length, now())
    .run();

  return c.json(
    {
      id,
      url: '/api/files/' + id + '?download=1',
      name,
      mime,
      size: rendered.bytes.length,
      format,
      images: images.filter(Boolean).length,
      cost: imageCost || null,
      notes,
    },
    201
  );
});

export default exportRoute;
