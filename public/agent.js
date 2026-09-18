/* The development sandbox panel.
 *
 * Streams the agent's steps as they happen — every command, file write and
 * screenshot — so the loop is visible rather than a spinner that eventually
 * claims success. */

import { icon } from '/icons.js';
import { imageModels } from '/imagegen.js';

let ctx = null;
let controller = null;
let agentModels = [];
let live = null;
let ticker = null;
let currentRun = null;
let runCard = null;
const $ = (sel) => document.querySelector(sel);

/* The run is shown in the main thread rather than the panel.
 *
 * The panel is a narrow sheet, and a build emits long commands, stack traces
 * and screenshots that do not fit in it. The thread is full width and already
 * knows how to render all of that, so the log element is moved into a card
 * there for the duration of the run. One element, relocated -- every caller
 * still just looks up #agent-log. */
function ensureRunCard(task) {
  const thread = $('#messages');
  if (!thread) return $('#agent-log');

  const log = $('#agent-log');
  runCard = ctx.el('div', 'msg assistant agent-run');
  const head = ctx.el('div', 'agent-run-head');
  head.innerHTML = icon('code', 14);
  head.appendChild(ctx.el('span', null, task ? '開発: ' + task : '開発'));
  head.appendChild(ctx.el('span', 'agent-run-status', ''));
  runCard.appendChild(head);
  runCard.appendChild(log);
  thread.appendChild(runCard);

  const home = $('.agent-main');
  if (home && !document.getElementById('agent-moved')) {
    const note = ctx.el('p', 'xs muted', '実行中のログはチャット画面に表示されています。');
    note.id = 'agent-moved';
    note.style.padding = '14px 16px';
    home.insertBefore(note, home.firstChild);
  }

  scrollThread();
  return log;
}

/** Status goes on both the sheet and the in-thread card. */
function setStatus(text) {
  const el = $('#agent-status');
  if (el) el.textContent = text;
  const onCard = runCard?.querySelector('.agent-run-status');
  if (onCard) onCard.textContent = text;
}

/** Collapses the finished trace so a long build does not dominate the thread. */
function finishRunCard(summary) {
  if (!runCard) return;
  const log = runCard.querySelector('.agent-log');
  if (!log) return;
  const box = document.createElement('details');
  box.className = 'agent-trace';
  const sum = document.createElement('summary');
  sum.textContent = '作業ログ（' + summary + '）';
  box.appendChild(sum);
  runCard.insertBefore(box, log);
  box.appendChild(log);
  runCard.classList.add('finished');
}

function scrollThread() {
  const thread = $('#messages');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

/** Puts the log element back in the sheet so the next run can move it again. */
function releaseRunCard() {
  document.getElementById('agent-moved')?.remove();
  if (!runCard) return;
  // The finished trace belongs to the thread now, so it keeps the element and
  // gives up the id; the sheet gets an empty one for the next run. Moving the
  // original back would tear the log the user just finished reading out of the
  // conversation.
  runCard.querySelector('.agent-log')?.removeAttribute('id');
  const home = $('.agent-main');
  if (home && !document.getElementById('agent-log')) {
    const fresh = ctx.el('div', 'agent-log');
    fresh.id = 'agent-log';
    home.insertBefore(fresh, home.firstChild);
  }
  runCard = null;
}

const TOOL_LABELS = {
  generate_image: '画像生成',
  generate_video: '動画生成',
  generate_speech: '音声生成',
  spawn_subagent: 'サブエージェント',
  load_skill: 'スキル読込',
  write_file: 'ファイル書き込み',
  read_file: 'ファイル読み込み',
  list_files: 'ファイル一覧',
  delete_file: 'ファイル削除',
  run_command: 'コマンド実行',
  start_preview: 'プレビュー起動',
  stop_preview: 'プレビュー停止',
  screenshot: 'スクリーンショット',
};

const TOOL_ICONS = {
  generate_image: 'image',
  generate_video: 'video',
  generate_speech: 'volume',
  spawn_subagent: 'spark',
  load_skill: 'doc',
  write_file: 'doc',
  read_file: 'file',
  list_files: 'file',
  delete_file: 'trash',
  run_command: 'code',
  start_preview: 'play',
  stop_preview: 'stop',
  screenshot: 'image',
};

function line(kind, head, body, { icon: iconName, url } = {}) {
  const row = ctx.el('div', 'agent-line ' + kind);
  const title = ctx.el('div', 'agent-line-head');
  if (iconName) title.innerHTML = icon(iconName, 14);
  title.appendChild(ctx.el('span', null, head));
  row.appendChild(title);
  if (body) {
    const pre = ctx.el('pre', 'agent-line-body');
    pre.textContent = body;
    row.appendChild(pre);
  }
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    row.appendChild(img);
  }
  const log = $('#agent-log');
  log.appendChild(row);
  if (runCard) scrollThread();
  else log.scrollTop = log.scrollHeight;
  return row;
}

/** Marks the newest line as in-flight and counts the seconds on it. */
function startLive(row) {
  stopLive();
  row.classList.add('running');
  const clock = ctx.el('span', 'elapsed', '0秒');
  row.querySelector('.agent-line-head').appendChild(clock);
  const body = ctx.el('pre', 'agent-line-body');
  row.appendChild(body);
  const started = Date.now();
  live = { row, body, clock, text: '' };
  ticker = setInterval(() => {
    clock.textContent = Math.round((Date.now() - started) / 1000) + '秒';
  }, 1000);
}

function stopLive() {
  clearInterval(ticker);
  ticker = null;
  if (live) {
    live.row.classList.remove('running');
    // An empty output box would just be a grey smear.
    if (!live.text.trim()) live.body.remove();
    live = null;
  }
}

/** Keeps the command shown short; the full text is in the tooltip. */
const brief = (text, n = 120) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function describe(name, args) {
  if (name === 'write_file') return args.path || '';
  if (name === 'read_file' || name === 'delete_file') return args.path || '';
  if (name === 'run_command') return brief(args.command);
  if (name === 'start_preview') return brief(args.command) + '（:' + (args.port || '?') + '）';
  if (name === 'stop_preview') return ':' + (args.port || '?');
  if (name === 'generate_image') {
    return (args.path || '') + (args.purpose ? ' [' + args.purpose + ']' : '') + '（' + brief(args.prompt, 44) + '）';
  }
  if (name === 'generate_video') {
    return (args.path || '') + (args.purpose ? ' [' + args.purpose + ']' : '') + '（' + brief(args.prompt, 40) + '）';
  }
  if (name === 'generate_speech') {
    return (args.path || '') + (args.voice ? ' / ' + args.voice : '') + '（' + brief(args.text, 40) + '）';
  }
  if (name === 'load_skill') return args.name || '';
  if (name === 'spawn_subagent') return (args.model ? args.model + ' → ' : '') + brief(args.task, 60);
  if (name === 'screenshot') return args.path || '/';
  return '';
}

/** Container disk is ephemeral, so the panel says what is actually persisted. */
function setNote(text, warn = false) {
  let node = document.getElementById('agent-note');
  if (!node) {
    node = ctx.el('p', 'xs');
    node.id = 'agent-note';
    $('#agent-files').before(node);
  }
  node.className = 'xs ' + (warn ? 'warn' : 'muted');
  node.textContent = text;
  node.hidden = !text;
}

async function refreshWorkspace() {
  try {
    const res = await ctx.api('/api/agent/files?roomId=' + encodeURIComponent(ctx.state.roomId || ''));
    const files = res.files || [];
    $('#agent-files').innerHTML = files.length
      ? files
          .map(
            (f) =>
              '<div class="agent-file-row">' +
              '<button type="button" class="agent-file" data-path="' + ctx.esc(f.path) + '">' +
              '<span class="p">' + ctx.esc(f.path) + '</span>' +
              '<span class="s xs muted">' + (f.size > 1024 ? Math.round(f.size / 1024) + 'K' : f.size) + '</span></button>' +
              '<button type="button" class="agent-dl" data-dl="' + ctx.esc(f.path) + '" title="ダウンロード">' +
              icon('download', 13) + '</button></div>'
          )
          .join('')
      : '<p class="xs muted">まだファイルはありません</p>';

    if (res.restored?.restored) {
      setNote('前回の作業を復元しました（' + res.restored.files + ' ファイル）');
    } else if (res.snapshot?.at) {
      const mins = Math.round((Date.now() - res.snapshot.at) / 60000);
      setNote('保存済み: ' + (mins < 1 ? 'たった今' : mins + '分前') +
        (res.snapshot.bytes ? ' / ' + Math.round(res.snapshot.bytes / 1024) + 'KB' : ''));
    } else if (files.length) {
      setNote('未保存（コンテナが停止すると消えます）', true);
    } else {
      setNote('');
    }

    const previews = res.previews || [];
    $('#agent-previews').innerHTML = previews.length
      ? previews
          .map(
            (p) =>
              '<a class="agent-preview" href="' + ctx.esc(p.url) + '" target="_blank" rel="noopener">' +
              icon('external', 13) + '<span>:' + p.port + '</span></a>'
          )
          .join('')
      : '<p class="xs muted">起動していません</p>';
  } catch (e) {
    $('#agent-files').innerHTML = '<p class="xs warn">' + ctx.esc(e.message) + '</p>';
    $('#agent-previews').innerHTML = '';
  }
}

/** Pulls one workspace file down through the authenticated route. */
async function downloadFile(path) {
  try {
    const res = await fetch(
      '/api/agent/download?roomId=' + encodeURIComponent(ctx.state.roomId || '') + '&path=' + encodeURIComponent(path),
      { credentials: 'same-origin' }
    );
    if (!res.ok) throw new Error('ダウンロードできませんでした');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = path.split('/').pop() || 'file.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  } catch (e) {
    ctx.toast(e.message, 'err');
  }
}

async function openFile(path) {
  try {
    const res = await ctx.api(
      '/api/agent/file?roomId=' + encodeURIComponent(ctx.state.roomId || '') + '&path=' + encodeURIComponent(path)
    );
    $('#agent-file-name').textContent = path;
    $('#agent-file-body').textContent = res.content || '（空）';
    $('#agent-file-dl').dataset.dl = path;
    $('#agent-file-modal').hidden = false;
  } catch (e) {
    ctx.toast(e.message, 'err');
  }
}

/**
 * Starts a run, then follows it. The run itself lives in a Workflow, so closing
 * the browser no longer stops it — this only attaches to the recorded progress.
 */
async function run() {
  const task = $('#agent-task').value.trim();
  if (!task) return ctx.toast('依頼内容を入力してください', 'err');
  if (!ctx.state.roomId) return ctx.toast('トークルームを選んでください', 'err');

  $('#agent-run').disabled = true;
  $('#agent-status').textContent = '開始しています…';
  // The sheet closes so the run is watched in the thread, at full width.
  ensureRunCard(task);
  $('#agent-modal').hidden = true;
  line('task', task, null, { icon: 'send' });

  try {
    const res = await ctx.api('/api/agent', {
      method: 'POST',
      body: JSON.stringify({
        roomId: ctx.state.roomId,
        task,
        provider: selectedModel()?.provider,
        model: selectedModel()?.id,
        imageModel: document.getElementById('agent-imgmodel').value || undefined,
      }),
    });
    $('#agent-task').value = '';
    await follow(res.runId, 0);
  } catch (e) {
    $('#agent-run').disabled = false;
    line('err', 'エラー', e.message, { icon: 'warning' });
    ctx.toast(e.message, 'err');
  }
}

/** Streams a run's events from `after`, replaying what was missed. */
async function follow(runId, after = 0) {
  currentRun = runId;
  $('#agent-run').disabled = true;
  $('#agent-stop').hidden = false;
  controller = new AbortController();

  try {
    const res = await fetch('/api/agent/stream?runId=' + encodeURIComponent(runId) + '&after=' + after, {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error('進捗を取得できませんでした');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        for (const raw of chunk.split('\n')) {
          if (raw.startsWith('event: ')) event = raw.slice(7).trim();
          else if (raw.startsWith('data: ')) handleEvent(event, JSON.parse(raw.slice(6)));
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      line('err', '接続が切れました', e.message + '（作業自体は続いています。パネルを開き直すと再接続します）', { icon: 'warning' });
    }
  } finally {
    stopLive();
    controller = null;
    currentRun = null;
    $('#agent-run').disabled = false;
    $('#agent-stop').hidden = true;
    await refreshWorkspace();
  }
}

function handleEvent(event, data) {
  if (event.startsWith('sub-')) {
    const inner = event.slice(4);
    if (inner === 'tool') {
      line('sub tool', '　└ ' + (TOOL_LABELS[data.name] || data.name) + ' · ' + describe(data.name, data.args || {}), null, {
        icon: TOOL_ICONS[data.name] || 'code',
      });
    } else if (inner === 'result') {
      const failed = /^exit=(?!0)/.test(String(data.text || ''));
      if (failed) line('sub err', '　└ 失敗', String(data.text).slice(0, 1500));
    }
    return;
  }
  if (event === 'step') {
    setStatus('ステップ ' + data.step + ' / ' + data.of);
  } else if (event === 'tool') {
    const row = line('tool', (TOOL_LABELS[data.name] || data.name) + ' · ' + describe(data.name, data.args || {}), null, {
      icon: TOOL_ICONS[data.name] || 'code',
    });
    startLive(row);
  } else if (event === 'output') {
    if (live) {
      // Only the tail is kept; a build can emit megabytes.
      live.text = (live.text + data.data).slice(-8000);
      live.body.textContent = live.text;
      if (runCard) scrollThread();
      else {
        const log = $('#agent-log');
        log.scrollTop = log.scrollHeight;
      }
    }
  } else if (event === 'result') {
    stopLive();
    const text = String(data.text || '');
    const failed = /^exit=(?!0\b)/.test(text);
    line(failed ? 'err' : 'out', failed ? '失敗' : '完了', text.slice(0, 3000));
  } else if (event === 'screenshot') {
    stopLive();
    line('shot', '画面を確認', (data.meta?.consoleErrors || []).join('\n') || null, { url: data.url, icon: 'image' });
  } else if (event === 'text') {
    line('say', 'アシスタント', data.text, { icon: 'spark' });
  } else if (event === 'warn') {
    line('err', '警告', data.message, { icon: 'warning' });
  } else if (event === 'rules') {
    line('say', 'ルールを読み込みました（' + data.name + ' / ' + data.chars + '文字）', null, { icon: 'doc' });
  } else if (event === 'restored') {
    line('say', '前回の作業を復元しました（' + data.files + ' ファイル）', null, { icon: 'redo' });
  } else if (event === 'error') {
    stopLive();
    line('err', 'エラー', data.message, { icon: 'warning' });
  } else if (event === 'closed') {
    stopLive();
  } else if (event === 'done') {
    stopLive();
    const summary =
      data.error
        ? '中断しました'
        : (data.stopped ? '上限で中断（' : '完了（') + data.steps + 'ステップ' +
          (data.cost ? ' / ' + ctx.usd(data.cost) : '') + '）';
    setStatus(summary);
    if (data.preview) line('say', 'プレビュー: ' + data.preview, null, { icon: 'external' });
    // Reopening the room rebuilds the thread from the database, which would
    // throw the trace away. It is detached first and put back underneath the
    // reply, collapsed, so the work stays inspectable.
    const keep = runCard;
    if (keep) keep.remove();
    finishRunCard(summary);
    if (ctx.state.roomId) {
      ctx.openRoom(ctx.state.roomId)
        .then(() => {
          if (keep) {
            $('#messages')?.appendChild(keep);
            scrollThread();
          }
          releaseRunCard();
        })
        .catch(() => releaseRunCard());
    } else {
      releaseRunCard();
    }
  }
}

const selectedModel = () => agentModels.find((m) => m.ref === document.getElementById('agent-model').value) || null;

/** Only models that can call tools are offered; the rest cannot drive the loop. */
async function loadModels() {
  if (agentModels.length) return;
  try {
    agentModels = (await ctx.api('/api/agent/models')).models || [];
  } catch {
    return;
  }
  // The image picker is separate: the coding model never generates the assets
  // itself, a dedicated image model does.
  try {
    const imgs = await imageModels(ctx);
    $('#agent-imgmodel').innerHTML = imgs
      .map(
        (m) =>
          '<option value="' + ctx.esc(m.id) + '"' +
          (m.id === 'google/gemini-3.1-flash-image' ? ' selected' : '') + '>素材の既定: ' + ctx.esc(m.name) + '</option>'
      )
      .join('');
  } catch {
    /* generation still works with the server-side default */
  }

  const current = ctx.state.room?.model;
  $('#agent-model').innerHTML = agentModels
    .map(
      (m) =>
        '<option value="' + ctx.esc(m.ref) + '"' + (m.id === current ? ' selected' : '') + '>' +
        ctx.esc(m.name) + '（' + ctx.esc(m.provider) + '）</option>'
    )
    .join('');
}

async function toggleOpencode() {
  const btn = $('#agent-opencode');
  btn.disabled = true;
  $('#agent-status').textContent = 'OpenCode を準備しています（初回はインストールに数分かかります）…';
  try {
    const res = await ctx.api('/api/agent/opencode/start', {
      method: 'POST',
      body: JSON.stringify({ roomId: ctx.state.roomId, model: selectedModel()?.id }),
    });
    $('#agent-status').textContent = 'OpenCode を起動しました';
    window.open(res.url, '_blank', 'noopener');
  } catch (e) {
    $('#agent-status').textContent = '';
    ctx.toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

let currentSkill = 'image';

/** Shows the skill list and the guidance for one of them. */
async function openSkills(name) {
  try {
    const list = await ctx.api('/api/agent/skills?roomId=' + encodeURIComponent(ctx.state.roomId || ''));
    currentSkill = name || currentSkill;
    $('#agent-skill-tabs').innerHTML = (list.skills || [])
      .map(
        (s) =>
          '<button type="button" class="chip' + (s.id === currentSkill ? ' on' : '') + '" data-skill="' +
          ctx.esc(s.id) + '">' + ctx.esc(s.title) + (s.custom ? ' *' : '') + '</button>'
      )
      .join('');

    const detail = await ctx.api(
      '/api/agent/skills?roomId=' + encodeURIComponent(ctx.state.roomId || '') + '&name=' + encodeURIComponent(currentSkill)
    );
    $('#agent-skill-when').textContent = 'いつ使うか: ' + detail.when;
    $('#agent-skill-text').value = detail.override || detail.builtin;
    $('#agent-skill-preview').textContent = detail.rendered || '';
    $('#agent-skills-modal').hidden = false;
  } catch (e) {
    ctx.toast(e.message, 'err');
  }
}

/** Picks up a run that was still going when the panel was last closed. */
async function reattach() {
  if (currentRun) return;
  try {
    const { runs } = await ctx.api('/api/agent/runs?roomId=' + encodeURIComponent(ctx.state.roomId || ''));
    const active = (runs || []).find((r) => r.status === 'running');
    if (!active) return;
    $('#agent-log').innerHTML = '';
    ensureRunCard(active.task);
    line('task', active.task, null, { icon: 'send' });
    setStatus('進行中の作業に再接続しました');
    follow(active.id, 0);
  } catch {
    /* nothing to resume */
  }
}

export function initAgent(context) {
  ctx = context;

  $('#agent-btn').addEventListener('click', async () => {
    if (!ctx.state.roomId) return ctx.toast('トークルームを選んでください', 'err');
    $('#agent-modal').hidden = false;
    $('#agent-task').value = $('#input').value.trim();
    await Promise.all([refreshWorkspace(), loadModels()]);
    await reattach();
  });

  $('#agent-opencode').addEventListener('click', toggleOpencode);

  $('#agent-run').addEventListener('click', run);
  $('#agent-stop').addEventListener('click', async () => {
    const runId = currentRun;
    controller?.abort();
    if (runId) {
      await ctx.api('/api/agent/cancel', { method: 'POST', body: JSON.stringify({ runId }) }).catch(() => {});
      $('#agent-status').textContent = '中止しました';
    }
  });
  $('#agent-refresh').addEventListener('click', refreshWorkspace);

  $('#agent-files').addEventListener('click', (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) return downloadFile(dl.dataset.dl);
    const btn = e.target.closest('[data-path]');
    if (btn) openFile(btn.dataset.path);
  });

  $('#agent-file-dl').addEventListener('click', (e) => downloadFile(e.currentTarget.dataset.dl));

  $('#agent-skills').addEventListener('click', () => openSkills());

  $('#agent-skill-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-skill]');
    if (tab) openSkills(tab.dataset.skill);
  });

  $('#agent-skill-reset').addEventListener('click', () => {
    $('#agent-skill-text').value = '';
    ctx.toast('保存すると既定の内容に戻ります');
  });

  $('#agent-skill-save').addEventListener('click', async () => {
    try {
      await ctx.api('/api/agent/skills', {
        method: 'POST',
        body: JSON.stringify({
          roomId: ctx.state.roomId,
          name: currentSkill,
          text: $('#agent-skill-text').value,
        }),
      });
      ctx.toast('スキルを保存しました');
      await openSkills(currentSkill);
    } catch (e) {
      ctx.toast(e.message, 'err');
    }
  });

  $('#agent-rules').addEventListener('click', async () => {
    try {
      const res = await ctx.api('/api/agent/rules?roomId=' + encodeURIComponent(ctx.state.roomId || ''));
      $('#agent-rules-name').textContent = res.name;
      $('#agent-rules-text').value = res.text || '';
      $('#agent-rules-text').dataset.template = res.template || '';
      $('#agent-rules-modal').hidden = false;
    } catch (e) {
      ctx.toast(e.message, 'err');
    }
  });

  $('#agent-rules-template').addEventListener('click', () => {
    const box = $('#agent-rules-text');
    if (box.value.trim() && !confirm('今の内容を置き換えますか？')) return;
    box.value = box.dataset.template || '';
  });

  $('#agent-rules-save').addEventListener('click', async () => {
    try {
      await ctx.api('/api/agent/rules', {
        method: 'POST',
        body: JSON.stringify({ roomId: ctx.state.roomId, text: $('#agent-rules-text').value }),
      });
      ctx.toast('ルールを保存しました');
      $('#agent-rules-modal').hidden = true;
      await refreshWorkspace();
    } catch (e) {
      ctx.toast(e.message, 'err');
    }
  });

  $('#agent-save').addEventListener('click', async () => {
    $('#agent-status').textContent = '保存しています…';
    try {
      const res = await ctx.api('/api/agent/snapshot', {
        method: 'POST',
        body: JSON.stringify({ roomId: ctx.state.roomId }),
      });
      if (res.ok) {
        $('#agent-status').textContent = '保存しました' + (res.bytes ? '（' + Math.round(res.bytes / 1024) + 'KB）' : '');
        await refreshWorkspace();
      } else {
        $('#agent-status').textContent =
          res.reason === 'empty' ? '保存するものがありません' : '保存できません: ' + (res.reason || '不明');
      }
    } catch (e) {
      $('#agent-status').textContent = '';
      ctx.toast(e.message, 'err');
    }
  });

  $('#agent-zip').addEventListener('click', async () => {
    try {
      $('#agent-status').textContent = 'ZIPを作成しています…';
      const res = await ctx.api('/api/agent/zip', {
        method: 'POST',
        body: JSON.stringify({ roomId: ctx.state.roomId, name: ctx.state.room?.title || 'project' }),
      });
      const file = await fetch(res.url, { credentials: 'same-origin' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await file.blob());
      a.download = res.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      $('#agent-status').textContent = res.name + ' を保存しました';
    } catch (e) {
      ctx.toast(e.message, 'err');
      $('#agent-status').textContent = '';
    }
  });

  $('#agent-reset').addEventListener('click', async () => {
    try {
      await ctx.api('/api/agent/reset', { method: 'POST', body: JSON.stringify({ roomId: ctx.state.roomId }) });
      $('#agent-log').innerHTML = '';
      await refreshWorkspace();
      ctx.toast('作業ディレクトリを空にしました');
    } catch (e) {
      ctx.toast(e.message, 'err');
    }
  });
}
