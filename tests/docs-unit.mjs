// Wiring between an uploaded document and the request that reaches the
// provider: extraction into the prompt, and the PDF plugin.
import { buildMessages, buildRequest } from '../src/lib/chat.js';
import { buildXlsx, buildDocx, buildPptx } from '../src/lib/office.js';

const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};

/** Minimal KV stand-in: only the arrayBuffer read that buildMessages performs. */
function envWith(files) {
  return {
    KV: {
      async get(key, type) {
        const bytes = files[key.replace(/^file:/, '')];
        if (!bytes) return null;
        return type === 'arrayBuffer' ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
      },
    },
  };
}

const row = (atts, content = 'この資料をまとめて') => ({
  id: 'm1',
  role: 'user',
  content,
  attachments: JSON.stringify(atts),
});

const xlsx = await buildXlsx([{ name: '売上', rows: [['商品', '数量'], ['りんご', '120']] }]);
const docx = await buildDocx('# 議事録\n\n決定事項は3件です。');
const pptx = await buildPptx([{ title: '提案', bullets: ['A案を採用'] }]);
const csv = new TextEncoder().encode('名前,点数\n山田,88');
const pdf = new TextEncoder().encode('%PDF-1.4 fake');

const env = envWith({ f_xlsx: xlsx, f_docx: docx, f_pptx: pptx, f_csv: csv, f_pdf: pdf });
const noCaps = { image: false, audio: false, file: false };

/* ------------------------- extraction into the prompt -------------------- */
let built = await buildMessages(env, [row([{ id: 'f_xlsx', kind: 'doc', name: '売上.xlsx', mime: '' }])], { caps: noCaps });
let parts = built.messages[0].content;
check('xlsx が本文として渡る', Array.isArray(parts) && parts.some((p) => p.type === 'text' && p.text.includes('りんご')),
  JSON.stringify(parts?.map((p) => p.type)));
check('  ファイル名で囲まれる', parts.some((p) => p.text?.includes('<<<添付ファイル: 売上.xlsx>>>')));
check('  ユーザーの発言も残る', parts.some((p) => p.text === 'この資料をまとめて'));
check('  file パートは使わない', !parts.some((p) => p.type === 'file'));
check('  PDF フラグは立たない', built.usedPdf === false);

built = await buildMessages(env, [row([{ id: 'f_docx', kind: 'doc', name: '議事録.docx', mime: '' }])], { caps: noCaps });
check('docx が本文として渡る', built.messages[0].content.some((p) => p.text?.includes('決定事項は3件です')));

built = await buildMessages(env, [row([{ id: 'f_pptx', kind: 'doc', name: '提案.pptx', mime: '' }])], { caps: noCaps });
check('pptx が本文として渡る', built.messages[0].content.some((p) => p.text?.includes('A案を採用')));

built = await buildMessages(env, [row([{ id: 'f_csv', kind: 'doc', name: 'scores.csv', mime: 'text/csv' }])], { caps: noCaps });
check('csv が本文として渡る', built.messages[0].content.some((p) => p.text?.includes('山田,88')));

built = await buildMessages(
  env,
  [row([
    { id: 'f_xlsx', kind: 'doc', name: 'a.xlsx', mime: '' },
    { id: 'f_csv', kind: 'doc', name: 'b.csv', mime: 'text/csv' },
  ])],
  { caps: noCaps }
);
check('複数ファイルを同時に渡せる',
  built.messages[0].content.filter((p) => p.type === 'text' && p.text.startsWith('<<<添付ファイル')).length === 2);

built = await buildMessages(env, [row([{ id: 'missing', kind: 'doc', name: 'x.xlsx', mime: '' }])], { caps: noCaps });
check('読めないファイルは印を返す', built.skipped.includes('doc-unreadable'), JSON.stringify(built.skipped));

/* ------------------------------ PDF handling ---------------------------- */
built = await buildMessages(env, [row([{ id: 'f_pdf', kind: 'doc', name: 'a.pdf', mime: 'application/pdf' }])], {
  caps: { ...noCaps, pdfPlugin: true },
});
check('file 非対応モデルでも PDF は落とさない', built.usedPdf === true && built.messages[0].content.some((p) => p.type === 'file'),
  JSON.stringify(built.skipped));

built = await buildMessages(env, [row([{ id: 'f_pdf', kind: 'doc', name: 'a.pdf', mime: 'application/pdf' }])], {
  caps: { ...noCaps, pdfPlugin: false },
});
check('Groq では PDF を送らない', built.usedPdf === false && built.skipped.includes('file'), JSON.stringify(built.skipped));

/* ---------------------------- request assembly -------------------------- */
const base = { provider: 'openrouter', model: 'x/y', messages: [], apiKey: 'k', stream: false };
let req = buildRequest({ ...base, options: { usedPdf: true, webSearchEngine: 'off', imageMode: 'off' }, modelMeta: { input: ['text'] } });
const parser = (req.body.plugins || []).find((p) => p.id === 'file-parser');
check('file 非対応モデルには無料エンジンを付ける', parser?.pdf?.engine === 'cloudflare-ai', JSON.stringify(req.body.plugins));

req = buildRequest({ ...base, options: { usedPdf: true, webSearchEngine: 'off', imageMode: 'off' }, modelMeta: { input: ['text', 'file'] } });
check('file 対応モデルは native で読む', req.body.plugins?.[0]?.pdf?.engine === 'native', JSON.stringify(req.body.plugins));

req = buildRequest({ ...base, options: { usedPdf: false, webSearchEngine: 'off', imageMode: 'off' }, modelMeta: { input: ['text'] } });
check('PDF が無ければプラグインは付けない', !req.body.plugins, JSON.stringify(req.body.plugins));

req = buildRequest({
  ...base,
  options: { usedPdf: true, webSearchEngine: 'exa', webSearchMaxResults: 5, imageMode: 'off' },
  modelMeta: { input: ['text'] },
});
check('Web検索プラグインと共存する',
  (req.body.plugins || []).length === 2 && req.body.plugins.some((p) => p.id === 'web') && req.body.plugins.some((p) => p.id === 'file-parser'),
  JSON.stringify(req.body.plugins?.map((p) => p.id)));

req = buildRequest({ ...base, provider: 'groq', model: 'openai/gpt-oss-120b', options: { usedPdf: true }, modelMeta: { input: ['text'] } });
check('Groq のリクエストにプラグインは付かない', !req.body.plugins);

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2]));
  process.exit(1);
}
