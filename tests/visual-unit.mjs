// Charts, diagrams, embedded pictures and batch image generation.
import { writeFileSync } from 'node:fs';
import { unzip } from '../src/lib/zip.js';
import {
  buildPptx, buildDocx, markdownToSlides, layoutFor, gridToChart, parseChartBlock, chartXml,
  chartWorkbookRows, parseDiagramBlock, diagramShapes, normalizeChartType, normalizeDiagramType,
  imageSize, imageExt, THEMES, FONTS,
} from '../src/lib/office.js';
import { planBatches, buildImageRequest, imagesFrom, costOf } from '../src/lib/images.js';

const outDir = process.argv[2] || null;
const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};
const txt = (b) => new TextDecoder().decode(b);

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAQAAAACgCAIAAABmXqf1AAAAX0lEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBmXQAB1kK5FAAAAABJRU5ErkJggg==',
    'base64'
  )
);
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0x01, 0x22,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]);

/* ------------------------------ image headers --------------------------- */
check('PNG のサイズを読む', JSON.stringify(imageSize(PNG)) === '{"width":256,"height":160}', JSON.stringify(imageSize(PNG)));
check('JPEG のサイズを読む', JSON.stringify(imageSize(JPEG)) === '{"height":100,"width":200}', JSON.stringify(imageSize(JPEG)));
check('拡張子を判別', imageExt('', PNG) === 'png' && imageExt('image/jpeg') === 'jpeg' && imageExt('image/webp') === 'webp');
check('壊れたデータは null', imageSize(new Uint8Array([1, 2, 3])) === null);

/* --------------------------------- charts -------------------------------- */
const chart = parseChartBlock(
  ['type: bar', 'title: 売上', '| 部門 | 今期 | 前期 |', '|---|---|---|', '| 国内 | 4.2 | 3.8 |', '| 海外 | 1.8 | 1.4 |'].join('\n')
);
check('チャートブロックを読む', chart?.series.length === 2 && chart.categories.length === 2, JSON.stringify(chart?.categories));
check('  系列名が入る', chart.series[0].name === '今期' && chart.series[1].name === '前期');
check('  数値になる', chart.series[0].values[0] === 4.2 && chart.series[1].values[1] === 1.4);
check('CSV 形式でも読む', parseChartBlock('type: line\n月,売上\n4月,120\n5月,138')?.series[0].values.join(',') === '120,138');
check('桁区切りを外す', gridToChart([['月', '売上'], ['4月', '1,240']])?.series[0].values[0] === 1240);
check('単位付きも拾う', gridToChart([['月', '率'], ['4月', '2.1%']])?.series[0].values[0] === 2.1);
check('文字列だけの列は系列にしない', gridToChart([['a', 'b'], ['x', 'y'], ['p', 'q']]) === null);
check('円グラフは1系列だけ', parseChartBlock('type: pie\n| a | b | c |\n|---|---|---|\n| x | 1 | 2 |').series.length === 1);
check('種類を正規化', normalizeChartType('折れ線') === 'line' && normalizeChartType('円') === 'pie' && normalizeChartType('なにか') === 'bar');

const cx = chartXml(chart, THEMES.indigo);
check('チャートXMLに値が入る', cx.includes('<c:v>4.2</c:v>') && cx.includes('<c:v>国内</c:v>'));
check('  凡例が付く', cx.includes('<c:legend>'));
check('  埋め込みブックを参照する', cx.includes('<c:externalData r:id="rIdData"'));
check('ブック用の行を作る', JSON.stringify(chartWorkbookRows(chart)[1]) === '["国内",4.2,3.8]', JSON.stringify(chartWorkbookRows(chart)[1]));

/* -------------------------------- diagrams ------------------------------- */
const dia = parseDiagramBlock('type: process\n調査: 現状把握\n設計: 方針決定\n実装: 開発');
check('図解ブロックを読む', dia?.items.length === 3 && dia.type === 'process');
check('  ラベルと説明に分かれる', dia.items[0].label === '調査' && dia.items[0].note === '現状把握');
check('種類を正規化', normalizeDiagramType('ピラミッド') === 'pyramid' && normalizeDiagramType('マトリクス') === 'matrix');
for (const type of ['process', 'cycle', 'matrix', 'compare', 'stack']) {
  const xml = diagramShapes({ type, items: dia.items }, 10, 0, 0, 1000000, 1000000, THEMES.indigo);
  check('  ' + type + ' が図形を出す', xml.includes('<p:sp>') && (xml.match(/<p:sp>/g) || []).length === 3, (xml.match(/<p:sp>/g) || []).length + ' shapes');
}
const pyr = diagramShapes({ type: 'pyramid', items: dia.items }, 10, 0, 0, 4000000, 2600000, THEMES.indigo);
check('  pyramid は角錐をスライスする', (pyr.match(/<a:custGeom>/g) || []).length === 6, (pyr.match(/<a:custGeom>/g) || []).length + ' polygons');
check('    層ごとに正面と側面が出る', (pyr.match(/name="Layer \d+"/g) || []).length === 3 && (pyr.match(/name="Layer \d+ side"/g) || []).length === 3);
check('    ラベルが層の数だけ載る', (pyr.match(/name="Label"/g) || []).length === 3);
check('    白い境界線が入る', pyr.includes('<a:srgbClr val="FFFFFF"/></a:solidFill><a:round/>'));
check('    影は最下層だけ', (pyr.match(/<a:outerShdw/g) || []).length === 2, (pyr.match(/<a:outerShdw/g) || []).length + ' shadows');
check('    多角形はすべて閉じている', (pyr.match(/<a:close\/>/g) || []).length === 6);
const apexPath = (pyr.split('name="Layer 1"')[1] || '').split('</a:pathLst>')[0];
check('    頂点の層は三角形', (apexPath.match(/<a:pt /g) || []).length === 3, (apexPath.match(/<a:pt /g) || []).length + ' points');
const midPath = (pyr.split('name="Layer 2"')[1] || '').split('</a:pathLst>')[0];
check('    中間の層は四角形', (midPath.match(/<a:pt /g) || []).length === 4, (midPath.match(/<a:pt /g) || []).length + ' points');

/* --------------------------- layout selection ---------------------------- */
check('1枚目はタイトル', layoutFor({ bullets: ['a'] }, 0) === 'title');
check('チャートが最優先', layoutFor({ bullets: [], chart: {}, table: [[1]] }, 1) === 'chart');
check('図解も専用レイアウト', layoutFor({ bullets: [], diagram: {} }, 1) === 'diagram');
check('画像＋箇条書きは左右分割', layoutFor({ bullets: ['a'], image: {} }, 1) === 'image-right');
check('画像だけなら全面', layoutFor({ bullets: [], image: {} }, 1) === 'image-full');

/* ---------------------------- pptx integration --------------------------- */
const md = [
  '# 表紙', '- サブタイトル', '',
  '# グラフ', '', '```chart', 'type: bar', '| a | b |', '|---|---|', '| x | 1 |', '| y | 2 |', '```', '',
  '# 図解', '', '```diagram', 'type: process', '一: A', '二: B', '```', '',
  '# 写真', '- 説明', '', '![街の風景](gen)',
].join('\n');
const slides = markdownToSlides(md);
check('フェンスがスライドを壊さない', slides.length === 4, slides.map((s) => s.title).join('/'));
check('  --- がフェンス内にあっても分割しない', markdownToSlides('# A\n\n```chart\ntype: bar\n---\n```\n').length === 1);
check('  画像マーカーを番号付けする', slides[3].imageRef?.index === 0 && slides[3].imageRef.alt === '街の風景');
check('  フェンスの中身が箇条書きに漏れない', !slides[1].bullets.join('').includes('type:'), JSON.stringify(slides[1].bullets));

slides[3].image = { bytes: PNG, mime: 'image/png' };
const pptx = await buildPptx(slides, { theme: 'plum', font: 'mincho' });
if (outDir) writeFileSync(outDir + '/visual.pptx', pptx);
const parts = await unzip(pptx);
check('PPTX にチャートパーツが入る', !!parts['ppt/charts/chart1.xml'], Object.keys(parts).filter((k) => k.includes('chart')).join(', '));
check('  埋め込みブックも入る', !!parts['ppt/embeddings/chart1.xlsx']);
check('  チャートのrelsが張られる', txt(parts['ppt/slides/_rels/slide2.xml.rels']).includes('../charts/chart1.xml'));
check('  Content-Types に chart がある', txt(parts['[Content_Types].xml']).includes('drawingml.chart+xml'));
check('PPTX に画像が入る', !!parts['ppt/media/image1.png'] && txt(parts['[Content_Types].xml']).includes('Extension="png"'));
check('  画像のrelsが張られる', txt(parts['ppt/slides/_rels/slide4.xml.rels']).includes('../media/image1.png'));
check('  スライドが picture を描く', txt(parts['ppt/slides/slide4.xml']).includes('<p:pic>'));
check('配色が反映される', txt(parts['ppt/theme/theme1.xml']).includes(THEMES.plum.accent));
check('フォントが反映される', txt(parts['ppt/theme/theme1.xml']).includes(FONTS.mincho.ea), FONTS.mincho.ea);
check('図解スライドに図形が並ぶ', (txt(parts['ppt/slides/slide3.xml']).match(/<p:sp>/g) || []).length >= 4);

/* ---------------------------- docx integration --------------------------- */
const docx = await buildDocx('# 見出し\n\n本文。\n\n![外観](gen)\n\n締め。', { images: [{ bytes: PNG, mime: 'image/png' }] });
if (outDir) writeFileSync(outDir + '/visual.docx', docx);
const dparts = await unzip(docx);
check('DOCX に画像が入る', !!dparts['word/media/image1.png']);
check('  drawing が描かれる', txt(dparts['word/document.xml']).includes('<w:drawing>'));
check('  キャプションが付く', txt(dparts['word/document.xml']).includes('外観') && txt(dparts['word/styles.xml']).includes('Caption'));
check('  rels に画像がある', txt(dparts['word/_rels/document.xml.rels']).includes('media/image1.png'));
const noImg = await unzip(await buildDocx('# 画像なし\n\n本文。'));
check('画像が無ければパーツも作らない', !Object.keys(noImg).some((k) => k.startsWith('word/media/')));

/* ------------------------- batch image generation ------------------------ */
check('n=10 のモデルは1回で済む', JSON.stringify(planBatches(8, 10)) === '[8]');
check('n=1 のモデルは分割する', JSON.stringify(planBatches(4, 1)) === '[1,1,1,1]');
check('端数も分割する', JSON.stringify(planBatches(7, 4)) === '[4,3]');
check('0 でも1回は走る', JSON.stringify(planBatches(0, 4)) === '[1]');

const model = { id: 'x/y', maxN: 4, aspectRatios: ['1:1', '16:9'], qualities: ['high'], resolutions: [], backgrounds: [], outputFormats: [], seed: true, maxReferences: 2 };
let req = buildImageRequest(model, { prompt: '猫', n: 3, aspectRatio: '16:9', quality: 'high', seed: 7 });
check('対応パラメータだけ送る', JSON.stringify(req.body) === '{"model":"x/y","prompt":"猫","n":3,"aspect_ratio":"16:9","quality":"high","seed":7}', JSON.stringify(req.body));
req = buildImageRequest(model, { prompt: '猫', n: 99, aspectRatio: '4:3', resolution: '4k' });
check('  モデル上限で丸める', req.body.n === 4 && req.requested === 4);
check('  非対応の値は落とす', !('aspect_ratio' in req.body) && !('resolution' in req.body), JSON.stringify(req.body));
req = buildImageRequest({ ...model, maxN: 1 }, { prompt: '猫', n: 1 });
check('  n=1 は送らない', !('n' in req.body), JSON.stringify(req.body));
req = buildImageRequest(model, { prompt: '猫', n: 1, references: ['data:image/png;base64,AA', 'x', 'y'] });
check('  参照画像は上限まで', req.body.input_references.length === 2);

const b64 = Buffer.from(PNG).toString('base64');
check('b64_json を取り出す', imagesFrom({ data: [{ b64_json: b64, media_type: 'image/png' }] })[0]?.bytes.length === PNG.length);
check('data URL も取り出す', imagesFrom({ data: [{ url: 'data:image/png;base64,' + b64 }] })[0]?.mime === 'image/png');
check('複数枚まとめて取り出す', imagesFrom({ data: [{ b64_json: b64 }, { b64_json: b64 }] }).length === 2);
check('壊れた要素は飛ばす', imagesFrom({ data: [{ b64_json: '###' }, { b64_json: b64 }] }).length === 1);
check('コストを読む', costOf({ usage: { cost: 0.012 } }) === 0.012 && costOf({}) === null);

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2]));
  process.exit(1);
}
