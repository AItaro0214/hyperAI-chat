/* Batch image generation.
 *
 * OpenRouter's image endpoint takes an `n`, but the ceiling is per-model, so the
 * slider is clamped to whatever the selected model declares and models that can
 * only do one at a time are split into parallel calls server side. */

import { icon } from '/icons.js';

let ctx = null;
let models = [];
const $ = (sel) => document.querySelector(sel);

const current = () => models.find((m) => m.id === $('#img-model').value) || null;

function fill(sel, values, { empty = null, selected = null } = {}) {
  const node = $(sel);
  const opts = [];
  if (empty !== null) opts.push('<option value="">' + empty + '</option>');
  for (const v of values) {
    opts.push('<option value="' + ctx.esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + ctx.esc(v) + '</option>');
  }
  node.innerHTML = opts.join('');
  node.closest('.field').hidden = values.length === 0;
}

function renderParams() {
  const m = current();
  if (!m) return;
  $('#img-desc').textContent = m.description || '';

  const slider = $('#img-count');
  // The server splits anything above the model's own ceiling into parallel
  // calls, so the slider always goes to 10 — the note explains the difference.
  slider.max = '10';
  if (Number(slider.value) > 10) slider.value = '10';
  $('#img-count-note').textContent =
    m.maxN > 1
      ? 'このモデルは 1 回のリクエストで最大 ' + m.maxN + ' 枚まで生成できます'
      : 'このモデルは 1 枚ずつしか生成できないため、枚数分を並列で実行します';
  updateCount();

  fill('#img-aspect', m.aspectRatios, { empty: '指定しない', selected: m.aspectRatios.includes('1:1') ? '1:1' : null });
  fill('#img-quality', m.qualities, { empty: '自動' });
  fill('#img-resolution', m.resolutions, { empty: '自動' });

  const images = ctx.state.attachments.filter((a) => a.kind === 'image');
  const canRef = m.maxReferences > 0 && images.length > 0;
  $('#img-ref-wrap').hidden = !canRef;
  if (canRef) {
    $('#img-ref').innerHTML = images
      .map((a) => '<option value="' + ctx.esc(a.id) + '">' + ctx.esc(a.name) + '</option>')
      .join('');
  }
}

function updateCount() {
  const n = Number($('#img-count').value) || 1;
  const m = current();
  const calls = m ? Math.ceil(n / Math.max(1, m.maxN)) : 1;
  $('#img-count-label').textContent = n + ' 枚' + (calls > 1 ? '（' + calls + ' 回に分割）' : '');
}

async function run() {
  const m = current();
  const prompt = $('#img-prompt').value.trim();
  if (!m || !prompt) return ctx.toast('プロンプトを入力してください', 'err');
  const btn = $('#img-run');
  btn.disabled = true;
  $('#img-status').textContent = '生成中… 枚数によっては 1 分ほどかかります';
  $('#img-results').hidden = true;

  try {
    const refs = [...$('#img-ref').selectedOptions].map((o) => o.value);
    const res = await ctx.api('/api/images', {
      method: 'POST',
      body: JSON.stringify({
        roomId: ctx.state.roomId,
        model: m.id,
        prompt,
        count: Number($('#img-count').value) || 1,
        aspectRatio: $('#img-aspect').value || undefined,
        quality: $('#img-quality').value || undefined,
        resolution: $('#img-resolution').value || undefined,
        referenceFileIds: $('#img-ref-wrap').hidden ? [] : refs,
      }),
    });

    $('#img-status').textContent =
      res.images.length + ' 枚できました' + (res.cost ? '（' + ctx.usd(res.cost) + '）' : '');
    $('#img-results').innerHTML = res.images
      .map((img) => '<a href="' + ctx.esc(img.url) + '" target="_blank" rel="noopener"><img src="' + ctx.esc(img.url) + '" loading="lazy" alt=""></a>')
      .join('');
    $('#img-results').hidden = false;
    for (const note of res.errors || []) ctx.toast(note, 'err');
    if (ctx.state.roomId) {
      await ctx.openRoom(ctx.state.roomId).catch(() => {});
      await ctx.loadRooms().catch(() => {});
    }
  } catch (e) {
    $('#img-status').textContent = '';
    ctx.toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

export function initImageGen(context) {
  ctx = context;

  $('#imagegen-btn').addEventListener('click', async () => {
    $('#imagegen-modal').hidden = false;
    $('#img-prompt').value = $('#input').value.trim();
    $('#img-status').textContent = '';
    $('#img-results').hidden = true;
    if (!models.length) {
      $('#img-model').innerHTML = '<option>読み込み中…</option>';
      try {
        models = (await ctx.api('/api/images/models')).models;
      } catch (e) {
        $('#img-model').innerHTML = '';
        ctx.toast(e.message, 'err');
        return;
      }
    }
    $('#img-model').innerHTML = models
      .map(
        (m) =>
          '<option value="' + ctx.esc(m.id) + '">' + ctx.esc(m.name) +
          (m.maxN > 1 ? '（一括 ' + m.maxN + ' 枚）' : '') + '</option>'
      )
      .join('');
    renderParams();
  });

  $('#img-model').addEventListener('change', renderParams);
  $('#img-count').addEventListener('input', updateCount);
  $('#img-run').addEventListener('click', run);
}

/** The catalogue, for the export sheet's image-model picker. */
export async function imageModels(context) {
  if (!models.length) {
    models = (await (context || ctx).api('/api/images/models')).models;
  }
  return models;
}
