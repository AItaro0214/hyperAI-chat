import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { getSettings, logUsage } from '../lib/store.js';
import { GROQ_BASE, readProviderError, requireKey } from '../lib/chat.js';
import { estimateAsrCost, estimateTtsCost, getCatalog, findModel } from '../lib/models.js';
import { fetchSpeechModels, synthesize, isGroqSpeech, speechMime, formatFor } from '../lib/speech.js';
import { isExpired, expiresAt, EXPIRING_KINDS, MEDIA_TTL_DAYS } from '../lib/media-retention.js';

const media = new Hono();
media.use('/files', requireAuth);
media.use('/files/*', requireAuth);
media.use('/asr', requireAuth);
media.use('/tts', requireAuth);

const MAX_UPLOAD = 20 * 1024 * 1024; // KV values cap at 25MB

function kindFor(mime) {
  if (!mime) return 'doc';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'audio';
  return 'doc';
}

media.post('/files', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'file が必要です' }, 400);
  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD) return c.json({ error: 'ファイルが大きすぎます（上限 20MB）' }, 413);
  const id = newId('file');
  const mime = file.type || 'application/octet-stream';
  const name = (file.name || 'upload').slice(0, 200);
  await c.env.KV.put('file:' + id, buf, { metadata: { mime, name, at: now() } });
  await c.env.DB.prepare(
    'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, c.get('userId'), form.get('roomId') || null, kindFor(mime), mime, name, buf.byteLength, now())
    .run();
  return c.json({ id, url: '/api/files/' + id, mime, name, size: buf.byteLength, kind: kindFor(mime) }, 201);
});

media.get('/files/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').bind(id, c.get('userId')).first();
  if (!row) return c.json({ error: 'not found' }, 404);
  // Gone rather than missing: the file was here and aged out on a known rule,
  // which is what the client needs in order to say so.
  if (isExpired(row)) return c.json({ error: 'expired', expiredAt: row.expired_at || null, ttlDays: MEDIA_TTL_DAYS }, 410);
  const buf = await c.env.KV.get('file:' + id, 'arrayBuffer');
  if (!buf) return c.json({ error: 'blob missing' }, 404);

  // Media that will be reaped must not be cached past its own lifetime.
  const remaining = EXPIRING_KINDS.includes(row.kind)
    ? Math.max(0, expiresAt(Number(row.created_at) || 0) - now())
    : 31536000;

  const headers = {
    'content-type': row.mime || 'application/octet-stream',
    'cache-control': 'private, max-age=' + remaining + (EXPIRING_KINDS.includes(row.kind) ? '' : ', immutable'),
    // Office documents have no viewer in the browser, so they are offered as a
    // download; media stays inline so it can render in place.
    'content-disposition':
      (c.req.query('download') === '1' || row.kind === 'doc' ? 'attachment' : 'inline') +
      "; filename*=UTF-8''" + encodeURIComponent(row.name || 'file'),
    'accept-ranges': 'bytes',
  };

  // Video elements (Safari in particular) will not play a source that cannot
  // serve byte ranges, so partial requests are answered properly.
  const range = c.req.header('range');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (match) {
    const total = buf.byteLength;
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start === null && end !== null) {
      start = Math.max(0, total - end);
      end = total - 1;
    } else {
      if (start === null) start = 0;
      if (end === null || end >= total) end = total - 1;
    }
    if (!Number.isFinite(start) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': 'bytes */' + total } });
    }
    const slice = buf.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(slice.byteLength),
        'content-range': 'bytes ' + start + '-' + end + '/' + total,
      },
    });
  }

  return new Response(buf, { headers: { ...headers, 'content-length': String(buf.byteLength) } });
});

media.delete('/files/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT id FROM files WHERE id = ? AND user_id = ?').bind(id, c.get('userId')).first();
  if (!row) return c.json({ error: 'not found' }, 404);
  await c.env.KV.delete('file:' + id);
  await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

/* --------------------------------- ASR ---------------------------------- */
media.post('/asr', async (c) => {
  const key = await requireKey(c.env, 'groq').catch((e) => e);
  if (key instanceof Error) return c.json({ error: key.message }, 400);
  const settings = await getSettings(c.env);
  const form = await c.req.formData();
  const audio = form.get('audio') || form.get('file');
  if (!audio || typeof audio === 'string') return c.json({ error: 'audio が必要です' }, 400);
  const model = form.get('model') || settings.asrModel || 'whisper-large-v3-turbo';

  const upstream = new FormData();
  upstream.append('file', audio, audio.name || 'audio.webm');
  upstream.append('model', model);
  upstream.append('response_format', 'verbose_json');
  const language = form.get('language');
  if (language) upstream.append('language', language);
  const prompt = form.get('prompt');
  if (prompt) upstream.append('prompt', prompt);

  const res = await fetch(GROQ_BASE + '/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key },
    body: upstream,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) return c.json({ error: await readProviderError(res) }, 502);
  const json = await res.json();
  const seconds = json.duration || null;

  const catalog = await getCatalog(c.env).catch(() => ({ models: [] }));
  const meta = findModel(catalog, 'groq:' + model);
  const cost = estimateAsrCost(meta, seconds);
  await logUsage(c.env, {
    userId: c.get('userId'),
    roomId: form.get('roomId') || null,
    provider: 'groq',
    model,
    kind: 'asr',
    units: seconds,
    cost,
  });
  return c.json({ text: json.text || '', seconds, model, cost, language: json.language || null });
});

/* --------------------------------- TTS ---------------------------------- */
// Orpheus accepts 200 characters per request, so long answers are synthesized
// in pieces and stitched back into a single WAV.
const TTS_CHUNK = 190;
const TTS_MAX_CHUNKS = 24;

export function splitForTts(text, limit = TTS_CHUNK) {
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[。．.!?！？])/);
  const chunks = [];
  let current = '';
  for (const raw of sentences) {
    let piece = raw;
    while (piece.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(piece.slice(0, limit));
      piece = piece.slice(limit);
    }
    if ((current + piece).length > limit) {
      if (current) chunks.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.filter((c) => c.trim()).slice(0, TTS_MAX_CHUNKS);
}

/** Concatenates PCM WAV buffers that share the same format. */
export function concatWav(buffers) {
  if (buffers.length === 1) return buffers[0];
  const parsed = buffers.map((buf) => {
    const view = new DataView(buf);
    let offset = 12;
    while (offset + 8 <= buf.byteLength) {
      const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') return { header: new Uint8Array(buf, 0, offset + 8), body: new Uint8Array(buf, offset + 8, Math.min(size, buf.byteLength - offset - 8)) };
      offset += 8 + size + (size % 2);
    }
    return null;
  });
  if (parsed.some((p) => !p)) return buffers[0];
  const totalBody = parsed.reduce((n, p) => n + p.body.length, 0);
  const header = parsed[0].header;
  const out = new Uint8Array(header.length + totalBody);
  out.set(header, 0);
  let pos = header.length;
  for (const p of parsed) {
    out.set(p.body, pos);
    pos += p.body.length;
  }
  const dv = new DataView(out.buffer);
  dv.setUint32(4, out.length - 8, true); // RIFF size
  dv.setUint32(header.length - 4, totalBody, true); // data chunk size
  return out.buffer;
}

media.get('/tts/models', async (c) => {
  try {
    const models = await fetchSpeechModels(c.env, { force: c.req.query('refresh') === '1' });
    return c.json({ models });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

media.post('/tts', async (c) => {
  const settings = await getSettings(c.env);
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.text || '').slice(0, 8000);
  if (!text.trim()) return c.json({ error: 'text が必要です' }, 400);
  const model = body.model || settings.ttsModel;
  const voice = body.voice || settings.ttsVoice;
  const userId = c.get('userId');

  // Groq's Orpheus needs its own endpoint and its 200-character cap; every
  // other model goes to OpenRouter's /audio/speech in one shot.
  const groq = isGroqSpeech(model);
  const provider = groq ? 'groq' : 'openrouter';
  /* What is asked for, not what comes back: Gemini answers only in raw pcm,
   * which is given a WAV header on the way through, so the file's real
   * format is whatever synthesize() reports. */
  const format = formatFor(model, body.format, { provider });

  const key = await requireKey(c.env, provider).catch((e) => e);
  if (key instanceof Error) return c.json({ error: key.message }, 400);

  let buf;
  let mime;
  let ext = format;
  let spoken = text;
  let cost = null;

  try {
    if (groq) {
      const chunks = splitForTts(text);
      if (!chunks.length) return c.json({ error: '読み上げる文章がありません' }, 400);
      const parts = [];
      let contentType = null;
      for (const chunk of chunks) {
        const out = await synthesize(key, model, { text: chunk, voice, format, provider: 'groq' });
        contentType = contentType || out.mime;
        ext = out.format;
        parts.push(out.bytes.buffer);
      }
      buf = ext === 'wav' ? concatWav(parts) : new Uint8Array(parts[0]);
      mime = contentType || speechMime(ext);
      spoken = chunks.join('');
      const catalog = await getCatalog(c.env).catch(() => ({ models: [] }));
      cost = estimateTtsCost(findModel(catalog, 'groq:' + model), spoken.length);
    } else {
      const out = await synthesize(key, model, { text, voice, format, provider: 'openrouter' });
      buf = out.bytes;
      mime = out.mime;
      ext = out.format;
      const meta = (await fetchSpeechModels(c.env).catch(() => [])).find((m) => m.id === model);
      if (meta?.perMillionChars) cost = (text.length / 1e6) * meta.perMillionChars;
    }
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }

  const id = newId('file');
  const size = buf.byteLength ?? buf.length;
  await c.env.KV.put('file:' + id, buf, { metadata: { mime, at: now() } });
  await c.env.DB.prepare(
    'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, userId, body.roomId || null, 'audio', mime, 'speech.' + ext, size, now())
    .run();

  await logUsage(c.env, {
    userId,
    roomId: body.roomId || null,
    provider,
    model,
    kind: 'tts',
    units: spoken.length,
    cost,
  });

  return c.json({ id, url: '/api/files/' + id, mime, size, format: ext, cost, chars: spoken.length });
});

export default media;
