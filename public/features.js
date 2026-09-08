/* Video generation and runnable artifacts.
 * The chat shell hands its helpers in via initFeatures so this module stays
 * free of duplicated plumbing. */
import { icon } from '/icons.js';

let ctx = null;
const $ = (sel, root = document) => root.querySelector(sel);

export function initFeatures(context) {
  ctx = context;
  bindArtifacts();
  bindVideo();
}

/* ============================== ARTIFACTS =============================== */
let currentArtifact = null;

/** Adds a preview button under any HTML/SVG block the model produced. */
export function attachArtifactButtons(bodyEl, msg) {
  if (!ctx) return;
  for (const code of bodyEl.querySelectorAll('pre > code')) {
    const lang = (String(code.className || '').match(/language-([\w-]+)/) || [])[1] || '';
    const text = code.textContent || '';
    const isSvg = lang === 'svg' || /^\s*<svg[\s>]/i.test(text);
    const isHtml = ['html', 'xhtml'].includes(lang) || /^\s*(<!doctype html|<html[\s>])/i.test(text);
    if ((!isSvg && !isHtml) || text.trim().length < 20) continue;

    const bar = ctx.el('div', 'code-actions');
    const run = ctx.el('button', 'btn');
    run.type = 'button';
    run.innerHTML = icon('play', 15) + '<span>プレビュー</span>';
    run.addEventListener('click', () => openArtifact(text, isSvg ? 'svg' : 'html', msg));
    bar.appendChild(run);
    code.closest('pre').after(bar);
  }
}

async function openArtifact(content, kind, msg) {
  try {
    const res = await ctx.api('/api/artifacts', {
      method: 'POST',
      body: JSON.stringify({
        content,
        kind,
        roomId: ctx.state.roomId,
        messageId: msg?.id && !String(msg.id).startsWith('tmp_') ? msg.id : null,
        title: (ctx.state.room?.title || 'artifact').slice(0, 60),
      }),
    });
    currentArtifact = { ...res.artifact, content, kind };
    $('#artifact-title').textContent = kind === 'svg' ? 'SVG プレビュー' : 'HTML プレビュー';
    $('#artifact-frame').src = frameUrl();
    $('#artifact-modal').hidden = false;
  } catch (e) {
    ctx.toast(e.message, 'err');
  }
}

/** CDN scripts and fetch are allowed unless the strict box is ticked. */
function frameUrl() {
  if (!currentArtifact) return 'about:blank';
  const strict = document.getElementById('artifact-strict')?.checked;
  return currentArtifact.url + (strict ? (currentArtifact.url.includes('?') ? '&' : '?') + 'strict=1' : '');
}

function bindArtifacts() {
  $('#artifact-open').addEventListener('click', () => {
    if (currentArtifact) window.open(frameUrl(), '_blank', 'noopener');
  });
  $('#artifact-strict').addEventListener('change', () => {
    if (currentArtifact) $('#artifact-frame').src = frameUrl();
  });
  $('#artifact-download').addEventListener('click', () => {
    if (!currentArtifact) return;
    const blob = new Blob([currentArtifact.content], {
      type: currentArtifact.kind === 'svg' ? 'image/svg+xml' : 'text/html',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'artifact.' + (currentArtifact.kind === 'svg' ? 'svg' : 'html');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

/* ========================== VIDEO GENERATION =========================== */
let videoModels = [];
let videoTimer = null;

const currentVideoModel = () => videoModels.find((m) => m.id === $('#vid-model').value) || null;

function fillSelect(sel, values, { empty = null, selected = null } = {}) {
  const node = $(sel);
  const opts = [];
  if (empty !== null) opts.push('<option value="">' + empty + '</option>');
  for (const v of values) {
    opts.push('<option value="' + ctx.esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + ctx.esc(v) + '</option>');
  }
  node.innerHTML = opts.join('');
  node.disabled = values.length === 0;
}

function renderVideoParams() {
  const m = currentVideoModel();
  if (!m) return;
  $('#vid-desc').textContent = m.description || '';
  fillSelect('#vid-duration', m.durations, { selected: m.durations.includes(5) ? 5 : m.durations[0] });
  fillSelect('#vid-resolution', m.resolutions, { selected: m.resolutions[0] });
  fillSelect('#vid-aspect', m.aspectRatios, { empty: '指定しない' });
  fillSelect('#vid-size', m.sizes, { empty: '解像度に任せる' });
  $('#vid-audio').disabled = !m.generateAudio;
  $('#vid-audio').checked = false;
  $('#vid-seed').disabled = !m.seed;

  const images = ctx.state.attachments.filter((a) => a.kind === 'image');
  const canFrame = m.frameImages.includes('first_frame') && images.length > 0;
  $('#vid-frame-wrap').hidden = !canFrame;
  if (canFrame) {
    $('#vid-frame').innerHTML =
      '<option value="">使わない</option>' +
      images.map((a) => '<option value="' + ctx.esc(a.id) + '">' + ctx.esc(a.name) + '</option>').join('');
  }
  updateVideoCost();
}

// Mirrors src/lib/video.js: providers bill per second, per video token, or per
// megapixel-second depending on the model.
const RES_DIMS = {
  '480p': [854, 480],
  '720p': [1280, 720],
  '768p': [1366, 768],
  '1024p': [1820, 1024],
  '1080p': [1920, 1080],
  '4k': [3840, 2160],
};

function resolutionKey(resolution, size) {
  const dims = /^(\d+)x(\d+)$/.exec(String(size || ''));
  if (dims) {
    const shorter = Math.min(Number(dims[1]), Number(dims[2]));
    if (shorter <= 480) return '480p';
    if (shorter <= 720) return '720p';
    if (shorter <= 768) return '768p';
    if (shorter <= 1080) return '1080p';
    return '4k';
  }
  const res = String(resolution || '').toLowerCase();
  return RES_DIMS[res] ? res : 'default';
}

function estimateCost(model, { resolution, size, duration, audio }) {
  const rates = model?.rates;
  if (!rates || !duration) return null;
  const res = resolutionKey(resolution, size);
  const prefix = audio ? 'audio:' : 'noaudio:';

  const perSecond =
    rates.perSecond[prefix + res] ?? rates.perSecond[res] ?? rates.perSecond[prefix + 'default'] ?? rates.perSecond.default;
  if (perSecond !== undefined) return Math.max(perSecond * duration, rates.extra.minimum || 0);

  const perToken =
    (!audio ? rates.perToken['noaudio:' + res] : undefined) ??
    rates.perToken[res] ??
    (!audio ? rates.perToken['noaudio:default'] : undefined) ??
    rates.perToken.default;
  if (perToken !== undefined) {
    const dims = /^(\d+)x(\d+)$/.exec(String(size || ''));
    const [w, h] = dims ? [Number(dims[1]), Number(dims[2])] : RES_DIMS[res] || [];
    if (!w) return null;
    return ((w * h * 24 * duration) / 1024) * perToken;
  }
  if (rates.extra.megapixelSecond) {
    const [w, h] = RES_DIMS[res] || RES_DIMS['720p'];
    return ((w * h) / 1e6) * duration * rates.extra.megapixelSecond;
  }
  return null;
}

function updateVideoCost() {
  const m = currentVideoModel();
  if (!m) return;
  const duration = Number($('#vid-duration').value || 0);
  const size = $('#vid-size').value;
  const resolution = $('#vid-resolution').value;
  const audio = $('#vid-audio').checked;
  const list = estimateCost(m, { resolution, size, duration, audio });
  if (list == null) {
    $('#vid-cost').textContent = '概算コストを算出できません';
    return;
  }
  const off = Number(m.discount) || 0;
  const cost = off > 0 && off < 1 ? list * (1 - off) : list;
  $('#vid-cost').textContent =
    '概算 ' + ctx.usd(cost) + '（' + (size || resolution || '既定') + ' / ' + duration + '秒' +
    (audio ? ' / 音声あり' : '') + (off ? ' / ' + Math.round(off * 100) + '%OFF適用・定価 ' + ctx.usd(list) : '') + '）';
}

function bindVideo() {
  $('#video-btn').addEventListener('click', async () => {
    $('#video-modal').hidden = false;
    $('#vid-prompt').value = $('#input').value.trim();
    $('#vid-status').textContent = '';
    $('#vid-result').hidden = true;
    if (!videoModels.length) {
      $('#vid-model').innerHTML = '<option>読み込み中…</option>';
      try {
        videoModels = (await ctx.api('/api/videos/models')).models;
      } catch (e) {
        $('#vid-model').innerHTML = '';
        ctx.toast(e.message, 'err');
        return;
      }
    }
    $('#vid-model').innerHTML = videoModels
      .map((m) => '<option value="' + ctx.esc(m.id) + '">' + ctx.esc(m.name) + '</option>')
      .join('');
    renderVideoParams();
  });

  $('#vid-model').addEventListener('change', renderVideoParams);
  for (const sel of ['#vid-duration', '#vid-resolution', '#vid-size', '#vid-audio']) {
    $(sel).addEventListener('change', updateVideoCost);
  }

  $('#vid-run').addEventListener('click', async () => {
    const m = currentVideoModel();
    const prompt = $('#vid-prompt').value.trim();
    if (!m || !prompt) return ctx.toast('プロンプトを入力してください', 'err');
    const btn = $('#vid-run');
    btn.disabled = true;
    $('#vid-status').textContent = 'ジョブを投入しています…';
    $('#vid-result').hidden = true;
    try {
      const frameId = $('#vid-frame-wrap').hidden ? '' : $('#vid-frame').value;
      const res = await ctx.api('/api/videos', {
        method: 'POST',
        body: JSON.stringify({
          roomId: ctx.state.roomId,
          model: m.id,
          prompt,
          duration: Number($('#vid-duration').value) || undefined,
          resolution: $('#vid-resolution').value || undefined,
          aspectRatio: $('#vid-aspect').value || undefined,
          size: $('#vid-size').value || undefined,
          seed: $('#vid-seed').value === '' ? undefined : Number($('#vid-seed').value),
          generateAudio: $('#vid-audio').disabled ? undefined : $('#vid-audio').checked,
          frameImages: frameId ? [{ fileId: frameId, frameType: 'first_frame' }] : [],
        }),
      });
      if (ctx.state.roomId) await ctx.openRoom(ctx.state.roomId);
      watchVideoJob(res.job.id, true);
    } catch (e) {
      $('#vid-status').textContent = '';
      ctx.toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

/** Polls until the job settles; the room message is updated server side. */
function watchVideoJob(jobId, focused) {
  clearTimeout(videoTimer);
  const started = Date.now();
  const tick = async () => {
    let job;
    try {
      job = (await ctx.api('/api/videos/' + jobId)).job;
    } catch {
      videoTimer = setTimeout(tick, 8000);
      return;
    }
    if (job.status === 'pending' || job.status === 'in_progress') {
      if (focused) {
        const secs = Math.round((Date.now() - started) / 1000);
        $('#vid-status').textContent = '生成中… ' + secs + '秒経過（数分かかることがあります）';
      }
      videoTimer = setTimeout(tick, 6000);
      return;
    }
    if (job.status === 'failed') {
      if (focused) $('#vid-status').textContent = '';
      ctx.toast('動画生成に失敗: ' + (job.error || '不明なエラー'), 'err');
    } else {
      const url = job.attachment?.url || job.videoUrl;
      if (focused && url) {
        $('#vid-status').textContent = '完了' + (job.cost ? '（' + ctx.usd(job.cost) + '）' : '');
        $('#vid-result').src = url;
        $('#vid-result').hidden = false;
      }
      ctx.toast('動画が完成しました');
    }
    if (ctx.state.roomId) {
      await ctx.openRoom(ctx.state.roomId).catch(() => {});
      await ctx.loadRooms().catch(() => {});
    }
  };
  videoTimer = setTimeout(tick, 4000);
}

/** Picks up a job that was still running when the page was last closed. */
export async function resumeVideoJobs() {
  if (!ctx) return;
  try {
    const { jobs } = await ctx.api('/api/videos/jobs');
    // Also pick up finished jobs whose download did not land, so the retry on
    // the server can attach the video.
    const unfinished = jobs.find(
      (j) => ['pending', 'in_progress'].includes(j.status) || (j.status === 'completed' && !j.file_id)
    );
    if (unfinished) watchVideoJob(unfinished.id, false);
  } catch {
    /* not critical */
  }
}
