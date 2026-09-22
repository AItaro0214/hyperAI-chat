/* hyperAI-chat — client */
import { icon, hydrateIcons } from '/icons.js';
import { initFeatures, attachArtifactButtons, resumeVideoJobs } from '/features.js';
import { initExport, attachExportButtons, openExport } from '/export.js';
import { initImageGen } from '/imagegen.js';
import { initAgent } from '/agent.js';
import { initRecorder } from '/recorder.js';
import { initTts, ttsPrefs, speakInBrowser, refreshModels as refreshTtsModels } from '/tts.js';
import { initGestures } from '/gestures.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  me: null,
  rooms: [],
  roomId: null,
  room: null,
  messages: [],
  catalog: [],
  families: [],
  defaults: {},
  attachments: [],
  streaming: false,
  lastSearchMode: 'server',
  lastImageMode: 'server',
  controller: null,
  ticket: null,
  modelsLoadedAt: 0,
  effort: '',
};

// OpenRouter's full ladder. Providers that lack a level get the nearest one,
// and the server reports the substitution.
const EFFORTS = [
  { value: '', label: '自動', desc: 'モデルの既定に任せます（パラメータを送りません）。' },
  { value: 'none', label: '停止', desc: '思考させません。Claude は非対応のため最小に、Gemini も近い値に調整されます。' },
  { value: 'minimal', label: '最小', desc: 'ほぼ考えません（出力の約 10%）。Claude では低に変換されます。' },
  { value: 'low', label: '低', desc: '軽く考えます（約 20%）。速さ重視。' },
  { value: 'medium', label: '中', desc: 'バランス型（約 50%）。' },
  { value: 'high', label: '高', desc: 'しっかり考えます（約 80%）。' },
  { value: 'xhigh', label: '超高', desc: 'さらに深く（約 95%）。Gemini では高に丸められます。' },
  { value: 'max', label: '最大', desc: '最も深く考えます（約 95%）。費用と待ち時間が最大になります。' },
];

const PHASES = {
  connecting: '接続中',
  searching: 'Web検索中',
  thinking: '思考中',
  writing: '生成中',
  drawing: '画像生成中',
};

/* ------------------------------ utilities ------------------------------ */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error || res.statusText);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = 'toast glass ' + kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), kind === 'err' ? 8000 : 3200);
}

function usd(n, digits) {
  if (n == null || !isFinite(n)) return '—';
  if (n === 0) return '$0';
  const d = digits ?? (n < 0.001 ? 6 : n < 0.01 ? 5 : n < 1 ? 4 : 2);
  return '$' + Number(n).toFixed(d);
}
const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('ja-JP'));
const fmtDate = (sec) => (!sec ? '—' : new Date(sec * 1000).toLocaleString('ja-JP', { hour12: false }));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderMarkdown(text) {
  const html = window.marked.parse(String(text || ''), { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

function isOn(node) {
  return node.dataset.on === 'true';
}
function setOn(node, value) {
  node.dataset.on = value ? 'true' : 'false';
}
function bindToggle(sel, onChange) {
  const node = $(sel);
  node.addEventListener('click', () => {
    if (node.disabled) return;
    setOn(node, !isOn(node));
    onChange?.(isOn(node));
  });
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ------------------------------ password KDF ---------------------------- */
async function deriveClientHash(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' }, key, 256);
  let bin = '';
  for (const b of new Uint8Array(bits)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* ================================ LOGIN ================================= */
function showLoginStep(step) {
  for (const id of ['login-form', 'mfa-form', 'recovery-form', 'enroll-form', 'recovery-codes-box']) {
    $('#' + id).hidden = id !== step;
  }
  $('#login-error').hidden = true;
}
function loginError(message) {
  const node = $('#login-error');
  node.textContent = message;
  node.hidden = false;
}
function busy(form, on, label) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label || '処理中…';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  busy(e.target, true, '認証中…');
  try {
    const pre = await api('/api/auth/prelogin', { method: 'POST', body: JSON.stringify({ email }) });
    const clientHash = await deriveClientHash(password, pre.salt, pre.iterations);
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, clientHash }) });
    $('#login-password').value = '';
    state.ticket = res.ticket;
    if (res.status === 'enroll') {
      renderQr($('#qr-box'), res.uri);
      $('#totp-secret').textContent = res.secret;
      showLoginStep('enroll-form');
      $('#enroll-code').focus();
    } else {
      showLoginStep('mfa-form');
      $('#mfa-code').focus();
    }
  } catch (err) {
    loginError(err.message + (err.payload?.remaining != null ? '（残り ' + err.payload.remaining + ' 回でロック）' : ''));
  } finally {
    busy(e.target, false);
  }
});

function renderQr(box, uri) {
  box.innerHTML = '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch {
    box.textContent = 'QR を生成できませんでした。手動入力キーを使ってください。';
  }
}

$('#enroll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy(e.target, true);
  try {
    const res = await api('/api/auth/enroll', {
      method: 'POST',
      body: JSON.stringify({ ticket: state.ticket, code: $('#enroll-code').value }),
    });
    $('#recovery-codes').textContent = res.recoveryCodes.join('\n');
    showLoginStep('recovery-codes-box');
  } catch (err) {
    loginError(err.message);
  } finally {
    busy(e.target, false);
  }
});

$('#mfa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy(e.target, true);
  try {
    await api('/api/auth/mfa', { method: 'POST', body: JSON.stringify({ ticket: state.ticket, code: $('#mfa-code').value }) });
    await boot();
  } catch (err) {
    loginError(err.message + (err.payload?.remaining != null ? '（残り ' + err.payload.remaining + ' 回でロック）' : ''));
  } finally {
    busy(e.target, false);
  }
});

$('#recovery-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy(e.target, true);
  try {
    await api('/api/auth/recovery', { method: 'POST', body: JSON.stringify({ ticket: state.ticket, code: $('#recovery-code').value }) });
    await boot();
  } catch (err) {
    loginError(err.message);
  } finally {
    busy(e.target, false);
  }
});

$('#use-recovery').addEventListener('click', () => showLoginStep('recovery-form'));
$('#back-to-mfa').addEventListener('click', () => showLoginStep('mfa-form'));
$('#copy-recovery').addEventListener('click', () =>
  navigator.clipboard.writeText($('#recovery-codes').textContent).then(() => toast('コピーしました'))
);
$('#recovery-done').addEventListener('click', () => boot());
$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

/* ================================= BOOT ================================= */
async function boot() {
  try {
    state.me = await api('/api/auth/me');
  } catch {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    showLoginStep('login-form');
    return;
  }
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#whoami').textContent = state.me.email;
  // Whether the self-hosted model is in charge decides what the picker shows.
  state.breakthrough = await api('/api/admin/breakthrough')
    .then((bt) => !!bt.on && !!bt.endpointId)
    .catch(() => false);
  await Promise.all([loadRooms(), loadModels()]);
  const first = state.rooms[0];
  if (first) await openRoom(first.id);
  else await newRoom();
  resumeVideoJobs();
}

/* ================================ ROOMS ================================= */
async function loadRooms() {
  state.rooms = (await api('/api/rooms')).rooms;
  renderRooms();
}

function renderRooms() {
  const q = $('#room-search').value.trim().toLowerCase();
  const list = $('#room-list');
  list.innerHTML = '';
  const rooms = state.rooms.filter((r) => !q || r.title.toLowerCase().includes(q));
  if (!rooms.length) {
    list.appendChild(el('p', 'xs muted', 'ルームがありません'));
    return;
  }
  for (const room of rooms) {
    const node = el('div', 'room' + (room.id === state.roomId ? ' active' : ''));
    node.appendChild(el('div', 't', room.title));
    const meta = el('div', 'm');
    meta.appendChild(el('span', null, (room.model || '').split('/').pop() || '—'));
    meta.appendChild(el('span', null, room.messageCount + '件'));
    if (room.totalCost) meta.appendChild(el('span', null, usd(room.totalCost)));
    node.appendChild(meta);
    node.addEventListener('click', () => openRoom(room.id));
    // Double-tap a room to rename it: open it and focus the title field.
    node.addEventListener('dblclick', async () => {
      await openRoom(room.id);
      const field = $('#room-title');
      field.focus();
      field.select();
    });
    node.title = 'ダブルクリックで名前を変更';
    list.appendChild(node);
  }
}

$('#room-search').addEventListener('input', renderRooms);

async function newRoom() {
  const res = await api('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ model: state.defaults.model, provider: state.defaults.provider }),
  });
  await loadRooms();
  await openRoom(res.room.id);
  $('#input').focus();
}
$('#new-room').addEventListener('click', () => newRoom().catch((e) => toast(e.message, 'err')));

async function openRoom(id) {
  const res = await api('/api/rooms/' + id);
  state.roomId = id;
  state.room = res.room;
  state.messages = res.messages;
  state.attachments = [];
  state.effort = res.room.reasoningEffort || '';
  renderAttachments();
  renderEffort();
  $('#room-title').value = res.room.title;
  setOn($('#web-search'), (res.room.webSearchEngine || state.defaults.webSearchEngine || 'server') !== 'off');
  setOn($('#image-output'), (res.room.imageMode || state.defaults.imageMode || 'server') !== 'off');
  setModelLabel(res.room.provider, res.room.model);
  await applyCapabilities();
  renderRooms();
  renderMessages();
  closeSidebar();
}

$('#room-title').addEventListener('change', async (e) => {
  if (!state.roomId) return;
  await api('/api/rooms/' + state.roomId, { method: 'PATCH', body: JSON.stringify({ title: e.target.value }) });
  await loadRooms();
});

// The chip is the on/off end of the same setting the room-settings list edits,
// so it writes the mode itself instead of a parallel boolean.
function toolModes() {
  return {
    search: state.room?.webSearchEngine || state.defaults.webSearchEngine || 'server',
    image: state.room?.imageMode || state.defaults.imageMode || 'server',
  };
}

bindToggle('#web-search', async (on) => {
  const mode = on ? state.lastSearchMode || 'server' : 'off';
  if (!on) state.lastSearchMode = toolModes().search === 'off' ? 'server' : toolModes().search;
  if (state.room) state.room.webSearchEngine = mode;
  if (state.roomId) await api('/api/rooms/' + state.roomId, { method: 'PATCH', body: JSON.stringify({ webSearchEngine: mode }) });
  await applyCapabilities();
});
bindToggle('#image-output', async (on) => {
  const mode = on ? state.lastImageMode || 'server' : 'off';
  if (!on) state.lastImageMode = toolModes().image === 'off' ? 'server' : toolModes().image;
  if (state.room) state.room.imageMode = mode;
  if (state.roomId) await api('/api/rooms/' + state.roomId, { method: 'PATCH', body: JSON.stringify({ imageMode: mode }) });
  await applyCapabilities();
});

/**
 * What the currently selected model can actually do. OpenRouter's exa plugin
 * injects results into the prompt so web search works for every model there;
 * on Groq only the gpt-oss family (built-in browser_search) and the compound
 * systems can search.
 */
function capsOf(m) {
  if (!m) return { web: true, image: false, reasoning: false };
  return {
    web: m.provider === 'openrouter' || !!m.browserSearch || /compound/.test(m.id),
    image: (m.output || []).includes('image'),
    reasoning: !!m.reasoning,
    vision: (m.input || []).includes('image'),
  };
}

function currentModel() {
  return modelByRef((state.room?.provider || '') + ':' + (state.room?.model || ''));
}

function setChipEnabled(node, enabled, why) {
  node.disabled = !enabled;
  node.classList.toggle('disabled', !enabled);
  node.setAttribute('aria-disabled', String(!enabled));
  node.title = enabled ? node.dataset.baseTitle || '' : why;
}

/** Greys out tools the selected model does not support, and turns them off. */
async function applyCapabilities() {
  const model = currentModel();
  const c = capsOf(model);
  const name = model ? model.name : 'このモデル';

  // In "server" mode OpenRouter runs the tool itself, so even a text-only
  // model can search or draw. Only the forced modes need model support.
  const rawSearch = state.room?.webSearchEngine || state.defaults.webSearchEngine || 'server';
  const rawImage = state.room?.imageMode || state.defaults.imageMode || 'server';
  const searchMode = rawSearch === 'off' ? state.lastSearchMode || 'server' : rawSearch;
  const imageMode = rawImage === 'off' ? state.lastImageMode || 'server' : rawImage;
  const isOpenRouter = (model?.provider || state.room?.provider) === 'openrouter';
  const canSearch = isOpenRouter && searchMode === 'server' ? true : c.web;
  const canImage = isOpenRouter && imageMode === 'server' ? true : c.image;

  $('#web-search-label').textContent = 'Web検索' + (searchMode === 'server' ? '' : '（毎回）');
  $('#image-output-label').textContent = '画像生成' + (imageMode === 'force' ? '（強制）' : '');

  setChipEnabled($('#web-search'), canSearch, name + ' は Web 検索に対応していません');
  setChipEnabled($('#image-output'), canImage, name + ' は画像出力に対応していません（ルーム設定で「自動」にすると生成できます）');
  setChipEnabled($('#effort-btn'), c.reasoning, name + ' は推論の深さ指定に対応していません');

  const patch = {};
  if (!canSearch && isOn($('#web-search'))) {
    setOn($('#web-search'), false);
    patch.webSearch = false;
  }
  if (!canImage && isOn($('#image-output'))) {
    setOn($('#image-output'), false);
    patch.imageOutput = false;
  }
  if (!c.reasoning && state.effort) {
    state.effort = '';
    patch.reasoningEffort = '';
  }
  renderEffort();
  const readable = [];
  if (c.vision) readable.push('画像');
  if ((model?.input || []).includes('audio')) readable.push('音声');
  if ((model?.input || []).includes('video')) readable.push('動画');
  if ((model?.input || []).includes('file')) readable.push('PDF');
  $('#attach-btn').title = readable.length
    ? '添付できます（このモデルが読めるもの: ' + readable.join(' / ') + '）'
    : 'このモデルは文字しか読めません（🎙️ の文字起こしをお使いください）';
  if (state.roomId && Object.keys(patch).length) {
    await api('/api/rooms/' + state.roomId, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});
  }
}

function renderEffort() {
  const current = EFFORTS.find((e) => e.value === state.effort) || EFFORTS[0];
  $('#effort-label').textContent = '思考 ' + current.label;
  setOn($('#effort-btn'), !!state.effort);
}

// The slider runs 停止 → 最大; "自動" sits outside that axis as its own toggle.
const EFFORT_SCALE = EFFORTS.filter((e) => e.value !== '');

function renderEffortOptions() {
  const auto = !state.effort;
  const index = Math.max(0, EFFORT_SCALE.findIndex((e) => e.value === state.effort));
  const range = $('#effort-range');
  range.value = String(index);
  range.disabled = auto;
  range.style.setProperty('--fill', ((index / (EFFORT_SCALE.length - 1)) * 100).toFixed(1) + '%');
  setOn($('#effort-auto'), auto);
  $('#effort-options').innerHTML = EFFORT_SCALE.map(
    (e, i) =>
      '<button type="button" class="tick" data-effort="' + e.value + '" data-on="' +
      (!auto && i === index ? 'true' : 'false') + '">' + e.label + '</button>'
  ).join('');
  const current = auto ? EFFORTS[0] : EFFORT_SCALE[index];
  $('#effort-desc').textContent = current.desc;
}

async function setEffort(value) {
  state.effort = value;
  renderEffort();
  renderEffortOptions();
  if (state.roomId) {
    await api('/api/rooms/' + state.roomId, { method: 'PATCH', body: JSON.stringify({ reasoningEffort: value }) }).catch(() => {});
  }
}

$('#effort-btn').addEventListener('click', () => {
  if ($('#effort-btn').disabled) return;
  renderEffortOptions();
  $('#effort-modal').hidden = false;
});

// Dragging updates the label live; the room is only patched once released.
$('#effort-range').addEventListener('input', () => {
  const level = EFFORT_SCALE[Number($('#effort-range').value)] || EFFORT_SCALE[0];
  state.effort = level.value;
  renderEffort();
  renderEffortOptions();
});
$('#effort-range').addEventListener('change', () => setEffort(state.effort));

$('#effort-auto').addEventListener('click', () => setEffort(state.effort ? '' : 'medium'));

$('#effort-options').addEventListener('click', (e) => {
  const tick = e.target.closest('[data-effort]');
  if (tick) setEffort(tick.dataset.effort);
});

/* ------------------------------- sidebar -------------------------------- */
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#scrim').hidden = false;
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
}
$('#toggle-sidebar').addEventListener('click', () =>
  $('#sidebar').classList.contains('open') ? closeSidebar() : openSidebar()
);
$('#scrim').addEventListener('click', closeSidebar);

/* =============================== MESSAGES =============================== */
function iconButton(name, title, fn) {
  const b = el('button', 'icon-btn');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = icon(name, 17);
  b.addEventListener('click', fn);
  return b;
}

function buildActions(msg) {
  const acts = el('div', 'acts');
  const copy = iconButton('copy', 'コピー', () => {
    navigator.clipboard.writeText(msg.content).then(() => {
      copy.innerHTML = icon('check', 17);
      copy.classList.add('done');
      setTimeout(() => {
        copy.innerHTML = icon('copy', 17);
        copy.classList.remove('done');
      }, 1200);
    });
  });
  acts.appendChild(copy);
  if (msg.role === 'assistant') {
    acts.appendChild(iconButton('volume', '読み上げ', (e) => speak(msg.content, e.currentTarget)));
    acts.appendChild(
      iconButton('download', 'ファイルに書き出す', () => openExport(msg.content, state.room?.title))
    );
    acts.appendChild(iconButton('redo', '作り直す', () => regenerate()));
  }
  acts.appendChild(
    iconButton('trash', '削除', async () => {
      await api('/api/rooms/' + state.roomId + '/messages/' + msg.id, { method: 'DELETE' });
      state.messages = state.messages.filter((m) => m.id !== msg.id);
      renderMessages();
    })
  );
  return acts;
}

/* Generated images and video are reaped after three days, so a transcript
 * outlives its media. Say that, rather than leaving a broken icon behind. */
function withExpiry(node, label) {
  node.addEventListener('error', () => {
    const ph = el('div', 'expired-media', label + 'は保存期間（3日）を過ぎたため削除されました');
    node.replaceWith(ph);
  });
  return node;
}

function messageNode(msg) {
  const wrap = el('div', 'msg ' + msg.role);
  wrap.dataset.id = msg.id;

  if (msg.role === 'user') {
    const bubble = el('div', 'bubble');
    if (msg.content) bubble.appendChild(document.createTextNode(msg.content));
    const imgs = (msg.attachments || []).filter((a) => a.kind === 'image');
    if (imgs.length) {
      const box = el('div', 'gen-images');
      for (const img of imgs) {
        const node = document.createElement('img');
        node.src = img.url;
        node.loading = 'lazy';
        node.addEventListener('click', () => window.open(img.url, '_blank'));
        box.appendChild(withExpiry(node, '画像'));
      }
      bubble.appendChild(box);
    }
    for (const a of (msg.attachments || []).filter((x) => x.kind === 'audio')) {
      const player = document.createElement('audio');
      player.controls = true;
      player.src = a.url;
      player.style.maxWidth = '100%';
      bubble.appendChild(player);
    }
    wrap.appendChild(bubble);
    return wrap;
  }

  const who = el('div', 'who');
  who.appendChild(el('span', 'dot'));
  who.appendChild(el('span', null, msg.model ? msg.model.split('/').pop() : 'assistant'));
  who.appendChild(el('span', null, fmtDate(msg.createdAt)));
  wrap.appendChild(who);

  for (const notice of msg.meta?.notices || []) {
    const n = el('div', 'notice');
    n.innerHTML = '<i>' + icon('warning', 15) + '</i>';
    n.appendChild(el('span', null, notice));
    wrap.appendChild(n);
  }

  if (msg.reasoning) {
    const det = el('details', 'think');
    det.appendChild(el('summary', null, '思考プロセスを表示'));
    det.appendChild(el('div', 'peek', msg.reasoning));
    wrap.appendChild(det);
  }

  if (msg.content) {
    const body = el('div', 'body');
    body.innerHTML = renderMarkdown(msg.content);
    wrap.appendChild(body);
    attachArtifactButtons(body, msg);
    attachExportButtons(body, msg);
  }

  for (const v of (msg.attachments || []).filter((a) => a.kind === 'video')) {
    const player = document.createElement('video');
    player.controls = true;
    player.playsInline = true;
    player.preload = 'metadata';
    player.src = v.url;
    wrap.appendChild(withExpiry(player, '動画'));
  }

  const images = (msg.attachments || []).filter((a) => a.kind === 'image');
  if (images.length) {
    const box = el('div', 'gen-images');
    for (const img of images) {
      const node = document.createElement('img');
      node.src = img.url;
      node.loading = 'lazy';
      node.addEventListener('click', () => window.open(img.url, '_blank'));
      box.appendChild(withExpiry(node, '画像'));
    }
    wrap.appendChild(box);
  }

  const cites = (msg.annotations || []).filter((a) => a.type === 'url_citation' && a.url_citation);
  if (cites.length) {
    const box = el('div', 'cites');
    const head = el('span', 'h');
    head.innerHTML = icon('link', 13);
    head.appendChild(el('span', null, '参照した ' + cites.length + ' 件の Web ページ'));
    box.appendChild(head);
    cites.forEach((a, i) => {
      const link = document.createElement('a');
      link.href = a.url_citation.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '[' + (i + 1) + '] ' + (a.url_citation.title || a.url_citation.url);
      box.appendChild(link);
    });
    wrap.appendChild(box);
  }

  if (msg.error) {
    const err = el('div', 'msg-err');
    err.innerHTML = '<i>' + icon('warning', 15) + '</i>';
    err.appendChild(el('span', null, msg.error));
    wrap.appendChild(err);
  }

  const foot = el('div', 'foot');
  if (msg.promptTokens || msg.cost != null) {
    foot.appendChild(
      el(
        'span',
        null,
        '入力 ' + fmtInt(msg.promptTokens) + ' / 出力 ' + fmtInt(msg.completionTokens) + ' tok' +
          (msg.cost != null ? ' · ' + usd(msg.cost) : '')
      )
    );
  }
  foot.appendChild(buildActions(msg));
  wrap.appendChild(foot);
  return wrap;
}

function nearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 160;
}
function scrollToBottom(force) {
  const box = $('#messages');
  if (force || nearBottom()) box.scrollTop = box.scrollHeight;
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  if (!state.messages.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('h2', null, 'なんでも聞いてください'));
    empty.appendChild(el('p', null, '上のモデル名をタップすると GPT・Claude・Gemini・Qwen・Kimi・GLM などに切り替えられます。会話の途中で変えても履歴は引き継がれます。'));
    empty.appendChild(el('p', 'xs', 'Web検索 / 画像生成 / 思考の深さ は入力欄の上のボタンから。'));
    box.appendChild(empty);
    return;
  }
  for (const msg of state.messages) box.appendChild(messageNode(msg));
  scrollToBottom(true);
}

/* ============================== ATTACHMENTS ============================= */
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  for (const att of state.attachments) {
    const chip = el('span', 'att');
    if (att.kind === 'image') {
      const img = document.createElement('img');
      img.src = att.url;
      chip.appendChild(img);
    } else {
      const badge = el('span');
      badge.innerHTML = icon('file', 16);
      chip.appendChild(badge);
    }
    chip.appendChild(el('span', null, att.name.length > 24 ? att.name.slice(0, 22) + '…' : att.name));
    const x = el('button');
    x.type = 'button';
    x.setAttribute('aria-label', '削除');
    x.innerHTML = icon('close', 14);
    x.addEventListener('click', () => {
      state.attachments = state.attachments.filter((a) => a.id !== att.id);
      renderAttachments();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

$('#attach-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    if (state.roomId) fd.append('roomId', state.roomId);
    try {
      state.attachments.push(await api('/api/files', { method: 'POST', body: fd }));
      renderAttachments();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
});

/* ============================ VOICE (ASR/TTS) =========================== */
let recorder = null;
let recordedChunks = [];
let recTimer = null;
let asrBlob = null;

$('#voice-btn').addEventListener('click', () => {
  const sel = $('#asr-model');
  const models = state.catalog.filter((m) => m.kind === 'asr');
  sel.innerHTML = (models.length ? models : [{ id: state.defaults.asrModel || 'whisper-large-v3-turbo' }])
    .map((m) => '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>')
    .join('');
  if (state.defaults.asrModel) sel.value = state.defaults.asrModel;
  $('#asr-status').textContent = '';
  $('#asr-result').hidden = true;
  $('#asr-insert').hidden = true;
  refreshTtsModels();
  $('#voice-modal').hidden = false;
});

$$('#asr-source .seg-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('#asr-source .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const isMic = btn.dataset.src === 'mic';
    $('#asr-mic').hidden = !isMic;
    $('#asr-file').hidden = isMic;
    asrBlob = null;
    $('#asr-run').disabled = true;
    $('#asr-file-label').textContent = '音声ファイルを選択（最大 20MB）';
  })
);

$('#asr-drop').addEventListener('click', () => $('#asr-file-input').click());
$('#asr-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return toast('ファイルが大きすぎます（上限 20MB）', 'err');
  asrBlob = file;
  $('#asr-file-label').textContent = file.name + '（' + (file.size / 1048576).toFixed(1) + ' MB）';
  $('#asr-run').disabled = false;
});

$('#asr-record').addEventListener('click', async () => {
  const btn = $('#asr-record');
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && recordedChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      btn.innerHTML = icon('mic', 18) + '録音を開始';
      btn.classList.remove('rec');
      asrBlob = new Blob(recordedChunks, { type: recorder.mimeType || 'audio/webm' });
      $('#asr-timer').textContent = '録音済み（' + (asrBlob.size / 1024).toFixed(0) + ' KB）';
      $('#asr-run').disabled = false;
    };
    recorder.start();
    const t0 = Date.now();
    recTimer = setInterval(() => {
      $('#asr-timer').textContent = '録音中 ' + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒';
    }, 200);
    btn.innerHTML = icon('stop', 18) + '停止';
    btn.classList.add('rec');
  } catch (err) {
    toast('マイクを使用できません: ' + err.message, 'err');
  }
});

$('#asr-run').addEventListener('click', async () => {
  if (!asrBlob) return;
  const btn = $('#asr-run');
  btn.disabled = true;
  $('#asr-status').textContent = '文字起こし中…';
  try {
    const fd = new FormData();
    fd.append('audio', asrBlob, asrBlob.name || 'recording.webm');
    fd.append('model', $('#asr-model').value);
    if ($('#asr-language').value.trim()) fd.append('language', $('#asr-language').value.trim());
    if (state.roomId) fd.append('roomId', state.roomId);
    const res = await api('/api/asr', { method: 'POST', body: fd });
    $('#asr-result').hidden = false;
    $('#asr-result').value = res.text;
    $('#asr-insert').hidden = false;
    $('#asr-status').textContent =
      '完了' + (res.seconds ? '（' + res.seconds.toFixed(1) + ' 秒 · ' + usd(res.cost) + ' · ' + res.model + '）' : '');
    if ($('#asr-attach').checked) {
      const up = new FormData();
      up.append('file', asrBlob, asrBlob.name || 'recording.webm');
      if (state.roomId) up.append('roomId', state.roomId);
      state.attachments.push(await api('/api/files', { method: 'POST', body: up }));
      renderAttachments();
    }
  } catch (err) {
    $('#asr-status').textContent = '';
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('#asr-insert').addEventListener('click', () => {
  const input = $('#input');
  input.value = (input.value ? input.value + '\n' : '') + $('#asr-result').value;
  autoGrow(input);
  $('#voice-modal').hidden = true;
  input.focus();
});

async function speak(text, btn) {
  const original = btn.innerHTML;
  btn.classList.add('busy');
  try {
    const prefs = ttsPrefs();
    if (prefs.model === 'browser') {
      speakInBrowser(text, prefs.voice);
      return;
    }
    const res = await api('/api/tts', {
      method: 'POST',
      body: JSON.stringify({ text: text.slice(0, 4000), roomId: state.roomId, model: prefs.model, voice: prefs.voice }),
    });
    await new Audio(res.url).play();
    toast('読み上げ ' + res.chars + '文字' + (res.cost ? ' · ' + usd(res.cost) : ''));
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.innerHTML = original;
    btn.classList.remove('busy');
  }
}

/* ================================ CHAT ================================== */
function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = Math.min(node.scrollHeight, window.innerHeight * 0.4) + 'px';
}
$('#input').addEventListener('input', (e) => autoGrow(e.target));
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 860) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if (!text && !state.attachments.length) return;
  send({ content: text, attachments: state.attachments });
});
$('#stop-btn').addEventListener('click', () => state.controller?.abort());

function regenerate() {
  if (!state.streaming) send({ regenerate: true });
}

/** Live view of the in-flight assistant turn. */
function createStreamView(model) {
  const wrap = el('div', 'msg assistant');
  wrap.dataset.id = 'streaming';

  const who = el('div', 'who');
  who.appendChild(el('span', 'dot'));
  const modelName = el('span', null, model ? model.split('/').pop() : '');
  who.appendChild(modelName);
  wrap.appendChild(who);

  const status = el('div', 'status');
  const dots = el('div', 'dots');
  dots.innerHTML = '<i></i><i></i><i></i>';
  status.appendChild(dots);
  const phase = el('span', null, PHASES.connecting);
  status.appendChild(phase);
  const elapsed = el('span', 'el', '0.0s');
  status.appendChild(elapsed);
  wrap.appendChild(status);

  const think = el('details', 'think');
  think.hidden = true;
  think.appendChild(el('summary', null, '思考プロセス'));
  const peek = el('div', 'peek');
  think.appendChild(peek);
  wrap.appendChild(think);

  const body = el('div', 'body');
  wrap.appendChild(body);

  const t0 = Date.now();
  const timer = setInterval(() => {
    elapsed.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  }, 100);
  const view = {};

  let current = 'connecting';
  let stickyUntil = 0;
  let pending = null;
  // Groq flips between searching/thinking many times a second; hold a phase
  // for a moment so the label reads as progress rather than flicker.
  const applyPhase = (p) => {
    current = p;
    phase.textContent = PHASES[p] || p;
    stickyUntil = Date.now() + (p === 'searching' ? 1800 : 600);
  };

  return Object.assign(view, {
    node: wrap,
    setModel: (m) => (modelName.textContent = m ? m.split('/').pop() : ''),
    setPhase: (p) => {
      if (p === current) return;
      const wait = stickyUntil - Date.now();
      if (wait > 0) {
        pending = p;
        clearTimeout(view.phaseTimer);
        view.phaseTimer = setTimeout(() => {
          if (pending && pending !== current) applyPhase(pending);
        }, wait);
        return;
      }
      applyPhase(p);
    },
    addReasoning: (t) => {
      think.hidden = false;
      peek.textContent += t;
      if (!think.open) peek.scrollTop = peek.scrollHeight;
    },
    setBody: (html) => (body.innerHTML = html),
    stop: () => {
      clearInterval(timer);
      clearTimeout(view.phaseTimer);
      status.remove();
      if (peek.textContent) think.querySelector('summary').textContent = '思考プロセスを表示';
      else think.hidden = true;
    },
  });
}

async function send({ content = '', attachments = [], regenerate = false }) {
  if (state.streaming) return;
  state.streaming = true;
  $('#send-btn').hidden = true;
  $('#stop-btn').hidden = false;
  $('#progress').hidden = false;

  const box = $('#messages');
  if (!state.messages.length) box.innerHTML = '';

  if (!regenerate) {
    const userMsg = {
      id: 'tmp_' + Date.now(),
      role: 'user',
      content,
      attachments,
      createdAt: Math.floor(Date.now() / 1000),
    };
    state.messages.push(userMsg);
    const userNode = messageNode(userMsg);
    userNode.classList.add('enter');
    box.appendChild(userNode);
    $('#input').value = '';
    autoGrow($('#input'));
    state.attachments = [];
    renderAttachments();
  } else {
    const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
    if (last) {
      state.messages = state.messages.filter((m) => m.id !== last.id);
      box.querySelector('[data-id="' + last.id + '"]')?.remove();
    }
  }

  const view = createStreamView(state.room?.model);
  view.node.classList.add('enter');
  box.appendChild(view.node);
  scrollToBottom(true);

  const payload = {
    roomId: state.roomId,
    content,
    attachments,
    provider: state.room?.provider,
    model: state.room?.model,
    webSearchEngine: isOn($('#web-search')) ? (toolModes().search === 'off' ? 'server' : toolModes().search) : 'off',
    imageMode: isOn($('#image-output')) ? (toolModes().image === 'off' ? 'server' : toolModes().image) : 'off',
    reasoning: state.effort,
    regenerate,
  };

  state.controller = new AbortController();
  let text = '';
  let aborted = false;
  let metaNotices = [];
  let streamError = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'HTTP ' + res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const p = JSON.parse(data);
        if (event === 'meta') {
          metaNotices = p.notices || [];
          view.setModel(p.model);
          if (!state.roomId) state.roomId = p.roomId;
          if (p.title && p.title !== $('#room-title').value) {
            $('#room-title').value = p.title;
            if (state.room) state.room.title = p.title;
          }
          if (p.notices?.length) toast(p.notices.join(' / '));
        } else if (event === 'status') {
          view.setPhase(p.phase);
        } else if (event === 'delta') {
          text += p.text;
          view.setBody(renderMarkdown(text) + '<span class="caret"></span>');
          scrollToBottom();
        } else if (event === 'reasoning') {
          view.addReasoning(p.text);
          scrollToBottom();
        } else if (event === 'error') {
          // The message itself renders the error; a toast on top would just
          // cover the thread.
          streamError = p.message;
        } else if (event === 'done') {
          const extra = (p.notices || []).filter((n) => !metaNotices.includes(n));
          if (extra.length) toast(extra.join(' / '), 'err');
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      aborted = true;
    } else if (!streamError) {
      toast(err.message, 'err');
    }
  } finally {
    view.stop();
    state.streaming = false;
    state.controller = null;
    $('#send-btn').hidden = false;
    $('#stop-btn').hidden = true;
    $('#progress').hidden = true;
    if (state.roomId) {
      try {
        const res = await api('/api/rooms/' + state.roomId);
        state.room = res.room;
        state.messages = res.messages;
        $('#room-title').value = res.room.title;
        renderMessages();
      } catch {
        /* keep what is on screen */
      }
      await loadRooms();
    }
    if (aborted) toast('停止しました。ここまでの応答は保存されています。');
  }
}

/* ============================= MODEL PICKER ============================= */
async function loadModels(force = false) {
  const res = await api('/api/models' + (force ? '?refresh=1' : ''));
  state.catalog = res.models;
  state.families = res.families;
  state.defaults = res.defaults;
  state.modelsLoadedAt = res.updatedAt;
  $('#model-family').innerHTML =
    '<option value="">全ファミリー</option>' + res.families.map((f) => '<option>' + f + '</option>').join('');
  if (res.errors?.length) toast('モデル一覧の一部を取得できませんでした: ' + res.errors.join(' / '), 'err');
  if (state.room) {
    setModelLabel(state.room.provider, state.room.model);
    await applyCapabilities();
  }
}

const modelByRef = (ref) => state.catalog.find((m) => m.ref === ref) || null;

function setModelLabel(provider, model) {
  /* Breakthrough mode overrides the room's model, so showing the room's choice
   * would be a lie: the picker is inert until it is switched off. */
  if (state.breakthrough) {
    $('#model-label').textContent = '自前GPU（ブレイクスルー）';
    $('#model-btn').title = 'ブレイクスルーモード中はモデル選択が無効です（管理コンソールで切り替えられます）';
    $('#model-btn').classList.add('breakthrough');
    return;
  }
  $('#model-btn').classList.remove('breakthrough');
  const meta = modelByRef(provider + ':' + model);
  $('#model-label').textContent = meta ? meta.name.replace(/^[^:]+:\s*/, '') : (model || '').split('/').pop() || 'モデル';
  $('#model-btn').title = (provider || '') + ' / ' + (model || '');
}

function priceLabel(m) {
  if (m.free) return '無料';
  if (!m.pricing) return '料金不明';
  if (m.pricing.kind === 'asr') return usd(m.pricing.per_hour, 3) + ' / 時間';
  if (m.pricing.kind === 'tts') return usd(m.pricing.per_million_chars, 2) + ' / 1M字';
  const i = m.pricing.input_per_m;
  const o = m.pricing.output_per_m;
  if (i == null && o == null) return '料金不明';
  if (!i && !o) return '無料';
  return usd(i, 2) + ' → ' + usd(o, 2);
}

// How the two tool-backed features are driven. "server" hands the model
// OpenRouter's server tools and lets it decide; the rest force the behaviour.
const SEARCH_MODES = [
  ['server', '自動（モデルが必要な時だけ検索）'],
  ['exa', '毎回検索（exa・$0.007/回）'],
  ['native', '毎回検索（提供元のネイティブ検索）'],
  ['auto', '毎回検索（エンジン自動選択）'],
];
const IMAGE_MODES = [
  ['server', '自動（モデルが必要な時だけ生成）'],
  ['force', '強制（毎回画像を出力・対応モデルのみ）'],
];

const IN_MODALITIES = [
  ['image', 'image', '画像を読める'],
  ['audio', 'mic', '音声を読める'],
  ['video', 'video', '動画を読める'],
  ['file', 'file', 'PDF などのファイルを読める'],
];

/** Compact "what this model can take and produce" strip. */
function modalityBadges(m) {
  const box = el('span', 'caps');
  const inputs = m.input || ['text'];
  const outputs = m.output || ['text'];
  const chunks = [];

  const ins = IN_MODALITIES.filter(([key]) => inputs.includes(key));
  chunks.push(
    '<span class="cap-group" title="入力できるもの"><b>入</b>' +
      (ins.length ? ins.map(([, ic, label]) => '<i title="' + label + '">' + icon(ic, 13) + '</i>').join('') : '<em>文字のみ</em>') +
      '</span>'
  );
  if (outputs.includes('image')) {
    chunks.push('<span class="cap-group" title="画像を生成できる"><b>出</b><i>' + icon('image', 13) + '</i></span>');
  }
  const extra = [];
  if (m.reasoning) extra.push('<i title="推論の深さを指定できる">' + icon('spark', 13) + '</i>');
  if (m.tools || m.browserSearch) extra.push('<i title="ツール / Web検索が使える">' + icon('globe', 13) + '</i>');
  if (extra.length) chunks.push('<span class="cap-group">' + extra.join('') + '</span>');

  box.innerHTML = chunks.join('');
  return box;
}

function renderModelList() {
  const q = $('#model-search').value.trim().toLowerCase();
  const provider = $('#model-provider').value;
  const family = $('#model-family').value;
  const list = state.catalog
    .filter((m) => m.kind === 'chat')
    .filter((m) => !provider || m.provider === provider)
    .filter((m) => !family || m.family === family)
    .filter((m) => !isOn($('#filter-free')) || m.free)
    .filter((m) => !isOn($('#filter-vision')) || (m.input || []).includes('image'))
    .filter((m) => !isOn($('#filter-audio')) || (m.input || []).includes('audio'))
    .filter((m) => !isOn($('#filter-imageout')) || (m.output || []).includes('image'))
    .filter((m) => !isOn($('#filter-tools')) || m.tools)
    .filter((m) => !q || (m.id + ' ' + m.name).toLowerCase().includes(q));

  const order = { Claude: 0, GPT: 1, Gemini: 2, Qwen: 3, Kimi: 4, GLM: 5 };
  list.sort((a, b) => (order[a.family] ?? 9) - (order[b.family] ?? 9) || (b.created || 0) - (a.created || 0));

  const box = $('#model-list');
  box.innerHTML = '';
  const current = (state.room?.provider || '') + ':' + (state.room?.model || '');
  for (const m of list.slice(0, 400)) {
    const row = el('div', 'model-row' + (m.ref === current ? ' active' : ''));
    const left = el('div');
    left.appendChild(el('div', 'name', m.name));
    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'tag', m.provider === 'groq' ? 'Groq' : 'OR'));
    if (m.free) {
      const freeTag = el('span', 'tag free', '無料');
      freeTag.title = 'OpenRouter の無料枠（レート制限あり）';
      meta.appendChild(freeTag);
    }
    meta.appendChild(el('span', null, m.id));
    if (m.context) meta.appendChild(el('span', null, Math.round(m.context / 1000) + 'K'));
    if (m.pricing?.web_search > 0) {
      const ws = el('span', 'tag', '検索 ' + usd(m.pricing.web_search, 3) + '/回');
      ws.title = 'このモデルはネイティブ Web 検索に対応し、1 リクエストあたりこの料金が別途かかります';
      meta.appendChild(ws);
    }
    meta.appendChild(modalityBadges(m));
    left.appendChild(meta);
    row.appendChild(left);
    row.appendChild(el('div', 'price', priceLabel(m)));
    row.addEventListener('click', async () => {
      if (state.roomId) {
        await api('/api/rooms/' + state.roomId, { method: 'PATCH', body: JSON.stringify({ provider: m.provider, model: m.id }) });
        state.room.provider = m.provider;
        state.room.model = m.id;
      }
      setModelLabel(m.provider, m.id);
      await applyCapabilities();
      $('#model-modal').hidden = true;
      renderRooms();
      toast(m.name + ' に切り替えました');
    });
    box.appendChild(row);
  }
  $('#model-foot').innerHTML =
    list.length + ' / ' + state.catalog.length + ' 件 · 単価は 入力 → 出力（$/1M tok）<br>' +
    '<span class="legend"><b>入</b> 読める形式 ' +
    IN_MODALITIES.map(([, ic, label]) => '<i title="' + label + '">' + icon(ic, 12) + '</i>').join('') +
    ' ／ <b>出</b> 画像生成 ／ ' + icon('spark', 12) + ' 推論 ／ ' + icon('globe', 12) + ' ツール</span>';
}

$('#model-btn').addEventListener('click', () => {
  $('#model-modal').hidden = false;
  renderModelList();
});
['#model-search', '#model-provider', '#model-family'].forEach((sel) => $(sel).addEventListener('input', renderModelList));
['#filter-free', '#filter-vision', '#filter-audio', '#filter-imageout', '#filter-tools'].forEach((sel) =>
  bindToggle(sel, renderModelList)
);
$('#refresh-models').addEventListener('click', async () => {
  await loadModels(true);
  renderModelList();
  toast('再取得しました');
});

/* ============================== ROOM SETTINGS =========================== */
$('#room-settings-btn').addEventListener('click', () => {
  if (!state.roomId) return;
  const room = state.room;
  const ss = room.searchSettings || {};
  const engines = SEARCH_MODES;
  $('#room-modal-body').innerHTML =
    '<div class="stack">' +
    '<label class="field"><span>システムプロンプト</span><textarea id="rs-system" rows="5">' +
    esc(room.systemPrompt || '') +
    '</textarea></label>' +
    '<div class="grid2">' +
    '<label class="field"><span>Web検索の動かし方</span><select id="rs-engine">' +
    engines
      .map(
        (e) =>
          '<option value="' + e[0] + '"' + ((room.webSearchEngine || state.defaults.webSearchEngine) === e[0] ? ' selected' : '') +
          '>' + e[1] + '</option>'
      )
      .join('') +
    '</select></label>' +
    '<label class="field"><span>画像生成の動かし方</span><select id="rs-image-mode">' +
    IMAGE_MODES.map(
      (m) =>
        '<option value="' + m[0] + '"' + ((room.imageMode || state.defaults.imageMode || 'server') === m[0] ? ' selected' : '') +
        '>' + m[1] + '</option>'
    ).join('') +
    '</select></label>' +
    '<label class="field"><span>Temperature</span><input id="rs-temp" type="number" step="0.1" min="0" max="2" placeholder="モデル既定" value="' +
    (room.temperature ?? '') + '"></label>' +
    '<label class="field"><span>最大出力トークン</span><input id="rs-max" type="number" min="256" step="256" placeholder="モデル既定（上限なし）" value="' +
    (room.maxTokens ?? '') + '"></label>' +
    '</div>' +
    '<label class="field"><span>ルーム名</span><div class="row"><input id="rs-title" class="input sm" value="' +
    esc(room.title) + '"><button class="btn" id="rs-ai-title" title="会話内容から AI が命名">✨ AI 命名</button></div></label>' +
    '<details class="fold"><summary class="sm">Groq の検索設定（compound 系のみ）</summary>' +
    '<div class="stack" style="margin-top:12px">' +
    '<label class="toggle-row"><input type="checkbox" id="rs-snippet"' + (ss.snippetOnly ? ' checked' : '') +
    '><span class="sm">ページ本文を取得しない（検索スニペットのみ／トークン節約）</span></label>' +
    '<label class="field"><span>検索対象ドメイン（カンマ区切り・ワイルドカード可）</span>' +
    '<input id="rs-include" class="input sm" placeholder="*.go.jp, nature.com" value="' + esc((ss.includeDomains || []).join(', ')) + '"></label>' +
    '<label class="field"><span>除外ドメイン</span>' +
    '<input id="rs-exclude" class="input sm" placeholder="*.blogspot.com" value="' + esc((ss.excludeDomains || []).join(', ')) + '"></label>' +
    '<label class="field"><span>優先する国</span>' +
    '<input id="rs-country" class="input sm" placeholder="japan" value="' + esc(ss.country || '') + '"></label>' +
    '<p class="xs muted">gpt-oss の browser_search にはこれらの指定は効きません。検索量を抑えるには「思考」を低くしてください（Groq 公式の推奨）。</p>' +
    '</div></details>' +
    '<div class="row" style="flex-wrap:wrap"><button class="btn primary" id="rs-save">保存</button>' +
    '<a class="btn" href="/api/rooms/' + room.id + '/export">エクスポート</a>' +
    '<button class="btn" id="rs-clear">履歴を消去</button>' +
    '<button class="btn danger" id="rs-delete">ルームを削除</button></div>' +
    '<p class="xs muted">合計コスト ' + usd(room.totalCost) + ' · 作成 ' + fmtDate(room.createdAt) + '</p>' +
    '</div>';
  $('#room-modal').hidden = false;

  $('#rs-save').addEventListener('click', async () => {
    await api('/api/rooms/' + room.id, {
      method: 'PATCH',
      body: JSON.stringify({
        title: $('#rs-title').value.trim() || room.title,
        systemPrompt: $('#rs-system').value,
        temperature: $('#rs-temp').value.trim() === '' ? null : Number($('#rs-temp').value),
        maxTokens: $('#rs-max').value.trim() === '' ? null : Number($('#rs-max').value),
        webSearchEngine: $('#rs-engine').value,
        imageMode: $('#rs-image-mode').value,
        searchSettings: {
          snippetOnly: $('#rs-snippet').checked,
          includeDomains: $('#rs-include').value.split(',').map((x) => x.trim()).filter(Boolean),
          excludeDomains: $('#rs-exclude').value.split(',').map((x) => x.trim()).filter(Boolean),
          country: $('#rs-country').value.trim(),
        },
      }),
    });
    $('#room-modal').hidden = true;
    await loadRooms();
    await openRoom(room.id);
    toast('保存しました');
  });
  $('#rs-ai-title').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const res = await api('/api/title', { method: 'POST', body: JSON.stringify({ roomId: room.id }) });
      $('#rs-title').value = res.title;
      $('#room-title').value = res.title;
      await loadRooms();
      toast('「' + res.title + '」に変更しました');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ AI 命名';
    }
  });
  $('#rs-clear').addEventListener('click', async () => {
    if (!confirm('このルームのメッセージをすべて削除します。よろしいですか？')) return;
    await api('/api/rooms/' + room.id + '/clear', { method: 'POST' });
    $('#room-modal').hidden = true;
    await openRoom(room.id);
  });
  $('#rs-delete').addEventListener('click', async () => {
    if (!confirm('このルームを削除します。よろしいですか？')) return;
    await api('/api/rooms/' + room.id, { method: 'DELETE' });
    $('#room-modal').hidden = true;
    state.roomId = null;
    await loadRooms();
    if (state.rooms[0]) await openRoom(state.rooms[0].id);
    else await newRoom();
  });
});

/* ================================ PRICING =============================== */
$('#open-pricing').addEventListener('click', async () => {
  closeSidebar();
  $('#pricing-modal').hidden = false;
  const body = $('#pricing-body');
  body.innerHTML = '<p class="muted sm">読み込み中…</p>';
  try {
    renderPricing(body, await api('/api/pricing'));
  } catch (e) {
    body.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
});

const RES_DIMS = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] };

/** Human label for whichever billing shape the provider uses. */
function billingLabel(rates) {
  const seconds = Object.values(rates?.perSecond || {});
  if (seconds.length) {
    const lo = Math.min(...seconds);
    const hi = Math.max(...seconds);
    return lo === hi ? usd(lo, 3) + ' / 秒' : usd(lo, 3) + '〜' + usd(hi, 3) + ' / 秒';
  }
  const tokens = Object.values(rates?.perToken || {});
  if (tokens.length) return usd(Math.max(...tokens) * 1e6, 2) + ' / 1M video tok';
  if (rates?.extra?.megapixelSecond) return usd(rates.extra.megapixelSecond, 3) + ' / MP·秒';
  return '—';
}

function videoPricingCard(data) {
  const models = data.videoModels || [];
  if (!models.length) return '';
  return (
    '<div class="card"><h3>動画モデル（' + models.length + '）</h3><div class="scroll-x"><table class="data"><thead><tr>' +
    '<th>モデル</th><th>解像度</th><th>尺（秒）</th><th>音声</th><th>秒あたり</th><th>課金方式</th><th>1本あたりの例</th>' +
    '</tr></thead><tbody>' +
    models
      .map((m) => {
        const durs = m.durations || [];
        const ex = m.example;
        const extra = [];
        if (m.rates?.extra?.minimum) extra.push('最低 ' + usd(m.rates.extra.minimum, 2));
        if (m.rates?.extra?.referenceImage) extra.push('参照画像 ' + usd(m.rates.extra.referenceImage, 2) + '/枚');
        if (m.rates?.extra?.imageInput) extra.push('画像入力 ' + usd(m.rates.extra.imageInput, 2) + '/枚');
        return (
          '<tr><td>' + esc(m.id) + '</td><td>' + esc((m.resolutions || []).join(' / ') || '—') + '</td>' +
          '<td>' + (durs.length ? durs[0] + '〜' + durs[durs.length - 1] : '—') + '</td>' +
          '<td>' + (m.generateAudio ? '○' : '—') + '</td>' +
          '<td class="num">' + (m.perSecond
            ? usd(m.perSecond.cost, 4) +
              '<br><span class="xs muted">' + m.perSecond.resolution +
              (m.discount ? ' ・' + Math.round(m.discount * 100) + '%OFF（定価 ' + usd(m.perSecond.list, 4) + '）' : '') +
              '</span>'
            : '—') + '</td>' +
          '<td class="num">' + billingLabel(m.rates) +
          (extra.length ? '<br><span class="xs muted">' + extra.join(' / ') + '</span>' : '') + '</td>' +
          '<td class="num">' + (ex ? ex.resolution + '/' + ex.duration + '秒 ' + usd(ex.cost, 3) : '—') + '</td></tr>'
        );
      })
      .join('') +
    '</tbody></table></div>' +
    '<p class="xs muted">課金方式はモデルごとに異なります（秒課金 / video トークン / メガピクセル秒）。' +
    '「秒あたり」は表示中の解像度で 1 秒分に換算した比較用の数値で、トークン課金は 24fps 換算です。' +
    '実施中のキャンペーン割引は反映済みで、定価は括弧内に併記します。</p></div>'
  );
}

function speechPricingCard(data, live) {
  const rows = new Map();
  for (const m of live) {
    rows.set(m.id, { id: m.id, provider: m.provider, kind: m.kind, label: priceLabel(m) });
  }
  // The live Groq listing does not always include speech models, so the
  // maintained table fills the gaps.
  for (const m of data.groq.speech || []) {
    if (rows.has(m.id)) continue;
    const label =
      m.kind === 'asr' ? usd(m.per_hour, 3) + ' / 時間' : usd(m.per_million_chars, 2) + ' / 1M字';
    rows.set(m.id, { id: m.id, provider: 'groq', kind: m.kind, label });
  }
  const list = [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return (
    '<div class="card"><h3>音声モデル（文字起こし / 読み上げ）</h3><div class="scroll-x"><table class="data"><thead><tr>' +
    '<th>モデル</th><th>提供</th><th>種別</th><th>料金</th></tr></thead><tbody>' +
    list
      .map(
        (m) =>
          '<tr><td>' + esc(m.id) + '</td><td>' + m.provider + '</td><td>' +
          (m.kind === 'asr' ? '文字起こし' : m.kind === 'tts' ? '読み上げ' : m.kind) +
          '</td><td class="num">' + esc(m.label) + '</td></tr>'
      )
      .join('') +
    '</tbody></table></div>' +
    '<p class="xs muted">読み上げは 1 リクエスト 200 文字が上限のため、長文は自動で分割して合成します（料金は文字数に比例）。</p></div>'
  );
}

function renderPricing(body, data) {
  const tools = data.tools;
  const chat = data.models.filter((m) => m.kind === 'chat');
  const speech = data.models.filter((m) => m.kind !== 'chat');

  body.innerHTML =
    '<div class="card"><h3>Web 検索ツールの料金</h3><div class="kv">' +
    '<dt>' + esc(tools.web_plugin_exa.label) + '</dt><dd><strong>' + usd(tools.web_plugin_exa.price_per_request, 3) +
    ' / リクエスト</strong>（' + tools.web_plugin_exa.included_results + ' 件まで込み、以降 1 件 ' +
    usd(tools.web_plugin_exa.price_per_extra_result, 3) + '）<br><span class="xs muted">' +
    esc(tools.web_plugin_exa.note) + '</span></dd>' +
    '<dt>' + esc(tools.web_native.label) + '</dt><dd><span class="xs muted">' + esc(tools.web_native.note) + '</span></dd>' +
    Object.values(data.groq.tools || {})
      .map((t) => '<dt>' + esc(t.label) + '</dt><dd>' + esc(t.price || '—') + '<br><span class="xs muted">' + esc(t.note || '') + '</span></dd>')
      .join('') +
    '</div><p class="xs muted">出典: <a href="' + tools.source + '" target="_blank" rel="noopener">OpenRouter Docs</a>（' +
    tools.as_of + '） / <a href="' + data.groq.source + '" target="_blank" rel="noopener">Groq Pricing</a>（' +
    data.groq.as_of + '）</p></div>' +
    videoPricingCard(data) +
    speechPricingCard(data, speech) +
    '<div class="card"><h3>チャットモデル（' + chat.length + '）</h3>' +
    '<div class="row" style="margin-bottom:10px"><input id="price-search" class="input sm" placeholder="検索">' +
    '<select id="price-family" class="input sm" style="max-width:170px"><option value="">全ファミリー</option>' +
    data.families.map((f) => '<option>' + f + '</option>').join('') + '</select></div>' +
    '<div class="scroll-x" id="price-table"></div>' +
    '<p class="xs muted">OpenRouter は API から自動取得（1M トークンあたり）。Groq は手動テーブル: ' +
    esc(data.groq.note || '') + '</p></div>';

  const draw = () => {
    const q = $('#price-search').value.trim().toLowerCase();
    const fam = $('#price-family').value;
    const rows = chat
      .filter((m) => !fam || m.family === fam)
      .filter((m) => !q || (m.id + ' ' + m.name).toLowerCase().includes(q))
      .sort((a, b) => (a.family + a.id).localeCompare(b.family + b.id))
      .slice(0, 600);
    $('#price-table').innerHTML =
      '<table class="data"><thead><tr><th>モデル</th><th>提供</th><th>入力 $/1M</th><th>出力 $/1M</th>' +
      '<th>キャッシュ読取</th><th>Web検索</th><th>ctx</th></tr></thead><tbody>' +
      rows
        .map((m) => {
          const p = m.pricing || {};
          return (
            '<tr><td>' + esc(m.id) + (m.free ? ' <span class="tag free">無料</span>' : '') + '</td><td>' + m.provider + '</td><td class="num">' + usd(p.input_per_m, 2) +
            '</td><td class="num">' + usd(p.output_per_m, 2) + '</td><td class="num">' +
            (p.cache_read_per_m ? usd(p.cache_read_per_m, 2) : '—') + '</td><td class="num">' +
            (p.web_search ? usd(p.web_search, 3) : '—') + '</td><td class="num">' + fmtInt(m.context) + '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table>';
  };
  $('#price-search').addEventListener('input', draw);
  $('#price-family').addEventListener('change', draw);
  draw();
}

/* ============================ ADMIN CONSOLE ============================= */
$('#open-admin').addEventListener('click', () => {
  closeSidebar();
  $('#admin-modal').hidden = false;
  showAdminTab('keys');
});
$('#admin-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  $$('#admin-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
  showAdminTab(tab.dataset.tab);
});

async function showAdminTab(name) {
  const body = $('#admin-body');
  body.innerHTML = '<p class="muted sm">読み込み中…</p>';
  try {
    if (name === 'keys') await renderKeysTab(body);
    else if (name === 'defaults') await renderDefaultsTab(body);
    else if (name === 'security') await renderSecurityTab(body);
    else if (name === 'usage') await renderUsageTab(body);
    else if (name === 'events') await renderEventsTab(body);
    else if (name === 'breakthrough') await renderBreakthroughTab(body);
    else if (name === 'groq') await renderGroqTab(body);
  } catch (e) {
    body.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

async function renderKeysTab(body) {
  const { secrets } = await api('/api/admin/secrets');
  body.innerHTML =
    '<p class="sm muted">入力したキーは AES-256-GCM で暗号化して保存されます（鍵は Worker シークレット <code>MASTER_KEY</code>）。保存後は伏せ字のみ表示され、平文を返す API はありません。</p>' +
    secrets
      .map(
        (s) =>
          '<div class="card"><h3>' + s.key + '</h3><div class="kv">' +
          '<dt>状態</dt><dd>' + (s.configured ? '<span class="ok">設定済み</span>' : '<span class="warn">未設定</span>') + '</dd>' +
          '<dt>値</dt><dd><code>' + esc(s.hint || '—') + '</code></dd>' +
          '<dt>更新</dt><dd>' + fmtDate(s.updated_at) + '</dd></div>' +
          '<div class="row" style="margin-top:12px;flex-wrap:wrap"><input class="input sm" type="password" placeholder="新しいキー" data-key-input="' +
          s.key + '" style="min-width:180px"><button class="btn primary" data-key-save="' + s.key + '">保存</button>' +
          '<button class="btn" data-key-test="' + s.key + '">接続テスト</button>' +
          '<button class="btn danger" data-key-del="' + s.key + '">削除</button></div>' +
          '<p class="xs" data-key-result="' + s.key + '"></p></div>'
      )
      .join('') +
    '<p class="xs muted">キーの取得先： ' +
    '<a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> · ' +
    '<a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> · ' +
    '<a href="https://console.x.ai" target="_blank" rel="noopener">console.x.ai</a>（X検索に使用。未設定でも他は動きます）</p>';

  $$('[data-key-save]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.keySave;
      const input = $('[data-key-input="' + key + '"]');
      if (!input.value.trim()) return toast('キーを入力してください', 'err');
      try {
        await api('/api/admin/secrets', { method: 'POST', body: JSON.stringify({ key, value: input.value.trim() }) });
        toast('保存しました');
        await showAdminTab('keys');
        await loadModels(true);
      } catch (e) {
        toast(e.message, 'err');
      }
    })
  );
  $$('[data-key-test]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.keyTest;
      const out = $('[data-key-result="' + key + '"]');
      out.textContent = 'テスト中…';
      try {
        const res = await api('/api/admin/secrets/test', { method: 'POST', body: JSON.stringify({ key }) });
        out.className = 'xs ' + (res.ok ? 'ok' : 'error');
        out.textContent = res.ok ? '✅ 接続成功 ' + JSON.stringify(res.detail || {}) : '❌ ' + res.error;
      } catch (e) {
        out.className = 'xs error';
        out.textContent = '❌ ' + e.message;
      }
    })
  );
  $$('[data-key-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm(btn.dataset.keyDel + ' を削除しますか？')) return;
      await api('/api/admin/secrets/' + btn.dataset.keyDel, { method: 'DELETE' });
      await showAdminTab('keys');
    })
  );
}

async function renderDefaultsTab(body) {
  const { settings } = await api('/api/admin/settings');
  const chatModels = state.catalog.filter((m) => m.kind === 'chat');
  body.innerHTML =
    '<div class="card"><h3>チャット</h3><div class="grid2">' +
    '<label class="field"><span>既定プロバイダ</span><select id="st-provider">' +
    ['openrouter', 'groq'].map((p) => '<option' + (settings.defaultProvider === p ? ' selected' : '') + '>' + p + '</option>').join('') +
    '</select></label>' +
    '<label class="field"><span>既定モデル</span><input id="st-model" class="input sm" list="model-datalist" value="' + esc(settings.defaultModel) + '"></label>' +
    '<label class="field"><span>Temperature</span><input id="st-temp" type="number" step="0.1" placeholder="モデル既定" value="' + (settings.temperature || '') + '"></label>' +
    '<label class="field"><span>最大出力トークン</span><input id="st-max" type="number" step="256" placeholder="モデル既定（上限なし）" value="' + (settings.maxTokens || '') + '"></label>' +
    '<label class="field"><span>履歴に含める件数</span><input id="st-history" type="number" step="1" placeholder="全件" value="' + (settings.historyLimit || '') + '"></label>' +
    '<label class="field"><span>推論の深さ（既定）</span><select id="st-effort">' +
    EFFORTS.map((e) => '<option value="' + e.value + '"' + ((settings.reasoningEffort || '') === e.value ? ' selected' : '') + '>思考 ' + e.label + '</option>').join('') +
    '</select></label></div>' +
    '<label class="field" style="margin-top:12px"><span>共通システムプロンプト</span><textarea id="st-system" rows="4">' + esc(settings.systemPrompt || '') + '</textarea></label>' +
    '<p class="xs muted" style="margin-top:10px">Temperature・最大出力トークン・履歴件数は空欄推奨です。空欄ならリクエストに含めず、モデル本来の上限で回答します（途中で切れにくくなります）。</p></div>' +
    '<div class="card"><h3>Web 検索</h3><div class="grid2">' +
    '<label class="toggle-row"><input type="checkbox" id="st-web"' + (settings.webSearchDefault ? ' checked' : '') + '><span class="sm">新規ルームで既定オン</span></label>' +
    '<label class="field"><span>Web検索の動かし方</span><select id="st-engine">' +
    SEARCH_MODES.map((e) => '<option value="' + e[0] + '"' + (settings.webSearchEngine === e[0] ? ' selected' : '') + '>' + e[1] + '</option>').join('') +
    '</select></label>' +
    '<label class="field"><span>画像生成の動かし方</span><select id="st-image-mode">' +
    IMAGE_MODES.map((m) => '<option value="' + m[0] + '"' + ((settings.imageMode || 'server') === m[0] ? ' selected' : '') + '>' + m[1] + '</option>').join('') +
    '</select></label>' +
    '<label class="field"><span>最大結果数</span><input id="st-results" type="number" min="1" max="20" value="' + settings.webSearchMaxResults + '"></label></div>' +
    '<p class="xs muted">「自動」は OpenRouter の Server Tools（beta）を渡し、モデルが必要と判断した時だけ検索・画像生成させます。' +
    'exa は毎回必ず検索するので確実ですが 1 リクエスト $0.007 が必ず発生します。native はモデル提供元の検索に任せるため、対応していないモデルでは何も検索されないことがあります。</p></div>' +
    '<div class="card"><h3>音声・画像</h3><div class="grid2">' +
    '<label class="field"><span>ASR モデル</span><input id="st-asr" class="input sm" value="' + esc(settings.asrModel) + '"></label>' +
    '<label class="field"><span>TTS モデル</span><input id="st-tts" class="input sm" value="' + esc(settings.ttsModel) + '"></label>' +
    '<label class="field"><span>TTS ボイス</span><input id="st-voice" class="input sm" value="' + esc(settings.ttsVoice) + '"></label>' +
    '<label class="field"><span>画像生成モデル</span><input id="st-image" class="input sm" value="' + esc(settings.imageModel) + '"></label>' +
    '</div></div>' +
    '<datalist id="model-datalist">' + chatModels.map((m) => '<option value="' + esc(m.id) + '">').join('') + '</datalist>' +
    '<button class="btn primary block" id="st-save">保存</button>';

  $('#st-save').addEventListener('click', async () => {
    await api('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({
        defaultProvider: $('#st-provider').value,
        defaultModel: $('#st-model').value.trim(),
        temperature: $('#st-temp').value.trim() === '' ? '' : Number($('#st-temp').value),
        maxTokens: $('#st-max').value.trim() === '' ? 0 : Number($('#st-max').value),
        historyLimit: $('#st-history').value.trim() === '' ? 0 : Number($('#st-history').value),
        reasoningEffort: $('#st-effort').value,
        systemPrompt: $('#st-system').value,
        webSearchDefault: $('#st-web').checked,
        webSearchEngine: $('#st-engine').value,
        imageMode: $('#st-image-mode').value,
        webSearchMaxResults: Number($('#st-results').value),
        asrModel: $('#st-asr').value.trim(),
        ttsModel: $('#st-tts').value.trim(),
        ttsVoice: $('#st-voice').value.trim(),
        imageModel: $('#st-image').value.trim(),
      }),
    });
    toast('保存しました');
    await loadModels();
  });
}

async function renderSecurityTab(body) {
  const data = await api('/api/admin/account');
  const a = data.account;
  body.innerHTML =
    '<div class="card"><h3>アカウント</h3><div class="kv">' +
    '<dt>メール</dt><dd>' + esc(a.email) + '</dd>' +
    '<dt>二要素認証</dt><dd>' + (a.totpEnabled ? '<span class="ok">有効</span>' : '<span class="warn">未設定</span>') + '</dd>' +
    '<dt>ログイン失敗</dt><dd>' + a.failedAttempts + ' / ' + a.maxFailedAttempts +
    (a.lockedAt ? ' <span class="error">（ロック中）</span>' : '') + '</dd>' +
    '<dt>最終ログイン</dt><dd>' + fmtDate(a.lastLoginAt) + '</dd>' +
    '<dt>リカバリコード</dt><dd>' + a.recoveryCodesLeft + ' 個</dd></div>' +
    '<button class="btn" id="sec-unlock" style="margin-top:12px">ロック解除 / 失敗回数リセット</button></div>' +
    '<div class="card"><h3>パスワード変更</h3><div class="grid2">' +
    '<label class="field"><span>現在</span><input id="pw-cur" type="password" autocomplete="current-password"></label>' +
    '<label class="field"><span>新しいパスワード</span><input id="pw-new" type="password" autocomplete="new-password"></label>' +
    '<label class="field"><span>確認</span><input id="pw-new2" type="password" autocomplete="new-password"></label></div>' +
    '<button class="btn primary" id="pw-save" style="margin-top:12px">変更する</button>' +
    '<p class="xs muted">変更するとこの端末以外のセッションは無効になります。</p></div>' +
    '<div class="card"><h3>二要素認証の再設定</h3>' +
    '<div class="row"><input id="totp-cur" class="input sm" placeholder="現在の認証コード" maxlength="6" style="max-width:190px">' +
    '<button class="btn" id="totp-reset">新しい QR を発行</button></div>' +
    '<div id="totp-reset-box" hidden style="margin-top:14px"><div class="qr" id="totp-reset-qr"></div>' +
    '<code class="secret" id="totp-reset-secret"></code>' +
    '<div class="row" style="margin-top:10px"><input id="totp-confirm-code" class="input sm" placeholder="新しいコード" maxlength="6" style="max-width:190px">' +
    '<button class="btn primary" id="totp-confirm">確定</button></div></div>' +
    '<pre class="codes" id="totp-new-codes" hidden style="margin-top:12px"></pre></div>' +
    '<div class="card"><h3>セッション（' + data.sessions.length + '）</h3><div class="scroll-x"><table class="data">' +
    '<thead><tr><th>最終アクセス</th><th>IP</th><th>UA</th><th></th></tr></thead><tbody>' +
    data.sessions
      .map(
        (s) =>
          '<tr><td>' + fmtDate(s.last_seen_at) + (s.current ? ' <span class="tag">現在</span>' : '') + '</td><td>' +
          esc(s.ip || '—') + '</td><td class="xs">' + esc((s.ua || '').slice(0, 40)) + '</td><td>' +
          (s.current ? '' : '<button class="btn" data-revoke="' + s.id + '">失効</button>') + '</td></tr>'
      )
      .join('') +
    '</tbody></table></div><button class="btn" id="revoke-all" style="margin-top:12px">他のセッションを全て失効</button></div>';

  $('#sec-unlock').addEventListener('click', async () => {
    await api('/api/admin/unlock', { method: 'POST' });
    toast('リセットしました');
    await showAdminTab('security');
  });
  $('#pw-save').addEventListener('click', async () => {
    const next = $('#pw-new').value;
    if (next !== $('#pw-new2').value) return toast('新しいパスワードが一致しません', 'err');
    if (next.length < 10) return toast('パスワードは 10 文字以上にしてください', 'err');
    try {
      await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({
          currentClientHash: await deriveClientHash($('#pw-cur').value, a.pwSalt, a.pwIterations),
          newClientHash: await deriveClientHash(next, a.pwSalt, a.pwIterations),
        }),
      });
      toast('パスワードを変更しました');
      $('#pw-cur').value = $('#pw-new').value = $('#pw-new2').value = '';
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  let resetTicket = null;
  $('#totp-reset').addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/totp/reset', { method: 'POST', body: JSON.stringify({ code: $('#totp-cur').value }) });
      resetTicket = res.ticket;
      renderQr($('#totp-reset-qr'), res.uri);
      $('#totp-reset-secret').textContent = res.secret;
      $('#totp-reset-box').hidden = false;
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#totp-confirm').addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ ticket: resetTicket, code: $('#totp-confirm-code').value }),
      });
      $('#totp-new-codes').hidden = false;
      $('#totp-new-codes').textContent = '新しいリカバリコード:\n' + res.recoveryCodes.join('\n');
      toast('再設定しました');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $$('[data-revoke]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api('/api/admin/sessions/revoke', { method: 'POST', body: JSON.stringify({ id: btn.dataset.revoke }) });
      await showAdminTab('security');
    })
  );
  $('#revoke-all').addEventListener('click', async () => {
    await api('/api/admin/sessions/revoke', { method: 'POST', body: JSON.stringify({ all: true }) });
    await showAdminTab('security');
  });
}

async function renderUsageTab(body) {
  const data = await api('/api/admin/usage?days=30');
  const stats = await api('/api/admin/stats');
  body.innerHTML =
    '<div class="card"><h3>直近 30 日</h3><div class="kv">' +
    '<dt>合計コスト</dt><dd><strong>' + usd(data.totals?.cost) + '</strong></dd>' +
    '<dt>呼び出し</dt><dd>' + fmtInt(data.totals?.calls) + ' 回</dd>' +
    '<dt>トークン</dt><dd>入力 ' + fmtInt(data.totals?.input_tokens) + ' / 出力 ' + fmtInt(data.totals?.output_tokens) + '</dd>' +
    '<dt>ルーム / 発言</dt><dd>' + fmtInt(stats.rooms) + ' / ' + fmtInt(stats.messages) + '</dd>' +
    '<dt>ファイル</dt><dd>' + fmtInt(stats.files) + ' 件 · ' + (stats.fileBytes / 1048576).toFixed(1) + ' MB</dd></div></div>' +
    '<div class="card"><h3>モデル別</h3><div class="scroll-x"><table class="data"><thead><tr>' +
    '<th>モデル</th><th>種別</th><th>回数</th><th>入力</th><th>出力</th><th>コスト</th></tr></thead><tbody>' +
    data.byModel
      .map(
        (r) =>
          '<tr><td>' + esc(r.model || '') + '</td><td>' + r.kind + '</td><td class="num">' + fmtInt(r.calls) +
          '</td><td class="num">' + fmtInt(r.input_tokens) + '</td><td class="num">' + fmtInt(r.output_tokens) +
          '</td><td class="num">' + usd(r.cost) + '</td></tr>'
      )
      .join('') +
    '</tbody></table></div></div>' +
    '<div class="card"><h3>日別</h3><div class="scroll-x"><table class="data"><thead><tr><th>日付</th><th>回数</th><th>コスト</th></tr></thead><tbody>' +
    data.byDay.map((r) => '<tr><td>' + r.day + '</td><td class="num">' + fmtInt(r.calls) + '</td><td class="num">' + usd(r.cost) + '</td></tr>').join('') +
    '</tbody></table></div></div>';
}

async function renderEventsTab(body) {
  const { events } = await api('/api/admin/events?limit=200');
  body.innerHTML =
    '<div class="scroll-x"><table class="data"><thead><tr><th>日時</th><th>種別</th><th>結果</th><th>詳細</th><th>IP</th></tr></thead><tbody>' +
    events
      .map(
        (e) =>
          '<tr><td>' + fmtDate(e.at) + '</td><td>' + esc(e.kind) + '</td><td>' +
          (e.ok ? '<span class="ok">OK</span>' : '<span class="error">NG</span>') + '</td><td class="xs">' +
          esc(e.detail || '') + '</td><td class="xs">' + esc(e.ip || '') + '</td></tr>'
      )
      .join('') +
    '</tbody></table></div>';
}

let btTimer = null;

/* Breakthrough mode: a self-hosted model on a rented GPU, plus the search it
 * needs. Provisioning takes minutes, so this polls rather than blocks. */
async function renderBreakthroughTab(body) {
  const bt = await api('/api/admin/breakthrough');
  const searchRows = bt.search.backends
    .map(
      (b) =>
        '<label class="row" style="gap:8px;align-items:flex-start;margin-bottom:8px">' +
        '<input type="radio" name="sb" value="' + b + '"' + (bt.search.backend === b ? ' checked' : '') + '>' +
        '<span><b>' + b + '</b><br><span class="xs muted">' + esc(bt.search.notes[b] || '') + '</span></span></label>'
    )
    .join('');

  body.innerHTML =
    '<div class="card"><h3>自前モデル（RunPod Serverless）</h3>' +
    '<p class="sm muted">ワーカー最小0・ボリュームなしで作るので、<b>待機中の課金はありません</b>。' +
    'エンドポイントは置いたままでも無料で、次回の起動が速くなります。</p>' +
    (bt.endpointId
      ? '<div class="kv"><dt>エンドポイント</dt><dd><code>' + esc(bt.endpointId) + '</code></dd>' +
        '<dt>モデル名</dt><dd><code>' + esc(bt.model || '') + '</code></dd>' +
        '<dt>ワーカー</dt><dd>' +
        (bt.live?.error
          ? '<span class="warn">確認できません: ' + esc(bt.live.error) + '</span>'
          : bt.live
            ? (bt.live.ready ? '<span class="ok">応答可能 ' + bt.live.ready + '台</span>' : '') +
              (bt.live.starting ? ' <span class="warn">起動中 ' + bt.live.starting + '台</span>' : '') +
              (bt.live.running ? ' 実行中 ' + bt.live.running + '台' : '') +
              (bt.live.inQueue ? ' / 待ち ' + bt.live.inQueue + '件' : '') +
              (!bt.live.ready && !bt.live.starting && !bt.live.running ? '停止中（次のリクエストで起動）' : '')
            : '—') +
        '</dd>' +
        '<dt>起動処理</dt><dd id="bt-state">' +
        (bt.warming?.error
          ? '<span class="warn">起動失敗: ' + esc(bt.warming.error) + '</span>'
          : bt.warming?.ready
            ? '<span class="ok">起動済み（' + bt.warming.seconds + '秒）</span>'
            : bt.warming?.stalled
              ? '<span class="warn">開始から ' + bt.warming.elapsed + '秒。ワーカーが動いていません — もう一度押してください</span>'
              : bt.warming
                ? '起動中… ' + bt.warming.elapsed + '秒（上のワーカー行が実際の状態です）'
                : '待機中（次のリクエストで起動します）') +
        '</dd></div>' +
        '<div class="row" style="margin-top:12px;flex-wrap:wrap">' +
        '<label class="row" style="gap:6px"><input type="checkbox" id="bt-on"' + (bt.on ? ' checked' : '') + '>' +
        '<span class="sm">チャット・エージェントでこのモデルを使う</span></label>' +
        '<button class="btn" id="bt-warm">いま起動する</button>' +
        '<button class="btn danger" id="bt-destroy">破棄</button></div>' +
        '<p class="xs muted">初回は重みの読み込みで<b>5〜10分</b>かかります。' +
        'ここで起動を済ませておくと、チャットは待たずに応答します。</p>'
      : '<div class="kv"><dt>モデル</dt><dd><code>' + esc(bt.spec.model) + '</code></dd>' +
        '<dt>GPU</dt><dd>' + esc(bt.spec.gpu) + ' / ' + esc(bt.spec.quantization.toUpperCase()) + '</dd>' +
        '<dt>イメージ</dt><dd><code>' + esc(bt.image) + '</code></dd></div>' +
        '<p class="xs muted">RunPod の API キーは「キー」タブで <code>RUNPOD_API_KEY</code> として登録してください。</p>' +
        '<button class="btn primary" id="bt-create" style="margin-top:12px">エンドポイントを作成して起動</button>') +
    '<p class="xs" id="bt-msg"></p></div>' +
    '<div class="card"><h3>ウェブ検索</h3>' +
    '<p class="sm muted">自前モデルには内蔵検索がないので、ここで選んだ方式を使います。' +
    '<b>xai 以外は生の検索結果</b>が返ります（要約する仲介モデルが入りません）。</p>' +
    searchRows +
    '<div class="field" style="margin-top:10px"><label for="bt-searxng">SearXNG の URL</label>' +
    '<input class="input" id="bt-searxng" value="' + esc(bt.search.searxngUrl || '') + '" placeholder="https://searx.example.com"></div>' +
    '<p class="xs muted"><b>このアプリは Cloudflare 上で動くので、<code>localhost</code> は使えません</b>（Worker からあなたのPCには到達できません）。' +
    '公開されている URL が必要です。手元の SearXNG を使いたい場合は hyperdev 側で設定してください。<br>' +
    'インスタンスの <code>settings.yml</code> で <code>search.formats</code> に <code>json</code> を追加しておく必要があります。</p>' +
    '<div class="row" style="justify-content:flex-end;margin-top:10px">' +
    '<button class="btn primary" id="bt-search-save">検索設定を保存</button></div></div>';

  const msg = (text, cls = 'muted') => ($('#bt-msg').innerHTML = '<span class="' + cls + '">' + esc(text) + '</span>');

  $('#bt-create')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    msg('作成中…');
    try {
      await api('/api/admin/breakthrough/provision', { method: 'POST', body: '{}' });
      pollBreakthrough(body);
    } catch (err) {
      msg(err.message, 'warn');
      e.target.disabled = false;
    }
  });

  $('#bt-warm')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    msg('起動を開始しました。数分かかります…');
    try {
      await api('/api/admin/breakthrough/warm', { method: 'POST', body: '{}' });
      pollBreakthrough(body);
    } catch (err) {
      msg(err.message, 'warn');
      e.target.disabled = false;
    }
  });

  $('#bt-destroy')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    msg('破棄中…');
    try {
      await api('/api/admin/breakthrough/destroy', { method: 'POST', body: '{}' });
      clearInterval(btTimer);
      renderBreakthroughTab(body);
    } catch (err) {
      msg(err.message, 'warn');
      e.target.disabled = false;
    }
  });

  $('#bt-on')?.addEventListener('change', async (e) => {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ breakthrough: e.target.checked }) });
    state.breakthrough = e.target.checked;
    setModelLabel(state.room?.provider, state.room?.model);
    msg(e.target.checked ? 'ブレイクスルーモードを有効にしました' : '通常のモデルに戻しました', 'ok');
  });

  $('#bt-search-save')?.addEventListener('click', async () => {
    const backend = document.querySelector('input[name="sb"]:checked')?.value || 'ollama';
    await api('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ searchBackend: backend, searxngUrl: $('#bt-searxng').value.trim() }),
    });
    msg('保存しました（' + backend + '）', 'ok');
  });

  if (bt.warming && !bt.warming.ready && !bt.warming.error) pollBreakthrough(body);
}

function pollBreakthrough(body) {
  clearInterval(btTimer);
  btTimer = setInterval(async () => {
    const bt = await api('/api/admin/breakthrough').catch(() => null);
    if (!bt) return;
    if (!bt.warming || bt.warming.ready || bt.warming.error) {
      clearInterval(btTimer);
      renderBreakthroughTab(body);
      return;
    }
    const cell = $('#bt-state');
    if (cell) cell.textContent = '起動中… ' + (bt.warming.elapsed || 0) + '秒（重みの読み込みに数分かかります）';
  }, 5000);
}

async function renderGroqTab(body) {
  const { table } = await api('/api/admin/groq-pricing');
  body.innerHTML =
    '<p class="sm muted">Groq は料金 API を公開していないため、この表を手動で更新します。編集すると料金一覧とコスト計算に即反映されます。</p>' +
    '<label class="field"><span>JSON</span><textarea id="groq-json" rows="18" style="font-family:var(--mono);font-size:12px">' +
    esc(JSON.stringify(table, null, 2)) + '</textarea></label>' +
    '<div class="row" style="margin-top:12px;flex-wrap:wrap"><button class="btn primary" id="groq-save">保存</button>' +
    '<button class="btn" id="groq-reset">初期値に戻す</button>' +
    '<a class="btn" href="' + table.source + '" target="_blank" rel="noopener">公式ページ</a></div>';
  $('#groq-save').addEventListener('click', async () => {
    try {
      await api('/api/admin/groq-pricing', { method: 'POST', body: JSON.stringify({ table: JSON.parse($('#groq-json').value) }) });
      toast('保存しました');
      await loadModels(true);
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#groq-reset').addEventListener('click', async () => {
    await api('/api/admin/groq-pricing/reset', { method: 'POST' });
    await showAdminTab('groq');
  });
}

/* ================================ sheets ================================ */
document.addEventListener('click', (e) => {
  // The click usually lands on the icon's <svg>, so match the closest button
  // rather than the exact event target.
  const closer = e.target.closest?.('[data-close]');
  const sheet = closer ? closer.closest('.sheet') : e.target.classList.contains('sheet') ? e.target : null;
  if (sheet) closeSheet(sheet);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.sheet').forEach(closeSheet);
});

function closeSheet(sheet) {
  sheet.hidden = true;
  // Stop whatever the preview was running.
  if (sheet.id === 'artifact-modal') $('#artifact-frame').removeAttribute('src');
  if (sheet.id === 'video-modal') $('#vid-result').removeAttribute('src');
}

hydrateIcons();
const featureCtx = {
  state, api, toast, el, esc, usd, openRoom, loadRooms, renderMarkdown, iconButton,
  // The recorder uploads on its own, then hands the file back to the composer.
  attachFile: (file) => {
    state.attachments.push(file);
    renderAttachments();
  },
};
initFeatures(featureCtx);
initExport(featureCtx);
initImageGen(featureCtx);
initAgent(featureCtx);
initRecorder(featureCtx);
initTts({ state, api, toast, usd });
initGestures({
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  // Only meaningful while the drawer is an overlay and nothing is on top of it.
  isEnabled: () => window.innerWidth <= 860 && !document.querySelector('.sheet:not([hidden])'),
});
boot();
