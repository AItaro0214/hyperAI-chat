/* Turns uploaded documents into plain text the models can actually read.
 *
 * OpenRouter only parses PDFs; nothing on either provider understands xlsx,
 * docx, pptx or csv. Extracting here means the text reaches every model on both
 * providers, including the ones with no file input at all. */

import { unzip, isZip } from './zip.js';

const decoder = new TextDecoder('utf-8');

/** Formats handled locally. PDFs are deliberately absent: OpenRouter parses those. */
export const OFFICE_EXT = ['xlsx', 'xlsm', 'docx', 'pptx'];
export const TEXT_EXT = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'html', 'htm',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp',
  'cs', 'php', 'sh', 'bash', 'ps1', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'srt', 'vtt', 'rtf',
];

export const extOf = (name) => String(name || '').toLowerCase().split('.').pop() || '';

/** Which pipeline a file goes through: local extraction, OpenRouter, or nothing. */
export function docKindOf(name, mime = '') {
  const ext = extOf(name);
  const m = String(mime || '').toLowerCase();
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (OFFICE_EXT.includes(ext)) return 'office';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return 'text';
  return 'unknown';
}

/* ------------------------------ XML helpers ----------------------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (all, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code] ?? all;
  });
}

const text = (bytes) => (bytes ? decoder.decode(bytes) : '');
const all = (xml, re) => [...xml.matchAll(re)];

/* --------------------------------- XLSX --------------------------------- */

// Serial 1 is 1900-01-01, but Excel wrongly treats 1900 as a leap year, so the
// epoch is offset by two days.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function serialToIso(serial) {
  const ms = EXCEL_EPOCH + Math.round(serial * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  // A whole number is a date; a fraction carries a time of day.
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

/** Maps style index -> true when that style renders as a date. */
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Set();
  for (const m of all(stylesXml, /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = decodeXml(m[2]).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    if (/[ymdhs]/i.test(code) && /[ymd]/i.test(code)) custom.add(Number(m[1]));
  }
  const block = (stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const out = new Set();
  all(block, /<xf\b[^>]*>/g).forEach((m, i) => {
    const id = Number((m[0].match(/numFmtId="(\d+)"/) || [])[1] || 0);
    if (BUILTIN_DATE_FORMATS.has(id) || custom.has(id)) out.add(i);
  });
  return out;
}

function sharedStrings(xml) {
  if (!xml) return [];
  return all(xml, /<si\b[^>]*>([\s\S]*?)<\/si>/g).map((m) =>
    all(m[1], /<t\b[^>]*>([\s\S]*?)<\/t>/g).map((t) => decodeXml(t[1])).join('')
  );
}

const colIndex = (ref) => {
  const letters = (String(ref).match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function sheetRows(xml, strings, dateXf, limits) {
  const rows = [];
  for (const rowMatch of all(xml, /<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= limits.rows) break;
    const cells = [];
    for (const cellMatch of all(rowMatch[1], /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const at = colIndex((attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '');
      const type = (attrs.match(/t="(\w+)"/) || [])[1] || 'n';
      let value = '';

      if (type === 's') {
        value = strings[Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || 0)] ?? '';
      } else if (type === 'inlineStr') {
        value = all(inner, /<t\b[^>]*>([\s\S]*?)<\/t>/g).map((t) => decodeXml(t[1])).join('');
      } else if (type === 'b') {
        value = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        value = decodeXml((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '#ERR');
      } else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw === undefined) value = '';
        else if (type === 'str') value = decodeXml(raw);
        else {
          const style = Number((attrs.match(/s="(\d+)"/) || [])[1] || -1);
          const num = Number(raw);
          value = dateXf.has(style) && Number.isFinite(num) && num > 0 ? serialToIso(num) : decodeXml(raw);
        }
      }
      if (at >= 0 && at < limits.cols) cells[at] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  // Trailing blank rows carry no information.
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

const csvCell = (v) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

function readXlsx(files, limits) {
  const strings = sharedStrings(text(files['xl/sharedStrings.xml']));
  const dateXf = dateStyles(text(files['xl/styles.xml']));

  // Sheet order and names live in workbook.xml; the actual part each one points
  // at has to be resolved through the relationship ids.
  const rels = {};
  for (const m of all(text(files['xl/_rels/workbook.xml.rels']), /<Relationship\b[^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
    const target = (m[0].match(/Target="([^"]+)"/) || [])[1];
    if (id && target) rels[id] = 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  let sheets = all(text(files['xl/workbook.xml']), /<sheet\b[^>]*>/g).map((m) => ({
    name: decodeXml((m[0].match(/name="([^"]*)"/) || [])[1] || 'Sheet'),
    path: rels[(m[0].match(/r:id="([^"]+)"/) || [])[1]],
  }));
  if (!sheets.length || sheets.every((s) => !s.path)) {
    sheets = Object.keys(files)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((path, i) => ({ name: 'Sheet' + (i + 1), path }));
  }

  const out = [];
  let truncated = false;
  for (const sheet of sheets.slice(0, limits.sheets)) {
    if (!sheet.path || !files[sheet.path]) continue;
    const rows = sheetRows(text(files[sheet.path]), strings, dateXf, limits);
    if (!rows.length) continue;
    if (rows.length >= limits.rows) truncated = true;
    out.push(
      '## シート: ' + sheet.name + '（' + rows.length + '行）\n' +
        rows.map((r) => r.map((c) => csvCell(c ?? '')).join(',')).join('\n')
    );
  }
  if (sheets.length > limits.sheets) truncated = true;
  return { text: out.join('\n\n') || '（空のブックです）', truncated };
}

/* --------------------------------- DOCX --------------------------------- */

function runsOf(xml) {
  return all(xml, /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)
    .map((m) => (m[1] !== undefined ? decodeXml(m[1]) : m[0].startsWith('<w:tab') ? '\t' : '\n'))
    .join('');
}

function readDocx(files, limits) {
  const xml = text(files['word/document.xml']);
  if (!xml) return { text: '', truncated: false };
  const body = (xml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/) || [])[1] || xml;

  const lines = [];
  let truncated = false;
  // Tables and paragraphs are walked in document order so nothing is reordered.
  const blocks = all(body, /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g);
  for (const block of blocks) {
    if (lines.length >= limits.rows) {
      truncated = true;
      break;
    }
    const chunk = block[0];
    if (chunk.startsWith('<w:tbl')) {
      for (const row of all(chunk, /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const cells = all(row[1], /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g).map((c) => runsOf(c[1]).replace(/\n/g, ' ').trim());
        lines.push('| ' + cells.join(' | ') + ' |');
      }
      lines.push('');
      continue;
    }
    const value = runsOf(chunk).trim();
    const style = (chunk.match(/<w:pStyle\b[^>]*w:val="([^"]*)"/) || [])[1] || '';
    const heading = /^Heading(\d)/i.exec(style);
    const numbered = /<w:numPr\b/.test(chunk);
    if (!value) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    if (heading) lines.push('#'.repeat(Math.min(6, Number(heading[1]))) + ' ' + value);
    else if (numbered) lines.push('- ' + value);
    else lines.push(value);
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), truncated };
}

/* --------------------------------- PPTX --------------------------------- */

function slideText(xml) {
  return all(xml, /<a:p\b[^>]*(?:\/>|>([\s\S]*?)<\/a:p>)/g)
    .map((p) => all(p[1] || '', /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g).map((t) => decodeXml(t[1])).join(''))
    .filter((line) => line.trim())
    .join('\n');
}

function readPptx(files, limits) {
  const num = (k) => Number((k.match(/(\d+)\.xml$/) || [])[1] || 0);
  const slides = Object.keys(files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => num(a) - num(b));

  const out = [];
  for (const [i, key] of slides.slice(0, limits.sheets * 10).entries()) {
    const body = slideText(text(files[key]));
    const notesKey = 'ppt/notesSlides/notesSlide' + num(key) + '.xml';
    const notes = files[notesKey] ? slideText(text(files[notesKey])) : '';
    out.push(
      '## スライド ' + (i + 1) + '\n' + (body || '（テキストなし）') +
        (notes.trim() ? '\n\n[ノート] ' + notes.trim() : '')
    );
  }
  return { text: out.join('\n\n'), truncated: slides.length > limits.sheets * 10 };
}

/* -------------------------------- entry point --------------------------- */

const DEFAULT_LIMITS = { rows: 3000, cols: 200, sheets: 20, chars: 200000 };

/**
 * Extracts readable text from an uploaded document.
 * @returns {Promise<{ text: string, kind: string, truncated: boolean } | null>}
 *   null when the caller should hand the raw file to the provider instead.
 */
export async function extractDocument(bytes, name, mime, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const kind = docKindOf(name, mime);
  if (kind === 'pdf' || kind === 'unknown') return null;

  let result;
  if (kind === 'office') {
    if (!isZip(bytes)) return null;
    const files = await unzip(bytes);
    const ext = extOf(name);
    if (ext === 'docx') result = readDocx(files, limits);
    else if (ext === 'pptx') result = readPptx(files, limits);
    else result = readXlsx(files, limits);
  } else {
    let body = decoder.decode(bytes);
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
    result = { text: body, truncated: false };
  }

  let out = result.text || '';
  let truncated = result.truncated;
  if (out.length > limits.chars) {
    out = out.slice(0, limits.chars);
    truncated = true;
  }
  return { text: out, kind, truncated };
}

/** Wraps extracted text so the model can tell where a document starts and ends. */
export function documentBlock(name, extracted) {
  return (
    '<<<添付ファイル: ' + name + (extracted.truncated ? '（大きいため一部のみ）' : '') + '>>>\n' +
    extracted.text +
    '\n<<<ここまで: ' + name + '>>>'
  );
}
