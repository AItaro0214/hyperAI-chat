/* Generates xlsx / docx / pptx / csv from what the model wrote.
 *
 * Every Office format here is assembled as raw OOXML and zipped, so no runtime
 * dependency is needed. The parts are the minimum Word, Excel and PowerPoint
 * will open; anything beyond that (themes, layouts) is fixed boilerplate. */

import { zip } from './zip.js';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML and Office refuses the whole file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/* ================================== CSV ================================== */

export function parseDelimited(input, delimiter) {
  const src = String(input || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const sep = delimiter || (src.split('\n')[0].includes('\t') ? '\t' : ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

export function toCsv(rows) {
  return rows
    .map((r) => r.map((c) => (/[",\n\r]/.test(String(c ?? '')) ? '"' + String(c).replace(/"/g, '""') + '"' : String(c ?? ''))).join(','))
    .join('\r\n');
}

/** Pulls the first markdown table out of a document, as a row grid. */
export function parseMarkdownTable(md) {
  const lines = String(md || '').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) {
      if (rows.length) break;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // the ---|--- separator row
    rows.push(t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  }
  return rows;
}

/* ================================= XLSX ================================== */

export function colName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function sheetXml(rows, { header = true } = {}) {
  const body = rows
    .map((cells, r) => {
      const style = header && r === 0 ? ' s="1"' : '';
      const out = cells
        .map((value, c) => {
          const ref = colName(c) + (r + 1);
          const raw = value === null || value === undefined ? '' : String(value);
          if (raw === '') return '';
          // Long digit strings (IDs, phone numbers) must stay text or Excel
          // mangles them into scientific notation.
          if (NUMERIC.test(raw.trim()) && raw.trim().length < 15) {
            return '<c r="' + ref + '"' + style + '><v>' + esc(raw.trim()) + '</v></c>';
          }
          return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + esc(raw) + '</t></is></c>';
        })
        .join('');
      return '<row r="' + (r + 1) + '">' + out + '</row>';
    })
    .join('');

  const widest = rows.reduce((n, r) => Math.max(n, r.length), 1);
  const dim = 'A1:' + colName(Math.max(0, widest - 1)) + Math.max(1, rows.length);
  return (
    XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + DOC_REL + '">' +
    '<dimension ref="' + dim + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"' + (header ? '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>' : '/>') +
    '</sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols><col min="1" max="' + Math.max(1, widest) + '" width="18" customWidth="1"/></cols>' +
    '<sheetData>' + body + '</sheetData>' +
    (rows.length ? '<autoFilter ref="' + dim + '"/>' : '') +
    '</worksheet>'
  );
}

const XLSX_STYLES =
  XML +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FF1F1F1F"/><name val="Yu Gothic"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * @param {{name: string, rows: (string|number)[][]}[]} sheets
 */
export async function buildXlsx(sheets, { header = true } = {}) {
  const used = new Set();
  const safe = sheets.map((s, i) => {
    // Excel rejects : \ / ? * [ ] in sheet names and caps them at 31 chars.
    let name = String(s.name || 'Sheet' + (i + 1)).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet' + (i + 1);
    while (used.has(name.toLowerCase())) name = name.slice(0, 28) + '_' + (used.size + 1);
    used.add(name.toLowerCase());
    return { name, rows: s.rows || [] };
  });

  const entries = [
    {
      name: '[Content_Types].xml',
      data:
        XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        safe
          .map((_, i) =>
            '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        XML +
        '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        XML +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + DOC_REL + '"><sheets>' +
        safe.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        XML +
        '<Relationships xmlns="' + REL_NS + '">' +
        safe
          .map((_, i) =>
            '<Relationship Id="rId' + (i + 1) + '" Type="' + DOC_REL + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'
          )
          .join('') +
        '<Relationship Id="rIdStyles" Type="' + DOC_REL + '/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', data: XLSX_STYLES },
    ...safe.map((s, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s.rows, { header }) })),
  ];
  return zip(entries);
}

/* ================================= DOCX ================================== */

/** Splits **bold** / *italic* / `code` into styled runs. */
function inlineRuns(textValue) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(textValue))) {
    if (m.index > last) parts.push({ text: textValue.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('**') || token.startsWith('__')) parts.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) parts.push({ text: token.slice(1, -1), code: true });
    else parts.push({ text: token.slice(1, -1), italic: true });
    last = re.lastIndex;
  }
  if (last < textValue.length) parts.push({ text: textValue.slice(last) });
  return parts.length ? parts : [{ text: textValue }];
}

const runXml = (part) =>
  '<w:r><w:rPr>' +
  (part.bold ? '<w:b/>' : '') +
  (part.italic ? '<w:i/>' : '') +
  (part.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '') +
  '</w:rPr><w:t xml:space="preserve">' + esc(part.text) + '</w:t></w:r>';

const paraXml = (textValue, { style = '', bullet = false } = {}) =>
  '<w:p><w:pPr>' +
  (style ? '<w:pStyle w:val="' + style + '"/>' : '') +
  (bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '') +
  '</w:pPr>' +
  inlineRuns(textValue).map(runXml).join('') +
  '</w:p>';

function tableXml(rows) {
  const cell = (value, bold) =>
    '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>' +
    '<w:p><w:pPr></w:pPr>' +
    (bold ? '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + esc(value) + '</w:t></w:r>' : inlineRuns(value).map(runXml).join('')) +
    '</w:p></w:tc>';
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>')
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    rows.map((r, i) => '<w:tr>' + r.map((c) => cell(c, i === 0)).join('') + '</w:tr>').join('') +
    '</w:tbl><w:p/>'
  );
}

// Word's page box minus the 1134-twip margins, in EMU.
const DOCX_MAX_W = 6119000;

/** An inline picture paragraph referencing an embedded media part. */
function drawingXml(relId, bytes, alt, index) {
  const size = imageSize(bytes) || { width: 16, height: 9 };
  const scale = Math.min(1, DOCX_MAX_W / (size.width * 9525));
  const cx = Math.round(size.width * 9525 * scale);
  const cy = Math.round(size.height * 9525 * scale);
  return (
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="' + (1000 + index) + '" name="Picture ' + (index + 1) + '" descr="' + esc(alt || '') + '"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr><pic:cNvPr id="' + index + '" name="' + esc(alt || 'image') + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
    (alt ? paraXml(alt, { style: 'Caption' }) : '')
  );
}

/** Converts a markdown-ish document into Word body XML. */
export function markdownToDocxBody(md, images = []) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  let imageCount = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      for (const c of code) out.push(paraXml(c || ' ', { style: 'CodeBlock' }));
      continue;
    }
    if (trimmed.startsWith('|') && lines[i + 1] && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) block.push(lines[i++]);
      const rows = parseMarkdownTable(block.join('\n'));
      if (rows.length) out.push(tableXml(rows));
      continue;
    }
    const picture = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(trimmed);
    if (picture) {
      const resolved = images[imageCount];
      if (resolved?.bytes?.length) out.push(drawingXml(resolved.relId, resolved.bytes, picture[1], imageCount));
      imageCount++;
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      out.push(paraXml(heading[2], { style: 'Heading' + Math.min(3, heading[1].length) }));
      i++;
      continue;
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      out.push(paraXml(trimmed.replace(/^[-*+]\s+/, ''), { bullet: true }));
      i++;
      continue;
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      out.push(paraXml(trimmed.replace(/^\d+[.)]\s+/, ''), { bullet: true }));
      i++;
      continue;
    }
    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
      i++;
      continue;
    }
    out.push(paraXml(trimmed));
    i++;
  }
  return out.join('');
}

const DOCX_STYLES =
  XML +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Yu Gothic" w:hAnsi="Yu Gothic" w:eastAsia="Yu Gothic"/>' +
  '<w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  [1, 2, 3]
    .map(
      (n) =>
        '<w:style w:type="paragraph" w:styleId="Heading' + n + '"><w:name w:val="heading ' + n + '"/>' +
        '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="' + (n - 1) + '"/>' +
        '<w:spacing w:before="' + (300 - n * 60) + '" w:after="120"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="' + (36 - n * 5) + '"/><w:color w:val="1F1F1F"/></w:rPr></w:style>'
    )
    .join('') +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="180"/></w:pPr>' +
  '<w:rPr><w:i/><w:sz w:val="18"/><w:color w:val="6B6B6B"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>' +
  '</w:styles>';

const DOCX_NUMBERING =
  XML +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
  '<w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

export async function buildDocx(markdown, { images = [] } = {}) {
  // Each picture is a media part with its own relationship id.
  const media = images
    .filter((img) => img?.bytes?.length)
    .map((img, i) => {
      const ext = imageExt(img.mime, img.bytes);
      return { ...img, ext, relId: 'rIdImg' + (i + 1), part: 'media/image' + (i + 1) + '.' + ext };
    });
  // Unresolved markers keep their slot so later images stay aligned.
  let cursor = 0;
  const slots = images.map((img) => (img?.bytes?.length ? media[cursor++] : null));
  const usedExts = [...new Set(media.map((m) => m.ext))];
  const body = markdownToDocxBody(markdown, slots);
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        usedExts.map((e) => '<Default Extension="' + e + '" ContentType="' + IMAGE_CONTENT_TYPES[e] + '"/>').join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="' + DOC_REL + '/numbering" Target="numbering.xml"/>' +
        media.map((m) => '<Relationship Id="' + m.relId + '" Type="' + DOC_REL + '/image" Target="' + m.part + '"/>').join('') +
        '</Relationships>',
    },
    { name: 'word/styles.xml', data: DOCX_STYLES },
    { name: 'word/numbering.xml', data: DOCX_NUMBERING },
    ...media.map((m) => ({ name: 'word/' + m.part, data: m.bytes })),
    {
      name: 'word/document.xml',
      data:
        XML +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="' + DOC_REL + '" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>',
    },
  ]);
}

/* =============================== DIAGRAMS ================================ */

/* SmartArt-style figures built from plain autoshapes. PowerPoint renders and
 * edits these like any hand-drawn diagram, which is what SmartArt compiles to
 * anyway — only the authoring UI differs. Gradients, soft shadows and (for the
 * pyramid) a real 3-D camera come from DrawingML, so nothing is rasterised. */

export const DIAGRAM_TYPES = ['process', 'cycle', 'pyramid', 'matrix', 'compare', 'stack'];

/** Parses a ```diagram fence: `type:` line, then one item per line. */
export function parseDiagramBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  let type = 'process';
  let title = '';
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*(type|title|種類|タイトル)\s*[:：]\s*(.+)$/i.exec(lines[i]);
    if (!m) break;
    if (/^(type|種類)$/i.test(m[1])) type = m[2].trim().toLowerCase();
    else title = m[2].trim();
  }

  const items = [];
  for (const line of lines.slice(i)) {
    const t = line.trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
    if (!t) continue;
    // "見出し: 説明" splits into a label and its supporting line.
    const split = /^([^:：]{1,40})\s*[:：]\s*(.+)$/.exec(t);
    items.push(split ? { label: stripInline(split[1]), note: stripInline(split[2]) } : { label: stripInline(t), note: '' });
  }
  if (!items.length) return null;
  return { type: normalizeDiagramType(type), title, items: items.slice(0, 8) };
}

export function normalizeDiagramType(type) {
  const t = String(type || '').toLowerCase();
  if (['cycle', 'circular', '循環', 'サイクル'].includes(t)) return 'cycle';
  if (['pyramid', 'ピラミッド', '階層'].includes(t)) return 'pyramid';
  if (['matrix', '2x2', 'マトリクス', 'マトリックス'].includes(t)) return 'matrix';
  if (['compare', 'comparison', '比較', 'vs'].includes(t)) return 'compare';
  if (['stack', 'list', '積み上げ', 'リスト'].includes(t)) return 'stack';
  return 'process';
}

/** Mixes a hex colour towards white (positive) or black (negative). */
export function tint(hex, amount) {
  const n = parseInt(hex, 16);
  const target = amount >= 0 ? 255 : 0;
  const k = Math.abs(amount);
  const f = (c) => Math.round(c + (target - c) * k);
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();
}

/** Relative luminance, so label colour follows the fill rather than an index. */
export function isDark(hex) {
  const n = parseInt(hex, 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  // The gradient lightens the top of each shape, so the cutoff sits below the
  // usual midpoint to keep pale fills on dark text.
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2] < 0.4;
}

const gradientFill = (hex) =>
  '<a:gradFill rotWithShape="1"><a:gsLst>' +
  '<a:gs pos="0"><a:srgbClr val="' + tint(hex, 0.2) + '"/></a:gs>' +
  '<a:gs pos="55000"><a:srgbClr val="' + hex + '"/></a:gs>' +
  '<a:gs pos="100000"><a:srgbClr val="' + tint(hex, -0.16) + '"/></a:gs>' +
  '</a:gsLst><a:lin ang="2700000" scaled="0"/></a:gradFill>';

const SOFT_SHADOW =
  '<a:effectLst><a:outerShdw blurRad="190500" dist="63500" dir="5400000" algn="t" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="20000"/></a:srgbClr></a:outerShdw></a:effectLst>';

const DROP_SHADOW =
  '<a:effectLst><a:outerShdw blurRad="228600" dist="88900" dir="3000000" algn="tl" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="25000"/></a:srgbClr></a:outerShdw></a:effectLst>';

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/* ---------------------------- geometry model ---------------------------- */

/* Diagrams are described as plain shape records first, then rendered to either
 * OOXML or the SVG preview. One geometry, two renderers — so what the user
 * previews cannot drift from what lands in the file. */

const box = (geom, x, y, w, h, fill, lines, extra = {}) => ({
  geom,
  x,
  y,
  w,
  h,
  fill,
  lines: lines.filter(Boolean),
  dark: isDark(fill),
  ...extra,
});

/** The layered 3-D pyramid, as front and side polygons plus label boxes. */
export function pyramidGeometry(items, x, y, w, h, theme) {
  const n = items.length;
  const shapes = [];

  // Silhouette: the front face is a triangle, the right face recedes up-right.
  const depthX = w * 0.22;
  const depthY = h * 0.13;
  const frontW = w - depthX;
  const apex = { x: x + frontW / 2 + depthX * 0.45, y };
  const frontLeft = { x, y: y + h };
  const frontRight = { x: x + frontW, y: y + h };
  const backRight = { x: x + w, y: y + h - depthY };

  for (let k = 0; k < n; k++) {
    const t0 = k / n;
    const t1 = (k + 1) / n;
    const fill = tint(theme.accent, n === 1 ? 0 : ((n - 1 - k) / (n - 1)) * 0.52);
    const side = tint(fill, -0.22);

    const pTop = lerp(apex, frontLeft, t0);
    const qTop = lerp(apex, frontRight, t0);
    const sTop = lerp(apex, backRight, t0);
    const pBot = lerp(apex, frontLeft, t1);
    const qBot = lerp(apex, frontRight, t1);
    const sBot = lerp(apex, backRight, t1);

    // Only the bottom layer carries the drop shadow; shadowing every band
    // would draw shadows across the seams inside the solid.
    const shadow = k === n - 1;
    shapes.push({
      geom: 'poly',
      name: 'Layer ' + (k + 1) + ' side',
      points: k === 0 ? [apex, sBot, qBot] : [qTop, sTop, sBot, qBot],
      fill: side,
      line: 'FFFFFF',
      shadow,
      lines: [],
    });
    shapes.push({
      geom: 'poly',
      name: 'Layer ' + (k + 1),
      points: k === 0 ? [apex, qBot, pBot] : [pTop, qTop, qBot, pBot],
      fill,
      line: 'FFFFFF',
      shadow,
      lines: [],
    });

    // The label sits on the front face, centred between that layer's edges.
    const top = k === 0 ? apex.y : pTop.y;
    const left = Math.min(pTop.x, pBot.x);
    const right = Math.max(qTop.x, qBot.x);
    shapes.push({
      geom: 'label',
      x: left,
      y: top,
      w: right - left,
      h: pBot.y - top,
      fill,
      dark: isDark(fill),
      lines: [items[k].label, items[k].note].filter(Boolean),
    });
  }
  return shapes;
}

/**
 * Lays a diagram out inside the given box.
 * @returns {object[]} shape records
 */
export function diagramGeometry(diagram, x, y, w, h, theme) {
  const items = diagram.items || [];
  if (!items.length) return [];
  const n = items.length;
  // A ramp from the accent colour towards white, one step per node.
  const fillFor = (i) => tint(theme.accent, n === 1 ? 0 : (i / (n - 1)) * 0.52);
  const shapes = [];

  if (diagram.type === 'process') {
    const gap = 91440;
    const boxW = (w - gap * (n - 1)) / n;
    const boxH = Math.min(h, 1600200);
    const top = y + (h - boxH) / 2;
    items.forEach((item, i) => {
      shapes.push(box(i === 0 ? 'homePlate' : 'chevron', x + i * (boxW + gap), top, boxW, boxH, fillFor(i), [item.label, item.note]));
    });
    return shapes;
  }

  if (diagram.type === 'cycle') {
    const radius = Math.min(w, h) / 2 - 685800;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const size = Math.min(2057400, (2 * Math.PI * radius) / n - 91440);
    items.forEach((item, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      shapes.push(
        box('ellipse', cx + Math.cos(angle) * radius - size / 2, cy + Math.sin(angle) * radius - size / 2,
          size, size, fillFor(i), [item.label, item.note], { size: 1200 })
      );
    });
    return shapes;
  }

  if (diagram.type === 'pyramid') {
    // Kept at 4:3-ish so the solid never looks stretched in a wide body area.
    const boxH = Math.min(h, 4200000);
    const boxW = Math.min(w, boxH * 1.55);
    return pyramidGeometry(items, x + (w - boxW) / 2, y + (h - boxH) / 2, boxW, boxH, theme);
  }

  if (diagram.type === 'matrix') {
    const gap = 91440;
    const cellW = (w - gap) / 2;
    const cellH = (h - gap) / 2;
    items.slice(0, 4).forEach((item, i) => {
      shapes.push(
        box('roundRect', x + (i % 2) * (cellW + gap), y + Math.floor(i / 2) * (cellH + gap), cellW, cellH,
          fillFor(i), [item.label, item.note], { size: 1600, round: 0.08 })
      );
    });
    return shapes;
  }

  if (diagram.type === 'compare') {
    const gap = 274320;
    const colW = (w - gap * (n - 1)) / n;
    items.forEach((item, i) => {
      shapes.push(box('roundRect', x + i * (colW + gap), y, colW, h, fillFor(i), [item.label, item.note], { size: 1600, round: 0.06 }));
    });
    return shapes;
  }

  // stack: full-width bands, one per item
  const gap = 68580;
  const rowH = Math.min((h - gap * (n - 1)) / n, 822960);
  const top = y + (h - (rowH * n + gap * (n - 1))) / 2;
  items.forEach((item, i) => {
    shapes.push(
      box('roundRect', x, top + i * (rowH + gap), w, rowH, fillFor(i),
        [item.label + (item.note ? '　' + item.note : '')], { size: 1400, round: 0.12 })
    );
  });
  return shapes;
}

/* ------------------------------ OOXML render ---------------------------- */

/** A closed polygon as DrawingML custom geometry, positioned by its own box. */
function polygonXml(id, name, points, fill, { line = null, shadow = false } = {}) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const left = Math.round(Math.min(...xs));
  const top = Math.round(Math.min(...ys));
  const w = Math.max(1, Math.round(Math.max(...xs) - left));
  const h = Math.max(1, Math.round(Math.max(...ys) - top));

  const path =
    '<a:path w="' + w + '" h="' + h + '">' +
    points
      .map((p, i) => {
        const pt = '<a:pt x="' + Math.round(p.x - left) + '" y="' + Math.round(p.y - top) + '"/>';
        return i === 0 ? '<a:moveTo>' + pt + '</a:moveTo>' : '<a:lnTo>' + pt + '</a:lnTo>';
      })
      .join('') +
    '<a:close/></a:path>';

  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + left + '" y="' + top + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm>' +
    '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>' +
    '<a:rect l="0" t="0" r="' + w + '" b="' + h + '"/>' +
    '<a:pathLst>' + path + '</a:pathLst></a:custGeom>' +
    '<a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill>' +
    (line ? '<a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="' + line + '"/></a:solidFill><a:round/></a:ln>' : '<a:ln><a:noFill/></a:ln>') +
    (shadow ? DROP_SHADOW : '') +
    '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
  );
}

const labelParagraphs = (lines, dark, size) =>
  lines
    .map(
      (line, i) =>
        '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ja-JP" altLang="en-US" sz="' +
        (i === 0 ? size : Math.max(900, size - 400)) + '"' + (i === 0 ? ' b="1"' : '') + ' dirty="0">' +
        '<a:solidFill><a:srgbClr val="' +
        (dark ? (i === 0 ? 'FFFFFF' : 'EDEDF5') : i === 0 ? '1F1F1F' : '4A4A52') +
        '"/></a:solidFill></a:rPr><a:t>' + esc(line) + '</a:t></a:r></a:p>'
    )
    .join('');

/** A filled shape carrying centred text. */
function nodeXml(id, s) {
  const size = s.size || 1400;
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Node ' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + Math.round(s.x) + '" y="' + Math.round(s.y) + '"/>' +
    '<a:ext cx="' + Math.round(s.w) + '" cy="' + Math.round(s.h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="' + s.geom + '">' +
    (s.round ? '<a:avLst><a:gd name="adj" fmla="val ' + Math.round(s.round * 100000) + '"/></a:avLst>' : '<a:avLst/>') +
    '</a:prstGeom>' +
    gradientFill(s.fill) +
    '<a:ln><a:noFill/></a:ln>' + SOFT_SHADOW +
    '</p:spPr>' +
    '<p:txBody><a:bodyPr lIns="91440" rIns="91440" tIns="45720" bIns="45720" anchor="ctr" wrap="square">' +
    '<a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    (labelParagraphs(s.lines, s.dark, size) || '<a:p><a:endParaRPr lang="ja-JP"/></a:p>') +
    '</p:txBody></p:sp>'
  );
}

const labelXml = (id, s) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Label"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="' + Math.round(s.x) + '" y="' + Math.round(s.y) + '"/>' +
  '<a:ext cx="' + Math.round(s.w) + '" cy="' + Math.round(s.h) + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
  '<p:txBody><a:bodyPr anchor="ctr" wrap="square" lIns="45720" rIns="45720" tIns="0" bIns="0">' +
  '<a:normAutofit/></a:bodyPr><a:lstStyle/>' +
  (labelParagraphs(s.lines, s.dark, s.size || 1400) || '<a:p/>') + '</p:txBody></p:sp>';

/** Renders the geometry to slide shapes. Labels go last so they sit on top. */
export function diagramShapes(diagram, startId, x, y, w, h, theme) {
  const shapes = diagramGeometry(diagram, x, y, w, h, theme);
  let id = startId;
  const faces = [];
  const labels = [];
  for (const s of shapes) {
    if (s.geom === 'poly') faces.push(polygonXml(id++, s.name, s.points, s.fill, { line: s.line, shadow: s.shadow }));
    else if (s.geom === 'label') labels.push(s);
    else faces.push(nodeXml(id++, s));
  }
  return faces.join('') + labels.map((s) => labelXml(id++, s)).join('');
}

/** How many shape ids a diagram consumes, so callers can keep them unique. */
export const diagramShapeCount = (diagram, theme) =>
  diagramGeometry(diagram, 0, 0, 4000000, 2600000, theme).length;

/* ================================ CHARTS ================================= */

const CHART_NS =
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="' + DOC_REL + '"';

/* Series colours are derived from the deck's accent so a chart never clashes
 * with the palette the rest of the slides use. */
const seriesPalette = (theme) => [
  theme.accent,
  tint(theme.accent, 0.46),
  tint(theme.accent, -0.3),
  tint(theme.accent, 0.7),
  '9AA0AE',
  tint(theme.accent, 0.24),
  'C7CBD6',
  tint(theme.accent, -0.55),
];

const CAT_AX = 111111111;
const VAL_AX = 222222222;

/** Turns a row grid into a chart spec: header row, label column, numeric rest. */
export function gridToChart(rows, { type = 'bar', title = '' } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const header = rows[0].map((c) => String(c ?? '').trim());
  const body = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (!body.length || header.length < 2) return null;

  const num = (v) => {
    // Thousands separators and a trailing unit are common in model output.
    const cleaned = String(v ?? '').replace(/[,\s]/g, '').replace(/[^\d.+-eE]/g, '');
    // Stripping a non-numeric cell leaves an empty string, which Number() would
    // happily turn into 0.
    if (!/\d/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const series = [];
  for (let col = 1; col < header.length; col++) {
    const values = body.map((r) => num(r[col]));
    // A column only becomes a series when essentially all of it is numeric, so
    // a label column with one stray number is not mistaken for data.
    if (values.filter((v) => v !== null).length < Math.max(1, Math.ceil(values.length * 0.8))) continue;
    series.push({ name: header[col] || 'series ' + col, values: values.map((v) => v ?? 0) });
  }
  if (!series.length) return null;

  return {
    type,
    title,
    categories: body.map((r) => String(r[0] ?? '')),
    series: type === 'pie' ? series.slice(0, 1) : series,
  };
}

/** Parses a ```chart fence: optional `type:`/`title:` lines then a table or CSV. */
export function parseChartBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  let type = 'bar';
  let title = '';
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*(type|title|kind|種類|タイトル)\s*[:：]\s*(.+)$/i.exec(lines[i]);
    if (!m) break;
    const value = m[2].trim();
    if (/^(type|kind|種類)$/i.test(m[1])) type = value.toLowerCase();
    else title = value;
  }
  const rest = lines.slice(i).join('\n').trim();
  if (!rest) return null;
  const rows = rest.trim().startsWith('|') ? parseMarkdownTable(rest) : parseDelimited(rest);
  const kind = ['bar', 'column', 'line', 'pie', 'doughnut', '棒', '折れ線', '円'].includes(type) ? type : 'bar';
  return gridToChart(rows, { type: normalizeChartType(kind), title });
}

export function normalizeChartType(type) {
  const t = String(type || '').toLowerCase();
  if (['line', '折れ線', 'trend'].includes(t)) return 'line';
  if (['pie', '円', 'doughnut', 'donut'].includes(t)) return 'pie';
  return 'bar';
}

const numCache = (values) =>
  '<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="' + values.length + '"/>' +
  values.map((v, i) => '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>').join('') +
  '</c:numCache>';

const strCache = (values) =>
  '<c:strCache><c:ptCount val="' + values.length + '"/>' +
  values.map((v, i) => '<c:pt idx="' + i + '"><c:v>' + esc(v) + '</c:v></c:pt>').join('') +
  '</c:strCache>';

/** Sheet reference for the embedded workbook, so "Edit Data" works in Office. */
const ref = (col, from, to) => 'Sheet1!$' + col + '$' + from + (to ? ':$' + col + '$' + to : '');

function seriesXml(series, index, categories, type, theme) {
  const palette = seriesPalette(theme);
  const color = palette[index % palette.length];
  const column = colName(index + 1);
  const last = categories.length + 1;

  const fill =
    type === 'line'
      ? '<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill>' +
        '<a:round/></a:ln><a:effectLst/></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/>' +
        '<c:spPr><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill></c:spPr></c:marker>'
      : '<c:spPr><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>';

  // A pie takes its colours per slice rather than per series.
  const points =
    type === 'pie'
      ? categories
          .map(
            (_, i) =>
              '<c:dPt><c:idx val="' + i + '"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="' +
              palette[i % palette.length] + '"/></a:solidFill>' +
              '<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>'
          )
          .join('')
      : '';

  return (
    '<c:ser><c:idx val="' + index + '"/><c:order val="' + index + '"/>' +
    '<c:tx><c:strRef><c:f>' + ref(column, 1) + '</c:f>' + strCache([series.name]) + '</c:strRef></c:tx>' +
    (type === 'pie' ? points : fill) +
    (type === 'bar' ? '<c:invertIfNegative val="0"/>' : '') +
    '<c:cat><c:strRef><c:f>' + ref('A', 2, last) + '</c:f>' + strCache(categories) + '</c:strRef></c:cat>' +
    '<c:val><c:numRef><c:f>' + ref(column, 2, last) + '</c:f>' + numCache(series.values) + '</c:numRef></c:val>' +
    (type === 'line' ? '<c:smooth val="0"/>' : '') +
    '</c:ser>'
  );
}

const axisText = (color) =>
  '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200"><a:solidFill><a:srgbClr val="' + color + '"/>' +
  '</a:solidFill><a:latin typeface="Yu Gothic"/></a:defRPr></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr>';

/** The chart part itself; values are cached so it renders without the workbook. */
export function chartXml(spec, theme, { hasWorkbook = true } = {}) {
  const type = normalizeChartType(spec.type);
  const categories = spec.categories || [];
  const series = (spec.series || []).map((s, i) => seriesXml(s, i, categories, type, theme));

  const plot =
    type === 'pie'
      ? '<c:pieChart><c:varyColors val="1"/>' + series.join('') +
        '<c:firstSliceAng val="0"/></c:pieChart>'
      : type === 'line'
        ? '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' + series.join('') +
          '<c:marker val="1"/><c:axId val="' + CAT_AX + '"/><c:axId val="' + VAL_AX + '"/></c:lineChart>'
        : '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' + series.join('') +
          '<c:gapWidth val="80"/><c:axId val="' + CAT_AX + '"/><c:axId val="' + VAL_AX + '"/></c:barChart>';

  const axes =
    type === 'pie'
      ? ''
      : '<c:catAx><c:axId val="' + CAT_AX + '"/><c:scaling><c:orientation val="minMax"/></c:scaling>' +
        '<c:delete val="0"/><c:axPos val="b"/>' +
        '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D8D8DE"/></a:solidFill></a:ln></c:spPr>' +
        axisText(theme.body) +
        '<c:crossAx val="' + VAL_AX + '"/></c:catAx>' +
        '<c:valAx><c:axId val="' + VAL_AX + '"/><c:scaling><c:orientation val="minMax"/></c:scaling>' +
        '<c:delete val="0"/><c:axPos val="l"/>' +
        '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="EDEDF2"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
        '<c:numFmt formatCode="General" sourceLinked="1"/>' +
        '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' +
        axisText(theme.body) +
        '<c:crossAx val="' + CAT_AX + '"/></c:valAx>';

  const title = spec.title
    ? '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1">' +
      '<a:solidFill><a:srgbClr val="' + theme.ink + '"/></a:solidFill><a:latin typeface="Yu Gothic"/></a:defRPr></a:pPr>' +
      '<a:r><a:rPr lang="ja-JP" sz="1400" b="1"/><a:t>' + esc(spec.title) + '</a:t></a:r></a:p></c:rich></c:tx>' +
      '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'
    : '<c:autoTitleDeleted val="1"/>';

  const legend =
    type === 'pie' || (spec.series || []).length > 1
      ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/>' + axisText(theme.body) + '</c:legend>'
      : '';

  return (
    XML +
    '<c:chartSpace ' + CHART_NS + '><c:roundedCorners val="0"/><c:chart>' +
    title +
    '<c:plotArea><c:layout/>' + plot + axes + '</c:plotArea>' +
    legend +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:latin typeface="Yu Gothic"/></a:defRPr></a:pPr>' +
    '<a:endParaRPr lang="ja-JP"/></a:p></c:txPr>' +
    (hasWorkbook ? '<c:externalData r:id="rIdData"><c:autoUpdate val="0"/></c:externalData>' : '') +
    '</c:chartSpace>'
  );
}

/** The grid PowerPoint opens when the user clicks "Edit Data". */
export function chartWorkbookRows(spec) {
  const rows = [['', ...(spec.series || []).map((s) => s.name)]];
  (spec.categories || []).forEach((cat, i) => {
    rows.push([cat, ...(spec.series || []).map((s) => s.values[i] ?? '')]);
  });
  return rows;
}

const chartFrame = (id, relId, x, y, w, h) =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="Chart"/>' +
  '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
  '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(h) + '"/></p:xfrm>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="' + DOC_REL + '" r:id="' + relId + '"/>' +
  '</a:graphicData></a:graphic></p:graphicFrame>';

/* ================================ IMAGES ================================= */

/** Reads intrinsic pixel dimensions straight out of the file header. */
export function imageSize(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  // PNG: IHDR is always the first chunk.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF87a / GIF89a
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG: walk the segment chain to the SOF marker that carries the size.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = b[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2;
        continue;
      }
      const len = dv.getUint16(p + 2);
      // SOF0..SOF15, skipping the DHT/JPG/DAC markers interleaved in that range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(p + 5), width: dv.getUint16(p + 7) };
      }
      p += 2 + len;
    }
    return null;
  }
  // WebP (VP8 / VP8L / VP8X)
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (fourcc === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (fourcc === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export function imageExt(mime, bytes) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (bytes) {
    if (bytes[0] === 0x89) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
    if (bytes[0] === 0x47) return 'gif';
    if (bytes[0] === 0x52) return 'webp';
  }
  return 'png';
}

/** Largest box with the image's aspect ratio that fits the region, centred. */
function fitBox(image, x, y, w, h) {
  const size = imageSize(image.bytes) || { width: 16, height: 9 };
  const scale = Math.min(w / size.width, h / size.height);
  const cx = Math.round(size.width * scale);
  const cy = Math.round(size.height * scale);
  return { x: Math.round(x + (w - cx) / 2), y: Math.round(y + (h - cy) / 2), cx, cy };
}

/* ================================= PPTX ================================== */

/** Slides render plain runs, so markdown emphasis has to come off the text. */
export function stripInline(s) {
  return String(s ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    // Japanese has no word spaces, so emphasis is recognised by the marker
    // hugging its content — which also leaves `3 * 4 * 5` alone.
    .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .trim();
}

/** Every `![alt](src)` in a document, in order. */
export function imageMarkers(md) {
  return [...String(md || '').matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)].map((m) => ({
    alt: m[1].trim(),
    src: m[2].trim(),
  }));
}

/** Pulls fenced blocks out of a chunk so their contents never leak into text. */
function takeFences(chunk) {
  const fences = [];
  const body = String(chunk).replace(/```([\w-]*)\r?\n([\s\S]*?)```/g, (all, lang, inner) => {
    fences.push({ lang: (lang || '').toLowerCase(), body: inner });
    return '';
  });
  return { body, fences };
}

/**
 * Splits a markdown document into slides on `---` or on headings. Fenced
 * blocks are protected first, so a rule inside a fence is not a slide break.
 */
export function markdownToSlides(md) {
  const source = String(md || '').trim();
  if (!source) return [];

  const held = [];
  const masked = source.replace(/```[\s\S]*?```/g, (m) => {
    held.push(m);
    return 'FENCE' + (held.length - 1) + '';
  });
  const restore = (text) => text.replace(/FENCE(\d+)/g, (_, i) => held[Number(i)]);

  const chunks = [];
  if (/\n\s*---+\s*\n/.test(masked)) {
    chunks.push(...masked.split(/\n\s*---+\s*\n/));
  } else {
    let current = null;
    for (const line of masked.split(/\r?\n/)) {
      if (/^#{1,3}\s+/.test(line.trim())) {
        if (current) chunks.push(current.join('\n'));
        current = [line];
      } else {
        if (!current) current = [];
        current.push(line);
      }
    }
    if (current) chunks.push(current.join('\n'));
  }

  // Image markers are numbered across the whole document so a caller can
  // resolve them once and hand the bytes back in the same order.
  let imageIndex = 0;

  return chunks
    .map((raw) => {
      const { body: chunk, fences } = takeFences(restore(raw));
      const lines = chunk.split(/\r?\n/).filter((l) => l.trim() !== '');

      const chartFence = fences.find((f) => f.lang === 'chart');
      const diagramFence = fences.find((f) => f.lang === 'diagram');
      const chart = chartFence ? parseChartBlock(chartFence.body) : null;
      const diagram = diagramFence ? parseDiagramBlock(diagramFence.body) : null;
      if (!lines.length && !chart && !diagram) return null;

      const marks = imageMarkers(chunk);
      const imageRef = marks.length ? { ...marks[0], index: imageIndex } : null;
      imageIndex += marks.length;

      let title = '';
      let rest = lines;
      const head = /^(#{1,6})\s+(.*)$/.exec((lines[0] || '').trim());
      if (head) {
        title = stripInline(head[2]);
        rest = lines.slice(1);
      } else if (lines.length) {
        title = stripInline(lines[0].trim().replace(/^[-*+]\s+/, ''));
        rest = lines.slice(1);
      }

      // A table in the body becomes a real PowerPoint table rather than rows of
      // pipe characters.
      const tableLines = rest.filter((l) => l.trim().startsWith('|'));
      const table =
        tableLines.length > 1 ? parseMarkdownTable(tableLines.join('\n')).map((r) => r.map(stripInline)) : null;

      const bullets = rest
        .filter((l) => !l.trim().startsWith('|') && !/^!\[[^\]]*\]\([^)]*\)$/.test(l.trim()))
        .map((l) => stripInline(l.trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^#+\s+/, '')))
        .filter(Boolean);

      return { title, bullets, table: table && table.length ? table : null, chart, diagram, imageRef };
    })
    .filter(Boolean);
}

const EMU_W = 12192000; // 13.333in — 16:9
const EMU_H = 6858000;
const MARGIN = 838200;
const CONTENT_W = EMU_W - MARGIN * 2;

export const THEMES = {
  indigo: { accent: '3D54F5', ink: '1F1F1F', body: '3C3C3C', muted: '8A8A8F', wash: 'F4F5FE' },
  slate: { accent: '44546A', ink: '1F1F1F', body: '3C3C3C', muted: '8A8A8F', wash: 'F2F4F7' },
  forest: { accent: '2F8F5B', ink: '1B2B22', body: '35453C', muted: '84928A', wash: 'F1F8F4' },
  ember: { accent: 'D2632A', ink: '2B1D14', body: '46352B', muted: '9A8A80', wash: 'FCF4EE' },
  plum: { accent: '8E4EC6', ink: '241A2E', body: '413353', muted: '8F86A0', wash: 'F8F4FD' },
  ink: { accent: '1F1F1F', body: '3C3C3C', ink: '111111', muted: '8A8A8F', wash: 'F4F4F5' },
};

export const FONTS = {
  gothic: { latin: 'Segoe UI', ea: 'Yu Gothic', label: 'ゴシック（Yu Gothic）' },
  mincho: { latin: 'Georgia', ea: 'Yu Mincho', label: '明朝（Yu Mincho）' },
  meiryo: { latin: 'Segoe UI', ea: 'Meiryo', label: 'メイリオ' },
  rounded: { latin: 'Segoe UI', ea: 'BIZ UDPGothic', label: 'UDフォント' },
};

const fontOf = (key) => FONTS[key] || FONTS.gothic;

const latinAttr = (font) => '<a:latin typeface="' + esc(font.latin) + '"/><a:ea typeface="' + esc(font.ea) + '"/>';

const textBox = (id, name, x, y, w, h, paragraphs, anchor = 't') =>
  '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
  '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(h) + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
  '<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="' + anchor + '"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
  paragraphs +
  '</p:txBody></p:sp>';

const rect = (id, name, x, y, w, h, color) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
  '<p:spPr><a:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(y) + '"/>' +
  '<a:ext cx="' + Math.round(w) + '" cy="' + Math.round(h) + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
  '<a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
  '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';

const run = (value, { size = 1800, bold = false, color = '3C3C3C', font } = {}) =>
  '<a:r><a:rPr lang="ja-JP" altLang="en-US" sz="' + size + '"' + (bold ? ' b="1"' : '') + ' dirty="0">' +
  '<a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill>' +
  (font ? latinAttr(font) : '') +
  '</a:rPr><a:t>' + esc(value) + '</a:t></a:r>';

const para = (value, opts = {}) =>
  '<a:p><a:pPr algn="' + (opts.align || 'l') + '"' +
  (opts.space ? '><a:spcBef><a:spcPts val="' + opts.space + '"/></a:spcBef></a:pPr>' : '/>') +
  run(value, opts) + '</a:p>';

const bulletPara = (value, color, size, font) =>
  '<a:p><a:pPr marL="285750" indent="-285750"><a:spcBef><a:spcPts val="600"/></a:spcBef>' +
  '<a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>' +
  run(value, { size, color, font }) + '</a:p>';

const picture = (id, relId, box) =>
  '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="Picture ' + id + '"/>' +
  '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
  '<p:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
  '<p:spPr><a:xfrm><a:off x="' + box.x + '" y="' + box.y + '"/><a:ext cx="' + box.cx + '" cy="' + box.cy + '"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';

const cellBorders = ['lnL', 'lnR', 'lnT', 'lnB']
  .map((s) => '<a:' + s + ' w="12700" cap="flat"><a:solidFill><a:srgbClr val="DCDCE4"/></a:solidFill></a:' + s + '>')
  .join('');

/** A markdown table rendered as a native PowerPoint table. */
function tableFrame(id, rows, x, y, w, h, theme, font) {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 1);
  const colWidth = Math.floor(w / cols);
  // Rows grow to use the space available rather than leaving the lower half of
  // the slide empty, but stop short of looking stretched.
  const rowHeight = Math.max(320000, Math.min(760000, Math.floor(h / Math.max(1, rows.length))));
  const top = y + Math.max(0, (h - rowHeight * rows.length) / 2);

  const cell = (value, header) =>
    '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/>' +
    run(value ?? '', { size: 1400, bold: header, color: header ? 'FFFFFF' : theme.body, font }) +
    '</a:p></a:txBody>' +
    '<a:tcPr marL="82550" marR="82550" marT="45720" marB="45720" anchor="ctr">' + cellBorders +
    '<a:solidFill><a:srgbClr val="' + (header ? theme.accent : 'FFFFFF') + '"/></a:solidFill>' +
    '</a:tcPr></a:tc>';

  return (
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="Table"/>' +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="' + Math.round(x) + '" y="' + Math.round(top) + '"/>' +
    '<a:ext cx="' + Math.round(w) + '" cy="' + rowHeight * rows.length + '"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>' +
    Array.from({ length: cols }, () => '<a:gridCol w="' + colWidth + '"/>').join('') +
    '</a:tblGrid>' +
    rows
      .map((r, i) => '<a:tr h="' + rowHeight + '">' + Array.from({ length: cols }, (_, c) => cell(r[c], i === 0)).join('') + '</a:tr>')
      .join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

/** Picks the arrangement that suits what the slide actually holds. */
export function layoutFor(slide, index) {
  if (slide.layout) return slide.layout;
  if (slide.chart) return 'chart';
  if (slide.diagram) return 'diagram';
  if (index === 0 && !slide.table && !slide.image && (slide.bullets || []).length <= 3) return 'title';
  if (slide.table) return 'table';
  if (slide.image) return (slide.bullets || []).length ? 'image-right' : 'image-full';
  return 'bullets';
}

function slideXmlFor(slide, index, total, theme, font) {
  const layout = layoutFor(slide, index);
  const bullets = slide.bullets || [];
  const shapes = [];
  let id = 2;
  const next = () => id++;

  if (layout === 'title') {
    shapes.push(rect(next(), 'Wash', EMU_W - 3200400, 0, 3200400, EMU_H, theme.wash));
    shapes.push(rect(next(), 'Accent', MARGIN, 2438400, 1143000, 68580, theme.accent));
    shapes.push(
      textBox(next(), 'Title', MARGIN, 2700000, CONTENT_W - 2400000, 1600200,
        para(slide.title, { size: 4400, bold: true, color: theme.ink, font }))
    );
    if (bullets.length) {
      shapes.push(
        textBox(next(), 'Subtitle', MARGIN, 4419600, CONTENT_W - 2400000, 1200000,
          bullets.map((b) => para(b, { size: 1800, color: theme.muted, space: 300, font })).join(''))
      );
    }
  } else {
    shapes.push(
      textBox(next(), 'Title', MARGIN, 548640, CONTENT_W, 914400,
        para(slide.title, { size: 2800, bold: true, color: theme.ink, font }))
    );
    shapes.push(rect(next(), 'Rule', MARGIN, 1508760, 685800, 45720, theme.accent));

    const bodyTop = 1874520;
    const bodyH = EMU_H - bodyTop - 685800;

    if (layout === 'image-right') {
      const textW = Math.round(CONTENT_W * 0.46);
      const gap = 457200;
      // Anchored to the middle so a short list sits beside the picture rather
      // than clinging to the top of an otherwise empty column.
      shapes.push(
        textBox(next(), 'Body', MARGIN, bodyTop, textW, bodyH,
          bullets.map((b) => bulletPara(b, theme.body, 1800, font)).join(''), 'ctr')
      );
      const imgX = MARGIN + textW + gap;
      shapes.push(picture(next(), slide.image.relId, fitBox(slide.image, imgX, bodyTop, EMU_W - MARGIN - imgX, bodyH)));
    } else if (layout === 'image-full') {
      shapes.push(picture(next(), slide.image.relId, fitBox(slide.image, MARGIN, bodyTop, CONTENT_W, bodyH)));
    } else if (layout === 'chart' || layout === 'diagram') {
      let top = bodyTop;
      let height = bodyH;
      if (bullets.length) {
        const h = Math.min(height * 0.32, bullets.length * 380000 + 90000);
        shapes.push(textBox(next(), 'Body', MARGIN, top, CONTENT_W, h, bullets.map((b) => bulletPara(b, theme.body, 1500, font)).join('')));
        top += h + 137160;
        height = EMU_H - top - 685800;
      }
      if (layout === 'chart') {
        shapes.push(chartFrame(next(), slide.chart.relId, MARGIN, top, CONTENT_W, height));
      } else {
        shapes.push(diagramShapes(slide.diagram, next(), MARGIN, top, CONTENT_W, height, theme));
        // The diagram consumed a run of ids of its own.
        id += diagramShapeCount(slide.diagram, theme);
      }
    } else if (layout === 'table') {
      let top = bodyTop;
      if (bullets.length) {
        const h = Math.min(bodyH * 0.4, bullets.length * 400000 + 100000);
        shapes.push(textBox(next(), 'Body', MARGIN, top, CONTENT_W, h, bullets.map((b) => bulletPara(b, theme.body, 1600, font)).join('')));
        top += h + 182880;
      }
      shapes.push(tableFrame(next(), slide.table, MARGIN, top, CONTENT_W, EMU_H - top - 685800, theme, font));
    } else {
      shapes.push(
        textBox(next(), 'Body', MARGIN, bodyTop, CONTENT_W, bodyH,
          bullets.length
            ? bullets.map((b) => bulletPara(b, theme.body, 1800, font)).join('')
            : '<a:p><a:endParaRPr lang="ja-JP"/></a:p>')
      );
    }

    shapes.push(
      textBox(next(), 'PageNo', EMU_W - MARGIN - 914400, EMU_H - 594360, 914400, 320040,
        para(String(index + 1) + ' / ' + total, { size: 1000, color: theme.muted, align: 'r', font }))
    );
  }

  return (
    XML +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + DOC_REL + '" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

const THEME_XML = (theme, font) =>
  XML +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements>' +
  '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="' + theme.ink + '"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="' + theme.wash + '"/></a:lt2><a:accent1><a:srgbClr val="' + theme.accent + '"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="' + esc(font.latin) + '"/><a:ea typeface="' + esc(font.ea) + '"/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="' + esc(font.latin) + '"/><a:ea typeface="' + esc(font.ea) + '"/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="Office">' +
  '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  ['6350', '12700', '19050']
    .map((w) => '<a:ln w="' + w + '" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>')
    .join('') +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements></a:theme>';

const EMPTY_SPTREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

const SLIDE_MASTER =
  XML +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + DOC_REL + '" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  EMPTY_SPTREE + '</p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';

const SLIDE_LAYOUT =
  XML +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + DOC_REL + '" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="白紙">' + EMPTY_SPTREE + '</p:cSld>' +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const IMAGE_CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * @param {{title: string, bullets: string[], table?: string[][], chart?: object,
 *          diagram?: object, image?: {bytes: Uint8Array, mime?: string},
 *          layout?: string}[]} slides
 */
export async function buildPptx(slides, { theme = 'indigo', font = 'gothic' } = {}) {
  const palette = THEMES[theme] || THEMES.indigo;
  const typeface = fontOf(font);
  const list = (slides || []).filter(
    (s) => s && (s.title || (s.bullets || []).length || s.table || s.image || s.chart || s.diagram)
  );
  if (!list.length) list.push({ title: '（内容がありません）', bullets: [] });

  // Pictures and charts each become their own part plus a slide relationship.
  const media = [];
  const charts = [];
  const prepared = list.map((slide) => {
    const out = { ...slide, bullets: slide.bullets || [], image: null, chart: null };
    if (slide.image?.bytes?.length) {
      const ext = imageExt(slide.image.mime, slide.image.bytes);
      const name = 'image' + (media.length + 1) + '.' + ext;
      media.push({ name, ext, bytes: slide.image.bytes });
      out.image = { ...slide.image, relId: 'rIdImg', part: name };
    }
    if (slide.chart?.series?.length) {
      const n = charts.length + 1;
      charts.push({ n, spec: slide.chart });
      out.chart = { ...slide.chart, relId: 'rIdChart', part: 'chart' + n + '.xml' };
    }
    return out;
  });

  // The embedded workbook is what PowerPoint opens behind "Edit Data".
  const workbooks = await Promise.all(
    charts.map((c) => buildXlsx([{ name: 'Sheet1', rows: chartWorkbookRows(c.spec) }], { header: false }))
  );

  const usedExts = [...new Set(media.map((m) => m.ext))];
  const ids = prepared.map((_, i) => i + 1);

  return zip([
    {
      name: '[Content_Types].xml',
      data:
        XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        usedExts.map((e) => '<Default Extension="' + e + '" ContentType="' + IMAGE_CONTENT_TYPES[e] + '"/>').join('') +
        (charts.length ? '<Default Extension="xlsx" ContentType="' + XLSX_CT + '"/>' : '') +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        charts.map((c) => '<Override PartName="/ppt/charts/chart' + c.n + '.xml" ContentType="' + CHART_CT + '"/>').join('') +
        ids
          .map((n) =>
            '<Override PartName="/ppt/slides/slide' + n + '.xml" ' +
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
          )
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    },
    {
      name: 'ppt/presentation.xml',
      data:
        XML +
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + DOC_REL + '" ' +
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>' +
        '<p:sldIdLst>' + ids.map((n) => '<p:sldId id="' + (255 + n) + '" r:id="rIdSlide' + n + '"/>').join('') + '</p:sldIdLst>' +
        '<p:sldSz cx="' + EMU_W + '" cy="' + EMU_H + '"/><p:notesSz cx="' + EMU_H + '" cy="' + EMU_W + '"/>' +
        '</p:presentation>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rIdMaster" Type="' + DOC_REL + '/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
        ids.map((n) => '<Relationship Id="rIdSlide' + n + '" Type="' + DOC_REL + '/slide" Target="slides/slide' + n + '.xml"/>').join('') +
        '<Relationship Id="rIdTheme" Type="' + DOC_REL + '/theme" Target="theme/theme1.xml"/></Relationships>',
    },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        '<Relationship Id="rId2" Type="' + DOC_REL + '/theme" Target="../theme/theme1.xml"/></Relationships>',
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
    },
    { name: 'ppt/theme/theme1.xml', data: THEME_XML(palette, typeface) },
    ...media.map((m) => ({ name: 'ppt/media/' + m.name, data: m.bytes })),
    ...charts.map((c) => ({ name: 'ppt/charts/chart' + c.n + '.xml', data: chartXml(c.spec, palette) })),
    ...charts.map((c) => ({
      name: 'ppt/charts/_rels/chart' + c.n + '.xml.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rIdData" Type="' + DOC_REL + '/package" Target="../embeddings/chart' + c.n + '.xlsx"/>' +
        '</Relationships>',
    })),
    ...charts.map((c, i) => ({ name: 'ppt/embeddings/chart' + c.n + '.xlsx', data: workbooks[i] })),
    ...prepared.map((slide, i) => ({
      name: 'ppt/slides/slide' + (i + 1) + '.xml',
      data: slideXmlFor(slide, i, prepared.length, palette, typeface),
    })),
    ...prepared.map((slide, i) => ({
      name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels',
      data:
        XML + '<Relationships xmlns="' + REL_NS + '">' +
        '<Relationship Id="rId1" Type="' + DOC_REL + '/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        (slide.image ? '<Relationship Id="rIdImg" Type="' + DOC_REL + '/image" Target="../media/' + slide.image.part + '"/>' : '') +
        (slide.chart ? '<Relationship Id="rIdChart" Type="' + DOC_REL + '/chart" Target="../charts/' + slide.chart.part + '"/>' : '') +
        '</Relationships>',
    })),
  ]);
}

export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  html: 'text/html; charset=utf-8',
};
