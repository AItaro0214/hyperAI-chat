/* Recording system audio and the microphone, straight to MP3.
 *
 * The two sources are mixed in the Web Audio graph so the mic can be muted
 * mid-recording without restarting, and the PCM is handed to a worker that
 * encodes MP3 — small files, and no dependency on the browser's own recorder
 * (which cannot produce MP3 anywhere). */

import { icon } from '/icons.js';

let ctx = null;
const $ = (sel) => document.querySelector(sel);

const UPLOAD_CAP = 20 * 1024 * 1024; // matches the /api/files limit
const WARN_AT = 18 * 1024 * 1024;

const state = {
  audio: null,
  worker: null,
  display: null,
  mic: null,
  micGain: null,
  systemGain: null,
  processor: null,
  analyser: null,
  startedAt: 0,
  bytes: 0,
  timer: null,
  meter: null,
  running: false,
  blob: null,
};

const fmtTime = (ms) => {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return m + ':' + s;
};

const fmtSize = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

function setStatus(text, kind = '') {
  const node = $('#rec-status');
  node.textContent = text;
  node.className = 'xs ' + (kind || 'muted');
}

/** Chrome only offers system/tab audio through the screen-share picker. */
async function captureSystem() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('音声が共有されませんでした。共有ダイアログで「タブの音声も共有する」にチェックを入れてください。');
  }
  // The video track is only there because the picker requires it.
  stream.getVideoTracks().forEach((t) => t.stop());
  return stream;
}

async function captureMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

function drawMeter() {
  if (!state.analyser) return;
  const buf = new Uint8Array(state.analyser.frequencyBinCount);
  state.analyser.getByteTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
  const level = Math.min(100, Math.round((peak / 128) * 140));
  $('#rec-level').style.width = level + '%';
  state.meter = requestAnimationFrame(drawMeter);
}

function tick() {
  const elapsed = Date.now() - state.startedAt;
  $('#rec-time').textContent = fmtTime(elapsed);
  $('#rec-size').textContent = fmtSize(state.bytes);
  if (state.bytes > WARN_AT) {
    setStatus('まもなくアップロード上限（20MB）です。停止して保存してください。', 'warn');
  }
}

async function start() {
  const wantSystem = $('#rec-system').checked;
  const wantMic = $('#rec-mic').checked;
  if (!wantSystem && !wantMic) return ctx.toast('システム音声かマイクのどちらかを選んでください', 'err');

  $('#rec-start').disabled = true;
  setStatus('準備中…');

  try {
    if (wantSystem) state.display = await captureSystem();
    if (wantMic) state.mic = await captureMic();
  } catch (e) {
    $('#rec-start').disabled = false;
    setStatus('');
    stop(true);
    return ctx.toast(e.message || '取得できませんでした', 'err');
  }

  const audio = new AudioContext();
  state.audio = audio;
  const merger = audio.createGain();

  if (state.display) {
    state.systemGain = audio.createGain();
    audio.createMediaStreamSource(state.display).connect(state.systemGain).connect(merger);
    // A track ends when the user hits "stop sharing" in the browser bar.
    state.display.getAudioTracks()[0].addEventListener('ended', () => stop());
  }
  if (state.mic) {
    state.micGain = audio.createGain();
    state.micGain.gain.value = $('#rec-mic-on').dataset.on === 'true' ? 1 : 0;
    audio.createMediaStreamSource(state.mic).connect(state.micGain).connect(merger);
  }

  state.analyser = audio.createAnalyser();
  state.analyser.fftSize = 1024;
  merger.connect(state.analyser);

  const bitrate = Number($('#rec-bitrate').value) || 64;
  state.worker = new Worker('/mp3-worker.js');
  state.worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') state.bytes = msg.bytes;
    if (msg.type === 'done') finish(msg.blob);
  };
  state.worker.postMessage({ type: 'start', sampleRate: audio.sampleRate, bitrate });

  // ScriptProcessor is deprecated but is the one path that works everywhere;
  // the heavy lifting happens in the worker regardless.
  const processor = audio.createScriptProcessor(4096, 1, 1);
  state.processor = processor;
  processor.onaudioprocess = (e) => {
    if (!state.running) return;
    const input = e.inputBuffer.getChannelData(0);
    state.worker.postMessage({ type: 'chunk', samples: new Float32Array(input) });
  };
  merger.connect(processor);
  // A destination connection is required or the processor never fires; a muted
  // gain keeps it silent.
  const sink = audio.createGain();
  sink.gain.value = 0;
  processor.connect(sink).connect(audio.destination);

  state.running = true;
  state.startedAt = Date.now();
  state.bytes = 0;
  state.blob = null;
  state.timer = setInterval(tick, 500);
  drawMeter();

  $('#rec-start').hidden = true;
  $('#rec-stop').hidden = false;
  $('#rec-result').hidden = true;
  $('#rec-start').disabled = false;
  setStatus('録音中', 'ok');
}

function teardown() {
  clearInterval(state.timer);
  cancelAnimationFrame(state.meter);
  state.timer = null;
  state.meter = null;
  try {
    state.processor?.disconnect();
  } catch {
    /* already gone */
  }
  state.display?.getTracks().forEach((t) => t.stop());
  state.mic?.getTracks().forEach((t) => t.stop());
  state.audio?.close().catch(() => {});
  state.display = null;
  state.mic = null;
  state.audio = null;
  state.processor = null;
  state.analyser = null;
  state.micGain = null;
  state.systemGain = null;
  $('#rec-level').style.width = '0%';
}

function stop(silent = false) {
  if (!state.running) {
    teardown();
    return;
  }
  state.running = false;
  $('#rec-stop').hidden = true;
  $('#rec-start').hidden = false;
  if (!silent) setStatus('MP3 に変換しています…');
  state.worker?.postMessage({ type: 'stop' });
  teardown();
}

function finish(blob) {
  state.worker?.terminate();
  state.worker = null;
  state.blob = blob;
  if (!blob || !blob.size) {
    setStatus('録音できませんでした', 'error');
    return;
  }
  const url = URL.createObjectURL(blob);
  $('#rec-preview').src = url;
  $('#rec-result').hidden = false;
  setStatus('完了：' + fmtSize(blob.size) + (blob.size > UPLOAD_CAP ? '（20MBを超えるため添付できません）' : ''), 'ok');
  $('#rec-attach').disabled = blob.size > UPLOAD_CAP;
}

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return 'recording-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.mp3';
}

async function attach() {
  if (!state.blob) return;
  $('#rec-attach').disabled = true;
  try {
    const form = new FormData();
    form.append('file', state.blob, defaultName());
    if (ctx.state.roomId) form.append('roomId', ctx.state.roomId);
    const res = await fetch('/api/files', { method: 'POST', body: form, credentials: 'same-origin' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'アップロードに失敗しました');
    ctx.attachFile({ id: json.id, url: json.url, mime: json.mime, name: json.name, kind: 'audio', size: json.size });
    ctx.toast('録音を添付しました');
    $('#rec-modal').hidden = true;
  } catch (e) {
    ctx.toast(e.message, 'err');
  } finally {
    $('#rec-attach').disabled = false;
  }
}

function download() {
  if (!state.blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(state.blob);
  a.download = defaultName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

export function initRecorder(context) {
  ctx = context;

  $('#record-btn').addEventListener('click', () => {
    $('#rec-modal').hidden = false;
    if (!state.running) {
      $('#rec-time').textContent = '00:00';
      $('#rec-size').textContent = '0 KB';
      setStatus('システム音声はブラウザの共有ダイアログで「タブの音声も共有」を選んでください。');
    }
  });

  $('#rec-start').addEventListener('click', start);
  $('#rec-stop').addEventListener('click', () => stop());
  $('#rec-attach').addEventListener('click', attach);
  $('#rec-download').addEventListener('click', download);

  // The mic can be muted mid-recording without touching the stream.
  $('#rec-mic-on').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const on = btn.dataset.on !== 'true';
    btn.dataset.on = String(on);
    btn.innerHTML = icon(on ? 'mic' : 'mic-off', 16) + '<span>' + (on ? 'マイク ON' : 'マイク OFF') + '</span>';
    if (state.micGain) state.micGain.gain.value = on ? 1 : 0;
  });
}
