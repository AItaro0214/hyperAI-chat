/* Turning an answer into a file the user can open in Excel, Word, PowerPoint
 * or a PDF viewer. Everything but PDF is generated server side; PDF goes
 * through the browser's own print engine, which needs no library. */

import { icon } from '/icons.js';
import { imageModels } from '/imagegen.js';

let ctx = null;
const $ = (sel) => document.querySelector(sel);

const FORMATS = [
  { id: 'xlsx', label: 'Excel', ext: '.xlsx', icon: 'table', hint: '表や CSV を Excel ブックにします' },
  { id: 'csv', label: 'CSV', ext: '.csv', icon: 'table', hint: 'Excel で文字化けしない UTF-8 の CSV です' },
  { id: 'docx', label: 'Word', ext: '.docx', icon: 'doc', hint: '見出し・箇条書き・表がそのまま反映されます' },
  { id: 'pptx', label: 'PowerPoint', ext: '.pptx', icon: 'slides', hint: '見出しごとに1枚のスライドになります' },
  { id: 'pdf', label: 'PDF', ext: '', icon: 'file', hint: '印刷ダイアログで「PDF に保存」を選んでください' },
  { id: 'md', label: 'Markdown', ext: '.md', icon: 'code', hint: '本文をそのまま保存します' },
  { id: 'html', label: 'HTML', ext: '.html', icon: 'code', hint: 'コードブロックの HTML をそのまま保存します' },
  { id: 'txt', label: 'テキスト', ext: '.txt', icon: 'file', hint: '装飾なしのテキストです' },
];

let source = { content: '', title: '' };
let options = null;

/** True when the answer holds a markdown table or a fenced csv/tsv block. */
export function looksTabular(text) {
  const body = String(text || '');
  if (/^[ \t]*\|.*\|[ \t]*\r?\n[ \t]*\|[\s:|-]+\|[ \t]*$/m.test(body)) return true;
  return /```(?:csv|tsv)\b/i.test(body);
}

export function hasHtmlBlock(text) {
  const body = String(text || '');
  return /```(?:html|xhtml)\b/i.test(body) || /^\s*<(?:!doctype html|html[\s>])/i.test(body);
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

const PRINT_CSS = [
  '@page{margin:18mm 16mm}',
  'body{font-family:"Yu Gothic","Hiragino Sans",system-ui,sans-serif;line-height:1.8;color:#1f1f1f;',
  'max-width:760px;margin:0 auto;padding:8px}',
  'h1,h2,h3{line-height:1.4;margin:1.4em 0 .5em}h1{font-size:1.7em}h2{font-size:1.35em}h3{font-size:1.12em}',
  'table{border-collapse:collapse;width:100%;margin:1em 0}',
  'th,td{border:1px solid #d8d8d8;padding:6px 10px;text-align:left}th{background:#f2f2f2}',
  'pre{background:#f6f6f6;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word}',
  'code{font-family:Consolas,Menlo,monospace;font-size:.92em}',
  'img{max-width:100%}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #ddd;color:#555}',
  'ul,ol{padding-left:1.4em}',
].join('');

/** Hands the answer to the browser's print engine, which can save it as PDF. */
function printAsPdf(content, title) {
  const win = window.open('', '_blank');
  if (!win) {
    ctx.toast('ポップアップがブロックされました。許可してから再度お試しください', 'err');
    return;
  }
  const page =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + ctx.esc(title || '無題') + '</title><style>' + PRINT_CSS + '</style></head><body>' +
    ctx.renderMarkdown(content) +
    '</body></html>';
  win.document.open();
  win.document.write(page);
  win.document.close();
  // Fonts and images need a moment before the dialog measures the page.
  const fire = () => setTimeout(() => { win.focus(); win.print(); }, 300);
  if (win.document.readyState === 'complete') fire();
  else win.addEventListener('load', fire);
}

async function runExport(format, override) {
  if (override) source = override;
  const title = ($('#export-title')?.value || '').trim() || source.title || 'ドキュメント';
  if (format === 'pdf') {
    close();
    printAsPdf(source.content, title);
    return;
  }
  const btn = document.querySelector('#export-formats [data-format="' + format + '"]');
  btn?.classList.add('busy');
  try {
    const res = await ctx.api('/api/export', {
      method: 'POST',
      body: JSON.stringify({
        format,
        content: source.content,
        title,
        roomId: ctx.state.roomId,
        theme: document.querySelector('#export-themes .swatch.on')?.dataset.theme,
        font: document.getElementById('export-font').value,
        generateImages: document.getElementById('export-genimg').checked,
        imageModel: document.getElementById('export-imgmodel').value || undefined,
      }),
    });
    const file = await fetch(res.url, { credentials: 'same-origin' });
    if (!file.ok) throw new Error('生成したファイルを取得できませんでした');
    saveBlob(await file.blob(), res.name);
    ctx.toast(
      res.name + ' を保存しました' +
        (res.images ? '（画像 ' + res.images + ' 点' + (res.cost ? ' / ' + ctx.usd(res.cost) : '') + '）' : '')
    );
    for (const note of res.notes || []) ctx.toast(note, 'err');
    close();
  } catch (e) {
    ctx.toast(e.message, 'err');
  } finally {
    btn?.classList.remove('busy');
  }
}

function close() {
  const modal = $('#export-modal');
  if (modal) modal.hidden = true;
}

export function openExport(content, title) {
  if (!ctx) return;
  source = { content: String(content || ''), title: title || '' };
  const tabular = looksTabular(source.content);
  const html = hasHtmlBlock(source.content);

  // Formats that suit this particular answer are listed first.
  const rank = (f) => {
    if (f.id === 'xlsx' || f.id === 'csv') return tabular ? 0 : 3;
    if (f.id === 'html') return html ? 1 : 4;
    return 1;
  };
  $('#export-formats').innerHTML = [...FORMATS]
    .sort((a, b) => rank(a) - rank(b))
    .map(
      (f) =>
        '<button type="button" class="export-btn" data-format="' + f.id + '" title="' + ctx.esc(f.hint) + '">' +
        icon(f.icon, 20) +
        '<span class="l">' + f.label + '</span>' +
        '<span class="e xs muted">' + (f.ext || 'ブラウザの印刷') + '</span></button>'
    )
    .join('');

  $('#export-title').value = String(title || ctx.state.room?.title || 'ドキュメント')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim()
    .slice(0, 60);
  const placeholders = (source.content.match(/!\[[^\]]+\]\((?:gen|generate|生成|ai)?\)/gi) || []).length;
  $('#export-hint').textContent = tabular
    ? '表を検出しました。Excel / CSV がそのまま使えます。'
    : placeholders
      ? placeholders + ' 箇所の画像プレースホルダを検出しました。デザインから自動生成をオンにできます。'
      : '見出しと箇条書きは Word の書式・PowerPoint のスライドになります。';
  if (placeholders) $('#export-design').open = true;
  $('#export-modal').hidden = false;
  loadDesignOptions();
}

/** Palette swatches, font list and image models, fetched once. */
async function loadDesignOptions() {
  if (options) return;
  try {
    options = await ctx.api('/api/export/options');
  } catch {
    return;
  }
  $('#export-themes').innerHTML = options.themes
    .map(
      (t, i) =>
        '<button type="button" class="swatch' + (i === 0 ? ' on' : '') + '" data-theme="' + ctx.esc(t.id) +
        '" style="--sw:' + ctx.esc(t.accent) + '" title="' + ctx.esc(t.id) + '"></button>'
    )
    .join('');
  $('#export-font').innerHTML = options.fonts
    .map((f) => '<option value="' + ctx.esc(f.id) + '">' + ctx.esc(f.label) + '</option>')
    .join('');

  try {
    const models = await imageModels(ctx);
    $('#export-imgmodel').innerHTML = models
      .map(
        (m) =>
          '<option value="' + ctx.esc(m.id) + '"' + (m.id === options.defaultImageModel ? ' selected' : '') + '>' +
          ctx.esc(m.name) + '</option>'
      )
      .join('');
  } catch {
    /* generation stays available with the server-side default */
  }
}

/** Adds a one-tap download beside any table or csv/tsv block in an answer. */
export function attachExportButtons(bodyEl, msg) {
  if (!ctx) return;
  const roomTitle = () => ctx.state.room?.title || 'データ';

  for (const code of bodyEl.querySelectorAll('pre > code')) {
    const lang = (String(code.className || '').match(/language-([\w-]+)/) || [])[1] || '';
    if (lang !== 'csv' && lang !== 'tsv') continue;
    const bar = ctx.el('div', 'code-actions');
    for (const format of ['xlsx', 'csv']) {
      const btn = ctx.el('button', 'btn');
      btn.type = 'button';
      btn.innerHTML = icon('table', 15) + '<span>' + (format === 'xlsx' ? 'Excel' : 'CSV') + '</span>';
      btn.addEventListener('click', () =>
        runExport(format, { content: code.textContent || '', title: roomTitle() })
      );
      bar.appendChild(btn);
    }
    code.closest('pre').after(bar);
  }

  for (const table of bodyEl.querySelectorAll('table')) {
    const bar = ctx.el('div', 'code-actions');
    const btn = ctx.el('button', 'btn');
    btn.type = 'button';
    btn.innerHTML = icon('table', 15) + '<span>Excel で開く</span>';
    btn.addEventListener('click', () => {
      const rows = [...table.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((cell) => cell.textContent.trim())
      );
      runExport('xlsx', {
        content: rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n'),
        title: roomTitle(),
      });
    });
    bar.appendChild(btn);
    table.after(bar);
  }
}

export function initExport(context) {
  ctx = context;
  $('#export-formats').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-format]');
    if (btn) runExport(btn.dataset.format);
  });
  $('#export-themes').addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    for (const s of document.querySelectorAll('#export-themes .swatch')) s.classList.remove('on');
    swatch.classList.add('on');
  });
  $('#export-genimg').addEventListener('change', (e) => {
    $('#export-imgmodel-field').hidden = !e.target.checked;
  });
}
