// Generates a full-featured deck for opening in real PowerPoint.
import { writeFileSync } from 'node:fs';
import { markdownToSlides, buildPptx, buildDocx } from '../src/lib/office.js';

const out = process.argv[2] || '.';

import { placeholderPhoto } from './make-png.mjs';

// A generated gradient stands in for a real photo.
const png = await placeholderPhoto();

const md = [
  '# 2026年 事業レビュー',
  '- 経営企画部',
  '- 2026年9月',
  '',
  '# 業績サマリー',
  '- 売上は前年比 **18%** 増',
  '- 海外が牽引',
  '',
  '```chart',
  'type: bar',
  'title: 部門別売上（億円）',
  '| 部門 | 今期 | 前期 |',
  '|---|---|---|',
  '| 国内 | 4.2 | 3.8 |',
  '| 海外 | 1.8 | 1.4 |',
  '| EC | 2.6 | 1.9 |',
  '```',
  '',
  '# 推移',
  '',
  '```chart',
  'type: line',
  'title: 月次売上',
  '月,売上',
  '4月,120',
  '5月,138',
  '6月,151',
  '7月,149',
  '8月,172',
  '```',
  '',
  '# 構成比',
  '',
  '```chart',
  'type: pie',
  'title: チャネル別',
  '| チャネル | 比率 |',
  '|---|---|',
  '| 直販 | 45 |',
  '| 代理店 | 30 |',
  '| EC | 25 |',
  '```',
  '',
  '# 進め方',
  '',
  '```diagram',
  'type: process',
  '調査: 現状把握',
  '設計: 方針決定',
  '実装: 開発',
  '検証: 効果測定',
  '```',
  '',
  '# 優先度の整理',
  '',
  '```diagram',
  'type: matrix',
  '最優先: 効果大・工数小',
  '計画的に: 効果大・工数大',
  '余裕があれば: 効果小・工数小',
  '見送り: 効果小・工数大',
  '```',
  '',
  '# 体制',
  '',
  '```diagram',
  'type: pyramid',
  '経営: 意思決定',
  '推進: 部門横断',
  '現場: 実行',
  '```',
  '',
  '# 詳細データ',
  '- 参考値です',
  '',
  '| 指標 | 値 |',
  '|---|---|',
  '| 新規顧客 | 1,240 |',
  '| 解約率 | 2.1% |',
  '',
  '# イメージ',
  '- 新オフィスの外観',
  '',
  '![新オフィス](gen)',
].join('\n');

const slides = markdownToSlides(md);
console.log('slides:', slides.length);
slides.forEach((s, i) => {
  console.log(
    ' ' + (i + 1) + '. ' + s.title +
      (s.chart ? ' [chart:' + s.chart.type + ']' : '') +
      (s.diagram ? ' [diagram:' + s.diagram.type + ']' : '') +
      (s.table ? ' [table]' : '') +
      (s.imageRef ? ' [image]' : '')
  );
});

// Attach the placeholder image to the slide that asked for one.
for (const s of slides) if (s.imageRef) s.image = { bytes: png, mime: 'image/png' };

writeFileSync(out + '/deck.pptx', await buildPptx(slides, { theme: 'indigo', font: 'gothic' }));
writeFileSync(out + '/deck-plum.pptx', await buildPptx(slides, { theme: 'plum', font: 'mincho' }));
writeFileSync(
  out + '/doc-images.docx',
  await buildDocx('# 写真つきレポート\n\n本文です。\n\n![新オフィスの外観](gen)\n\n次の段落。', {
    images: [{ bytes: png, mime: 'image/png' }],
  })
);
console.log('written to', out);
