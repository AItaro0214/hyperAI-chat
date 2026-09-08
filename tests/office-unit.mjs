// Round-trips every document format through the writers and back through the
// readers. Pass a directory as argv[2] to also drop the generated files there
// for opening in real Office.
import { writeFileSync } from 'node:fs';
import { zip, unzip } from '../src/lib/zip.js';
import { buildXlsx, buildDocx, buildPptx, markdownToSlides, parseDelimited, toCsv, parseMarkdownTable, colName, stripInline } from '../src/lib/office.js';
import { extractDocument, docKindOf } from '../src/lib/docs.js';

const outDir = process.argv[2] || null;
const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};
const save = (name, bytes) => {
  if (outDir) writeFileSync(outDir + '/' + name, bytes);
};

/* --------------------------------- zip ---------------------------------- */
const archive = await zip([
  { name: 'a.txt', data: 'hello' },
  { name: 'nested/b.txt', data: 'x'.repeat(5000) },
]);
check('ZIP を生成できる', archive[0] === 0x50 && archive[1] === 0x4b, archive.length + ' bytes');
const back = await unzip(archive);
check('  無圧縮エントリを読める', new TextDecoder().decode(back['a.txt']) === 'hello');
check('  deflate エントリを読める', new TextDecoder().decode(back['nested/b.txt']) === 'x'.repeat(5000));
check('  大きい部分は圧縮される', archive.length < 5000, archive.length + ' bytes for 5005 raw');

/* -------------------------------- helpers ------------------------------- */
check('列名 A/Z/AA/AB', colName(0) === 'A' && colName(25) === 'Z' && colName(26) === 'AA' && colName(27) === 'AB');
const csv = '商品,数量,単価,売上\nりんご,120,180,21600\n"バナナ, 大房",75,240,18000\n"引用""付き",1,2,3';
const rows = parseDelimited(csv);
check('CSV をパースできる', rows.length === 4 && rows[2][0] === 'バナナ, 大房' && rows[3][0] === '引用"付き', JSON.stringify(rows[2]));
check('CSV に書き戻せる', parseDelimited(toCsv(rows))[2][0] === 'バナナ, 大房');
check('TSV も自動判別', parseDelimited('a\tb\n1\t2')[1][1] === '2');
check('markdown テーブルを拾う', JSON.stringify(parseMarkdownTable('| 部門 | 売上 |\n|---|---|\n| 国内 | 4.2億 |')) === '[["部門","売上"],["国内","4.2億"]]');

/* --------------------------------- xlsx --------------------------------- */
const sheetRows = parseDelimited('商品,数量,単価,売上\nりんご,120,180,21600\nみかん,340,90,30600\n"バナナ, 大房",75,240,18000');
const xlsx = await buildXlsx([
  { name: '売上', rows: sheetRows },
  { name: 'メモ', rows: [['項目', '内容'], ['作成', '自動生成']] },
]);
save('sample.xlsx', xlsx);
check('XLSX を生成できる', xlsx.length > 1000, xlsx.length + ' bytes');
const xread = await extractDocument(xlsx, 'sample.xlsx', '');
check('  自前で読み戻せる', !!xread && xread.kind === 'office');
check('  シート名が両方出る', xread.text.includes('シート: 売上') && xread.text.includes('シート: メモ'));
check('  日本語セルが往復する', xread.text.includes('りんご') && xread.text.includes('みかん'));
check('  カンマ入りセルが壊れない', xread.text.includes('"バナナ, 大房"'), (xread.text.match(/.*バナナ.*/) || [''])[0]);
check('  数値がそのまま入る', /りんご,120,180,21600/.test(xread.text));
const parts = await unzip(xlsx);
check('  必須パートが揃っている',
  ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']
    .every((k) => parts[k]),
  Object.keys(parts).length + ' parts');
const longId = await buildXlsx([{ name: 'x', rows: [['id'], ['12345678901234567890']] }]);
check('  長い数字列はテキスト扱い', new TextDecoder().decode((await unzip(longId))['xl/worksheets/sheet1.xml']).includes('inlineStr'));
const named = await unzip(await buildXlsx([{ name: 'a/b:c*d[e]', rows: [['x']] }]));
check('  禁止文字を含むシート名を直す', !/name="a\/b/.test(new TextDecoder().decode(named['xl/workbook.xml'])));

/* --------------------------------- docx --------------------------------- */
const md = `# 四半期レポート

売上は前年比 **18%** 増、主因は *新規顧客* です。

## 内訳

| 部門 | 売上 | 前年比 |
|---|---|---|
| 国内 | 4.2億 | +12% |
| 海外 | 1.8億 | +31% |

## 次のアクション

- 海外チームを 3 名増員
- 価格改定を 6 月に実施
`;
const docx = await buildDocx(md);
save('sample.docx', docx);
check('DOCX を生成できる', docx.length > 1000, docx.length + ' bytes');
const dread = await extractDocument(docx, 'sample.docx', '');
check('  自前で読み戻せる', !!dread && dread.text.includes('四半期レポート'));
check('  見出しが階層で戻る', /^# 四半期レポート/m.test(dread.text) && /^## 内訳/m.test(dread.text), dread.text.split('\n')[0]);
check('  表がセルごとに戻る', dread.text.includes('| 国内 | 4.2億 | +12% |'), (dread.text.match(/\|.*国内.*\|/) || [''])[0]);
check('  箇条書きが戻る', dread.text.includes('- 海外チームを 3 名増員'));
check('  太字/斜体の記号は本文に混ざらない', dread.text.includes('前年比 18% 増') && !dread.text.includes('**'));
const dparts = await unzip(docx);
check('  必須パートが揃っている',
  ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels'].every((k) => dparts[k]));

/* --------------------------------- pptx --------------------------------- */
const slides = markdownToSlides(md);
check('markdown をスライドに割る', slides.length === 3 && slides[0].title === '四半期レポート', slides.map((s) => s.title).join(' / '));
check('  箇条書きが本文になる', slides[2].bullets.includes('海外チームを 3 名増員'), JSON.stringify(slides[2].bullets));
check('  --- 区切りも使える', markdownToSlides('# A\n- x\n\n---\n\n# B\n- y').length === 2);
const pptx = await buildPptx(slides);
save('sample.pptx', pptx);
check('PPTX を生成できる', pptx.length > 2000, pptx.length + ' bytes');
const pread = await extractDocument(pptx, 'sample.pptx', '');
check('  自前で読み戻せる', !!pread && pread.text.includes('四半期レポート'));
check('  スライドが3枚', (pread.text.match(/## スライド /g) || []).length === 3);
check('  本文テキストが戻る', pread.text.includes('海外チームを 3 名増員'));
check('  markdown 記号がスライドに残らない', !pread.text.includes('**') && !/\|---/.test(pread.text), (pread.text.match(/.*18%.*/) || [''])[0]);
check('強調記号を除去', stripInline('**太字**と*斜体*と`code`') === '太字と斜体とcode', stripInline('**太字**と*斜体*と`code`'));
check('  掛け算などは壊さない', stripInline('3 * 4 = 12') === '3 * 4 = 12', stripInline('3 * 4 = 12'));
check('  リンクはテキストだけ残す', stripInline('[売上](https://x)') === '売上');
const pparts = await unzip(pptx);
check('  必須パートが揃っている',
  ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
   'ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
   'ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
   'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels'].every((k) => pparts[k]),
  Object.keys(pparts).length + ' parts');
check('  表はネイティブの表になる', new TextDecoder().decode(pparts['ppt/slides/slide2.xml']).includes('<a:tbl>'));

/* ------------------------------ classification -------------------------- */
check('PDF はプロバイダ任せ', docKindOf('a.pdf', 'application/pdf') === 'pdf');
check('Office は自前抽出', docKindOf('a.xlsx') === 'office' && docKindOf('a.docx') === 'office' && docKindOf('a.pptx') === 'office');
check('テキスト系は自前抽出', docKindOf('a.csv') === 'text' && docKindOf('a.py') === 'text' && docKindOf('x', 'text/plain') === 'text');
check('未知は unknown', docKindOf('a.bin', 'application/octet-stream') === 'unknown');
const plain = await extractDocument(new TextEncoder().encode('﻿あ,い\n1,2'), 'a.csv', 'text/csv');
check('BOM を落とす', plain.text === 'あ,い\n1,2', JSON.stringify(plain.text));
check('PDF は null を返す', (await extractDocument(new Uint8Array([37, 80, 68, 70]), 'a.pdf', 'application/pdf')) === null);
const big = await extractDocument(new TextEncoder().encode('x'.repeat(500)), 'a.txt', 'text/plain', { chars: 100 });
check('上限で切り詰めて印を付ける', big.text.length === 100 && big.truncated === true);

/* -------------------------- reading real workbooks ---------------------- */
// A sheet written with shared strings and a date style, the way Excel does it.
const excelLike = await zip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
  { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="実績" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
  { name: 'xl/sharedStrings.xml', data: '<sst><si><t>名前</t></si><si><t>日付</t></si><si><r><t>山</t></r><r><t>田</t></r></si></sst>' },
  { name: 'xl/styles.xml', data: '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' },
  {
    name: 'xl/worksheets/sheet1.xml',
    data:
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46023</v></c></row>' +
      '<row r="3"><c r="C3" t="b"><v>1</v></c></row>' +
      '</sheetData></worksheet>',
  },
]);
const eread = await extractDocument(excelLike, 'real.xlsx', '');
check('共有文字列を解決する', eread.text.includes('名前,日付'), eread.text.split('\n')[1]);
check('  リッチテキストの分割を連結する', eread.text.includes('山田'));
check('  日付書式をISOに直す', eread.text.includes('2026-01-01'), (eread.text.match(/山田,.*/) || [''])[0]);
check('  歯抜けの行を詰めない', /^,,TRUE$/m.test(eread.text), JSON.stringify(eread.text.split('\n').pop()));
check('  シート名を rels 経由で解決する', eread.text.includes('シート: 実績'));

console.log('');
if (outDir) console.log('生成物: ' + outDir);
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2]));
  process.exit(1);
}
