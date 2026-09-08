import puppeteer from 'puppeteer-core';
import { webcrypto as crypto } from 'node:crypto';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function totp(secretB32) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = new ArrayBuffer(8); const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 4294967296)); dv.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', b32decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  return String((((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff)) % 1000000).padStart(6, '0');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
check('ログイン画面', await page.$eval('#login-view', (n) => !n.hidden));
check('ベンダー JS', await page.evaluate(() => !!(window.marked && window.DOMPurify && window.qrcode)));

await page.type('#login-email', process.env.TEST_EMAIL || 'owner@example.com');
await page.type('#login-password', process.env.TEST_PASSWORD || 'change-me');
await page.click('#login-form button[type="submit"]');
await page.waitForFunction(() => !document.querySelector('#enroll-form').hidden, { timeout: 30000 });
check('ログイン → TOTP 登録', true);
check('QR 描画', await page.$eval('#qr-box', (n) => !!n.querySelector('svg')));
const secret = await page.$eval('#totp-secret', (n) => n.textContent.trim());
await page.type('#enroll-code', await totp(secret));
await page.click('#enroll-form button[type="submit"]');
await page.waitForFunction(() => !document.querySelector('#recovery-codes-box').hidden, { timeout: 20000 });
check('リカバリコード 8 個', (await page.$eval('#recovery-codes', (n) => n.textContent.trim().split('\n'))).length === 8);

await page.click('#recovery-done');
await page.waitForFunction(() => !document.querySelector('#app-view').hidden, { timeout: 20000 });
await page.waitForFunction(() => document.querySelector('#model-label')?.textContent !== 'モデル', { timeout: 30000 }).catch(() => {});
check('チャット画面', await page.$eval('#app-view', (n) => !n.hidden));
check('モデル名表示', (await page.$eval('#model-label', (n) => n.textContent)).length > 2, await page.$eval('#model-label', (n) => n.textContent));

// toggles
check('Web検索は既定でオン（自動モードは呼ばれるまで無料）', (await page.$eval('#web-search', (n) => n.dataset.on)) === 'true');
check('画像生成も既定でオン', (await page.$eval('#image-output', (n) => n.dataset.on)) === 'true');
const roomId0 = await page.evaluate(() => window.__state?.roomId);
await page.click('#image-output');
await wait(700);
const offMode = await page.evaluate(async () => (await (await fetch('/api/rooms')).json()).rooms[0].imageMode);
check('  オフにするとモードが off になる', offMode === 'off', String(offMode));
await page.click('#image-output');
await wait(700);
const onMode = await page.evaluate(async () => (await (await fetch('/api/rooms')).json()).rooms[0].imageMode);
check('  戻すと自動に復帰する', onMode === 'server', String(onMode));
check('  チップも戻る', (await page.$eval('#image-output', (n) => n.dataset.on)) === 'true');
await page.click('#effort-btn');
await page.waitForFunction(() => !document.querySelector('#effort-modal').hidden, { timeout: 10000 });
const efforts = await page.$$eval('#effort-options [data-effort]', (ns) => ns.map((n) => n.dataset.effort));
check('思考の深さが7段階のスライダーになる', efforts.length === 7 && efforts.includes('xhigh') && efforts.includes('max'), efforts.join(','));
check('  自動は独立したチップ', await page.$eval('#effort-auto', (n) => !!n));
await page.click('#effort-options [data-effort="max"]');
await wait(400);
check('  最大を選べる', (await page.$eval('#effort-label', (n) => n.textContent)).includes('最大'), await page.$eval('#effort-label', (n) => n.textContent));
check('  説明が出る', (await page.$eval('#effort-desc', (n) => n.textContent)).length > 10);
const slider = await page.evaluate(() => {
  const r = document.querySelector('#effort-range');
  return { max: r.max, value: r.value, disabled: r.disabled, fill: r.style.getPropertyValue('--fill') };
});
check('  スライダーが最大位置に来る', slider.max === '6' && slider.value === '6' && slider.fill === '100.0%', JSON.stringify(slider));
await page.evaluate(() => {
  const r = document.querySelector('#effort-range');
  r.value = '2';
  r.dispatchEvent(new Event('input', { bubbles: true }));
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await wait(500);
check('  スライダーを動かすと段階が変わる', (await page.$eval('#effort-label', (n) => n.textContent)).includes('低'), await page.$eval('#effort-label', (n) => n.textContent));
await page.click('#effort-auto');
await wait(400);
check('  自動チップでスライダーが無効化', await page.$eval('#effort-range', (n) => n.disabled));
await page.click('#effort-auto');
await wait(400);
check('  もう一度押すと中に戻る', (await page.$eval('#effort-label', (n) => n.textContent)).includes('中'));
await page.click('#effort-options [data-effort="xhigh"]');
await wait(300);
check('  超高も選べる', (await page.$eval('#effort-label', (n) => n.textContent)).includes('超高'));
await page.click('#effort-auto');
await wait(300);
check('  自動に戻せる', (await page.$eval('#effort-label', (n) => n.textContent)).includes('自動'));
await page.keyboard.press('Escape');
await wait(300);

// model picker
await page.click('#model-btn');
await page.waitForFunction(() => document.querySelectorAll('#model-list .model-row').length > 10, { timeout: 20000 });
check('モデル一覧', (await page.$$eval('#model-list .model-row', (n) => n.length)) > 50);
await page.type('#model-search', 'kimi');
await wait(400);
const kimi = await page.$$eval('#model-list .model-row .name', (ns) => ns.map((n) => n.textContent).slice(0, 2));
check('検索フィルタ', kimi.join(' ').toLowerCase().includes('kimi'), kimi.join(' | '));
check('価格表示', /\$|不明|無料/.test(await page.$eval('#model-list .model-row .price', (n) => n.textContent)));
await page.click('#filter-vision');
await wait(300);
check('画像入力フィルタ', (await page.$eval('#filter-vision', (n) => n.dataset.on)) === 'true');
await page.click('#filter-vision');
await page.$eval('#model-search', (n) => (n.value = ''));
await page.type('#model-search', 'gemini-3.8-flash');
await wait(500);
const modality = await page.evaluate(() => {
  const row = document.querySelector('#model-list .model-row');
  const caps = row?.querySelector('.caps');
  return { html: caps?.innerHTML || '', titles: [...(caps?.querySelectorAll('[title]') || [])].map((n) => n.title) };
});
check('モダリティ表示が出る', modality.html.includes('入') && modality.titles.length >= 3, modality.titles.join(' / '));
check('  Gemini は音声も読めると表示', modality.titles.some((t) => t.includes('音声')), modality.titles.join(' / '));
await page.click('#filter-audio');
await page.$eval('#model-search', (n) => (n.value = ''));
await page.type('#model-search', ' ');
await wait(600);
const audioRows = await page.$$eval('#model-list .model-row .caps', (ns) => ns.map((n) => [...n.querySelectorAll('[title]')].map((x) => x.title).join(',')));
check('音声入力フィルタ', audioRows.length > 0 && audioRows.every((t) => t.includes('音声')), audioRows.length + ' rows');
await page.click('#filter-audio');
await page.$eval('#model-search', (n) => (n.value = ''));
await page.type('#model-search', ' ');
await page.click('#filter-free');
await wait(600);
const freeRows = await page.$$eval('#model-list .model-row', (ns) => ns.map((n) => n.textContent));
check('無料フィルタ', freeRows.length > 0 && freeRows.every((t) => t.includes('無料')), freeRows.length + ' rows');
await page.click('#filter-free');
await page.$eval('#model-search', (n) => (n.value = ''));
await page.type('#model-search', 'kimi');
await wait(500);
await page.click('#model-list .model-row');
await page.waitForFunction(() => document.querySelector('#model-modal').hidden, { timeout: 10000 });
check('モデル選択反映', (await page.$eval('#model-label', (n) => n.textContent)).toLowerCase().includes('kimi'));

// capability gating
async function pickModel(query) {
  await page.click('#model-btn');
  await page.waitForFunction(() => !document.querySelector('#model-modal').hidden, { timeout: 10000 });
  await page.$eval('#model-search', (n) => (n.value = ''));
  await page.type('#model-search', query);
  await wait(500);
  await page.click('#model-list .model-row');
  await page.waitForFunction(() => document.querySelector('#model-modal').hidden, { timeout: 10000 });
  await wait(700);
  return page.evaluate(() => ({
    label: document.querySelector('#model-label').textContent,
    web: document.querySelector('#web-search').disabled,
    image: document.querySelector('#image-output').disabled,
    effort: document.querySelector('#effort-btn').disabled,
  }));
}
const imgModel = await pickModel('gemini-3.1-flash-image');
check('画像出力モデルでは画像生成が有効', imgModel.image === false, JSON.stringify(imgModel));
const plain = await pickModel('mistral-small');
check('自動モードならテキスト専用モデルでも画像生成が使える', plain.image === false, JSON.stringify(plain));
check('  Web検索も有効のまま', plain.web === false);
check('  チップは既定でオン', await page.$eval('#image-output', (n) => n.dataset.on) === 'true');
// forcing image output does need a model that can emit images
await page.click('#room-settings-btn');
await page.waitForFunction(() => !document.querySelector('#room-modal').hidden, { timeout: 10000 });
await wait(400);
await page.select('#rs-image-mode', 'force');
await page.click('#rs-save');
await wait(1600);
check('強制モードでは非対応モデルでグレーアウト', await page.$eval('#image-output', (n) => n.disabled), '');
await page.click('#room-settings-btn');
await wait(700);
await page.select('#rs-image-mode', 'server');
await page.click('#rs-save');
await wait(1600);
check('自動に戻すと再び使える', !(await page.$eval('#image-output', (n) => n.disabled)));
const reason = await pickModel('claude-sonnet-5');
check('推論モデルでは思考ボタンが有効', reason.effort === false, JSON.stringify(reason));

// closing a sheet by hitting the icon inside the ✕ button
await page.click('#model-btn');
await page.waitForFunction(() => !document.querySelector('#model-modal').hidden, { timeout: 10000 });
await wait(400);
await page.$eval('#model-modal [data-close] svg', (n) => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await wait(300);
check('✕ の中のアイコンを押しても閉じる', await page.$eval('#model-modal', (n) => n.hidden));

// video sheet
await page.click('#video-btn');
await page.waitForFunction(() => document.querySelectorAll('#vid-model option').length > 5, { timeout: 25000 });
const vidModels = await page.$$eval('#vid-model option', (ns) => ns.map((n) => n.value));
check('動画モデルが並ぶ', vidModels.length > 10, vidModels.length + ' models');
check('  Seedance と Veo がある', vidModels.some((v) => /seedance/.test(v)) && vidModels.some((v) => /veo/.test(v)));
await page.select('#vid-model', 'bytedance/seedance-2.0-mini');
await wait(500);
const vidParams = await page.evaluate(() => ({
  durations: document.querySelectorAll('#vid-duration option').length,
  resolutions: [...document.querySelectorAll('#vid-resolution option')].map((n) => n.value),
  sizes: document.querySelectorAll('#vid-size option').length,
  cost: document.querySelector('#vid-cost').textContent,
  audio: !document.querySelector('#vid-audio').disabled,
}));
check('  モデルごとのパラメータが反映される', vidParams.durations > 5 && vidParams.resolutions.includes('480p'), JSON.stringify(vidParams.resolutions));
check('  概算コストが出る', /\$\d/.test(vidParams.cost), vidParams.cost);
check('  音声生成トグルが有効', vidParams.audio);
await page.keyboard.press('Escape');
await wait(300);

// artifact preview
const artifactOk = await page.evaluate(async () => {
  const mod = await import('/features.js');
  const host = document.createElement('div');
  host.id = 'artifact-probe';
  host.innerHTML = '<pre><code class="language-html">&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;h1&gt;preview works&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;</code></pre>';
  document.body.appendChild(host);
  mod.attachArtifactButtons(host, { id: 'probe' });
  return !!host.querySelector('.code-actions button');
});
check('HTML ブロックにプレビューボタンが付く', artifactOk);
await page.click('#artifact-probe .code-actions button');
await page.waitForFunction(() => !document.querySelector('#artifact-modal').hidden, { timeout: 10000 });
await wait(1200);
const frameOk = await page.evaluate(() => {
  const f = document.querySelector('#artifact-frame');
  return { src: f.getAttribute('src') || '', sandbox: f.getAttribute('sandbox') || '' };
});
check('プレビューが開く', /\/api\/artifacts\/.+\/raw/.test(frameOk.src), frameOk.src);
check('  iframe が sandbox 付き', frameOk.sandbox.includes('allow-scripts') && !frameOk.sandbox.includes('allow-same-origin'), frameOk.sandbox);
// A sandbox without allow-same-origin makes contentDocument opaque, which is
// exactly what we want; assert the frame loaded and stayed isolated instead.
const isolated = await page.evaluate(() => {
  const f = document.querySelector('#artifact-frame');
  return { opaque: f.contentDocument === null, hasWindow: !!f.contentWindow };
});
check('  サンドボックスで隔離されている', isolated.opaque && isolated.hasWindow, JSON.stringify(isolated));
const frameLoaded = await page.evaluate(async () => {
  const res = await fetch(document.querySelector('#artifact-frame').getAttribute('src'), { credentials: 'same-origin' });
  return (await res.text()).includes('preview works');
});
check('  中身が配信されている', frameLoaded);
await page.keyboard.press('Escape');
await wait(300);
check('閉じると iframe が停止する', await page.$eval('#artifact-frame', (n) => !n.getAttribute('src')));
await page.evaluate(() => document.querySelector('#artifact-probe')?.remove());

// voice sheet
await page.click('#voice-btn');
await wait(500);
check('音声シートが開く', await page.$eval('#voice-modal', (n) => !n.hidden));
const asrModels = await page.$$eval('#asr-model option', (ns) => ns.map((n) => n.value));
check('ASR モデル選択肢', asrModels.length >= 1, asrModels.join(', '));
await page.click('#asr-source .seg-btn[data-src="file"]');
check('ファイル選択に切替', await page.$eval('#asr-file', (n) => !n.hidden));

// TTS voice picker
await page.click('#voice-mode .seg-btn[data-mode="tts"]');
await wait(500);
check('読み上げタブに切り替わる', await page.$eval('#tts-panel', (n) => !n.hidden));
const ttsUi = await page.evaluate(() => ({
  models: [...document.querySelectorAll('#tts-model option')].map((n) => n.value),
  voices: [...document.querySelectorAll('#tts-voices [data-voice]')].map((n) => n.dataset.voice),
  active: document.querySelector('#tts-voices [data-on="true"]')?.dataset.voice,
}));
check('  読み上げモデルが並ぶ', ttsUi.models.length > 10, ttsUi.models.length + ' models');
check('  Gemini TTS がある', ttsUi.models.includes('google/gemini-3.1-flash-tts-preview'), ttsUi.models.slice(0, 4).join(', '));
check('  Qwen TTS がある', ttsUi.models.some((m) => /qwen.*tts/.test(m)), ttsUi.models.filter((m) => /qwen/.test(m)).join(', '));
check('  Orpheus とブラウザ内蔵も残っている',
  ttsUi.models.some((m) => /orpheus/.test(m)) && ttsUi.models.includes('browser'));
check('  1つ選択されている', !!ttsUi.active, ttsUi.active);
// The stored default may still point at Orpheus, so the model is chosen here.
await page.select('#tts-model', 'google/gemini-3.1-flash-tts-preview');
await wait(400);
const geminiVoices = await page.$$eval('#tts-voices [data-voice]', (ns) => ns.map((n) => n.dataset.voice));
check('  ボイスがボタンで選べる', geminiVoices.length > 10 && geminiVoices.includes('Kore'), geminiVoices.slice(0, 5).join(', '));
await page.click('#tts-voices [data-voice="Puck"]');
await wait(300);
const picked = await page.evaluate(() => ({
  on: document.querySelector('#tts-voices [data-on="true"]')?.dataset.voice,
  saved: JSON.parse(localStorage.getItem('cft.tts') || '{}'),
}));
check('  選択が保存される', picked.on === 'Puck' && picked.saved.voice === 'Puck', JSON.stringify(picked));
await page.select('#tts-model', 'canopylabs/orpheus-v1-english');
await wait(400);
const orpheus = await page.$$eval('#tts-voices [data-voice]', (ns) => ns.map((n) => n.dataset.voice));
check('  モデルを変えるとボイスも変わる', orpheus.includes('troy'), orpheus.join(', '));
await page.select('#tts-model', 'canopylabs/orpheus-v1-english');
await page.keyboard.press('Escape');

// Groq search tuning persists on the room
await page.click('#room-settings-btn');
await page.waitForFunction(() => !document.querySelector('#room-modal').hidden, { timeout: 10000 });
await wait(400);
check('ルーム設定に Groq 検索設定がある', await page.$eval('#room-modal-body', (n) => n.textContent.includes('検索スニペットのみ')));
const modes = await page.evaluate(() => ({
  search: [...document.querySelectorAll('#rs-engine option')].map((n) => n.value),
  searchDefault: document.querySelector('#rs-engine').value,
  image: [...document.querySelectorAll('#rs-image-mode option')].map((n) => n.value),
  imageDefault: document.querySelector('#rs-image-mode').value,
}));
check('  Web検索モードを選べる', modes.search.includes('server') && modes.search.includes('exa'), modes.search.join(','));
check('  既定は自動（Server Tools）', modes.searchDefault === 'server', modes.searchDefault);
check('  画像生成モードを選べる', modes.image.join(',') === 'server,force', modes.image.join(','));
check('  画像の既定も自動', modes.imageDefault === 'server', modes.imageDefault);
await page.select('#rs-engine', 'exa');
await page.select('#rs-image-mode', 'force');
await page.click('#rs-save');
await wait(1500);
await page.click('#room-settings-btn');
await wait(700);
const savedModes = await page.evaluate(() => ({
  search: document.querySelector('#rs-engine').value,
  image: document.querySelector('#rs-image-mode').value,
}));
check('  強制モードに切り替えて保存できる', savedModes.search === 'exa' && savedModes.image === 'force', JSON.stringify(savedModes));
await page.select('#rs-engine', 'server');
await page.select('#rs-image-mode', 'server');
await page.click('#rs-save');
await wait(1200);
await page.click('#room-settings-btn');
await wait(600);
await page.$eval('#room-modal-body .fold', (n) => n.setAttribute('open', ''));
await wait(200);
await page.click('#rs-snippet');
await page.type('#rs-include', '*.go.jp, nature.com');
await page.type('#rs-country', 'japan');
await page.click('#rs-save');
await wait(1500);
await page.click('#room-settings-btn');
await wait(700);
await page.$eval('#room-modal-body .fold', (n) => n.setAttribute('open', ''));
const saved = await page.evaluate(() => ({
  snippet: document.querySelector('#rs-snippet').checked,
  include: document.querySelector('#rs-include').value,
  country: document.querySelector('#rs-country').value,
}));
check('検索設定が保存される', saved.snippet && saved.include.includes('go.jp') && saved.country === 'japan', JSON.stringify(saved));
await page.keyboard.press('Escape');
await wait(300);

// pricing
await page.click('#open-pricing');
await page.waitForFunction(() => document.querySelectorAll('#price-table tbody tr').length > 10, { timeout: 30000 });
check('料金一覧', (await page.$$eval('#price-table tbody tr', (n) => n.length)) > 50);
check('Web検索料金', (await page.$eval('#pricing-body .card', (n) => n.textContent)).includes('$0.007'));
const pricingText = await page.$eval('#pricing-body', (n) => n.textContent);
check('料金表に動画モデルがある', pricingText.includes('動画モデル') && /seedance/i.test(pricingText));
const videoRows = await page.evaluate(() => {
  const table = [...document.querySelectorAll('#pricing-body .card')].find((c) => c.textContent.includes('動画モデル'));
  return [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
});
const minimax = videoRows.find((r) => r[0] === 'minimax/hailuo-3');
check('  MiniMax に単価が出る', minimax && /\$0\.13/.test(minimax[5]), minimax ? minimax[5] : 'row not found');
check('  MiniMax に1本あたりの例が出る', minimax && /\$\d/.test(minimax[6]), minimax ? minimax[6] : '');
check('  全モデルに秒単価が出る', videoRows.every((r) => r[4] !== '—'), videoRows.filter((r) => r[4] === '—').map((r) => r[0]).join(', ') || 'すべて表示');
const seedanceRow = videoRows.find((r) => r[0] === 'bytedance/seedance-2.0-mini');
check('  トークン課金モデルも秒単価に換算される', seedanceRow && /\$0\.0\d/.test(seedanceRow[4]), seedanceRow ? seedanceRow[4] : 'row not found');
check('  キャンペーン割引が反映され定価も併記される',
  seedanceRow && /%OFF/.test(seedanceRow[4]) && /定価 \$0\.0\d/.test(seedanceRow[4]),
  seedanceRow ? seedanceRow[4].replace(/\s+/g, ' ') : 'row not found');
check('  全モデルに課金方式が入っている', videoRows.every((r) => r[5] !== '—'), videoRows.filter((r) => r[5] === '—').map((r) => r[0]).join(', ') || 'すべて表示');
check('  全モデルに例が出る', videoRows.every((r) => r[6] !== '—'), videoRows.filter((r) => r[6] === '—').map((r) => r[0]).join(', ') || 'すべて表示');
check('料金表に読み上げがある', pricingText.includes('読み上げ') && /orpheus/i.test(pricingText));
check('料金表に文字起こしがある', /whisper/i.test(pricingText));
await page.keyboard.press('Escape');

// admin
await page.click('#open-admin');
await page.waitForFunction(() => document.querySelectorAll('#admin-body .card').length > 0, { timeout: 20000 });
check('管理: API キー', (await page.$eval('#admin-body', (n) => n.textContent)).includes('OPENROUTER_API_KEY'));
for (const [tab, needle] of [['defaults', 'エンジン'], ['security', '二要素認証'], ['usage', '直近 30 日'], ['events', ''], ['groq', 'JSON']]) {
  await page.click('#admin-tabs .tab[data-tab="' + tab + '"]');
  await wait(1200);
  const text = await page.$eval('#admin-body', (n) => n.textContent);
  check('管理: ' + tab, !text.includes('読み込み中') && (!needle || text.includes(needle)), text.replace(/\s+/g, ' ').slice(0, 60));
}
await page.keyboard.press('Escape');

// streaming UI (provider key is invalid locally -> error path)
await page.click('#new-room');
await wait(1500);
await page.type('#input', 'テストメッセージ');
await page.click('#send-btn');
const sawStatus = await page.waitForFunction(() => !!document.querySelector('.msg.assistant .status'), { timeout: 15000 }).then(() => true).catch(() => false);
check('ストリーミング中に進捗インジケータが出る', sawStatus);
check('進捗バーが出る', await page.$eval('#progress', (n) => !n.hidden).catch(() => false));
await page.waitForFunction(() => !document.querySelector('.msg.assistant .status'), { timeout: 40000 }).catch(() => {});
await wait(2500);
const texts = await page.$$eval('#messages .msg', (ns) => ns.map((n) => n.className + '::' + n.textContent));
check('ユーザー発言表示', texts.some((t) => t.startsWith('msg user') && t.includes('テストメッセージ')));
check('エラー表示', texts.some((t) => t.includes('プロバイダエラー')), texts.join(' // ').slice(0, 140));
check('進捗バーが消える', await page.$eval('#progress', (n) => n.hidden));
const autoTitle = await page.$eval('#room-title', (n) => n.value);
check('ルーム名が最初の発言から自動命名される', autoTitle === 'テストメッセージ', autoTitle);
check('サイドバーにも反映', (await page.$$eval('#room-list .room .t', (ns) => ns.map((n) => n.textContent))).includes('テストメッセージ'));

// recorder
await page.click('#record-btn');
const recOpened = await page.waitForFunction(() => !document.querySelector('#rec-modal').hidden, { timeout: 8000 }).then(() => true).catch(() => false);
check('録音シートが開く', recOpened);
if (recOpened) {
  check('  音源を選べる', await page.$eval('#rec-system', (n) => n.checked) && await page.$eval('#rec-mic', (n) => n.checked));
  check('  ビットレートを選べる', (await page.$$eval('#rec-bitrate option', (ns) => ns.map((n) => n.value))).join(',') === '48,64,96,128');
  check('  既定は 64kbps', (await page.$eval('#rec-bitrate', (n) => n.value)) === '64');
  check('  マイクは既定でオン', (await page.$eval('#rec-mic-on', (n) => n.dataset.on)) === 'true');
  await page.click('#rec-mic-on');
  check('  ボタンでミュートできる', (await page.$eval('#rec-mic-on', (n) => n.dataset.on)) === 'false');
  check('    表示も切り替わる', (await page.$eval('#rec-mic-on', (n) => n.textContent)).includes('OFF'));
  await page.click('#rec-mic-on');
  check('  戻せる', (await page.$eval('#rec-mic-on', (n) => n.dataset.on)) === 'true');
  check('  停止ボタンは録音前は隠れている', await page.$eval('#rec-stop', (n) => n.hidden));

  // The encoder is the part that cannot be assumed, so the real worker is run.
  const mp3 = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const worker = new Worker('/mp3-worker.js');
        const rate = 48000;
        const samples = new Float32Array(rate);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 12) * 0.3;
        worker.onmessage = (e) => {
          const msg = e.data || {};
          if (msg.type === 'ready') {
            worker.postMessage({ type: 'chunk', samples });
            worker.postMessage({ type: 'stop' });
          }
          if (msg.type === 'done') {
            msg.blob.arrayBuffer().then((buf) => {
              const head = new Uint8Array(buf.slice(0, 2));
              worker.terminate();
              resolve({ bytes: msg.bytes, type: msg.blob.type, sync: head[0], seconds: samples.length / rate });
            });
          }
        };
        worker.onerror = (e) => resolve({ error: e.message });
        worker.postMessage({ type: 'start', sampleRate: rate, bitrate: 64 });
        setTimeout(() => resolve({ error: 'timeout' }), 20000);
      })
  );
  check('  ワーカーが MP3 を作る', mp3.bytes > 1000 && mp3.type === 'audio/mpeg',
    mp3.error || mp3.bytes + ' bytes / ' + Math.round((mp3.bytes * 8) / mp3.seconds / 1000) + 'kbps');
  check('    MP3 のフレーム同期がある', mp3.sync === 0xff, String(mp3.sync));
  await page.click('#rec-modal [data-close]');
  await wait(400);
  check('  閉じられる', await page.$eval('#rec-modal', (n) => n.hidden));
}

// batch image generation
await page.click('#imagegen-btn');
const imgOpened = await page.waitForFunction(() => !document.querySelector('#imagegen-modal').hidden, { timeout: 8000 }).then(() => true).catch(() => false);
check('画像シートが開く', imgOpened);
if (imgOpened) {
  await page.waitForFunction(() => document.querySelectorAll('#img-model option').length > 1, { timeout: 20000 }).catch(() => {});
  const imgModels = await page.$$eval('#img-model option', (ns) => ns.map((n) => n.textContent));
  check('  画像モデルが並ぶ', imgModels.length > 10, imgModels.length + ' models');
  check('  一括枚数がラベルに出る', imgModels.some((t) => t.includes('一括')), imgModels.find((t) => t.includes('一括')) || 'なし');
  check('  枚数スライダーは10まで', (await page.$eval('#img-count', (n) => n.max)) === '10');
  await page.$eval('#img-count', (n) => { n.value = '4'; n.dispatchEvent(new Event('input')); });
  check('  枚数ラベルが追従する', (await page.$eval('#img-count-label', (n) => n.textContent)).startsWith('4 枚'), await page.$eval('#img-count-label', (n) => n.textContent));
  check('  分割の説明が出る', (await page.$eval('#img-count-note', (n) => n.textContent)).length > 0, await page.$eval('#img-count-note', (n) => n.textContent));
  await page.click('#imagegen-modal [data-close]');
  await wait(400);
  check('  閉じられる', await page.$eval('#imagegen-modal', (n) => n.hidden));
}

// file export
check('添付ピッカーが Office 形式を受け付ける',
  (await page.$eval('#file-input', (n) => n.accept)).includes('.xlsx') &&
  (await page.$eval('#file-input', (n) => n.accept)).includes('.docx') &&
  (await page.$eval('#file-input', (n) => n.accept)).includes('.pptx'),
  await page.$eval('#file-input', (n) => n.accept));
const exportBtn = await page.$('.msg.assistant .acts [title="ファイルに書き出す"], .msg.assistant .acts [aria-label="ファイルに書き出す"]');
check('回答に書き出しボタンが出る', !!exportBtn);
if (exportBtn) {
  await exportBtn.click();
  await page.waitForFunction(() => !document.querySelector('#export-modal').hidden, { timeout: 8000 });
  const formats = await page.$$eval('#export-formats .export-btn', (ns) => ns.map((n) => n.dataset.format));
  check('  8形式そろっている', formats.length === 8 && formats.includes('xlsx') && formats.includes('pptx') && formats.includes('pdf'), formats.join(','));
  check('  既定のファイル名が入る', (await page.$eval('#export-title', (n) => n.value)).length > 0, await page.$eval('#export-title', (n) => n.value));
  await page.$eval('#export-design', (n) => { n.open = true; });
  await page.waitForFunction(() => document.querySelectorAll('#export-themes .swatch').length > 0, { timeout: 8000 }).catch(() => {});
  const swatches = await page.$$eval('#export-themes .swatch', (ns) => ns.map((n) => n.dataset.theme));
  check('  配色パレットが並ぶ', swatches.length >= 4, swatches.join(','));
  check('  1つ選択済み', (await page.$$eval('#export-themes .swatch.on', (ns) => ns.length)) === 1);
  await page.click('#export-themes .swatch:nth-child(3)');
  check('  切り替えられる', (await page.$eval('#export-themes .swatch:nth-child(3)', (n) => n.classList.contains('on'))));
  check('  フォントを選べる', (await page.$$eval('#export-font option', (ns) => ns.length)) >= 3);
  check('  画像モデル欄は既定で隠れている', await page.$eval('#export-imgmodel-field', (n) => n.hidden));
  await page.click('#export-genimg');
  check('  自動生成をオンにすると出る', !(await page.$eval('#export-imgmodel-field', (n) => n.hidden)));
  await page.click('#export-genimg');
  await page.click('#export-modal [data-close]');
  await wait(400);
  check('  閉じられる', await page.$eval('#export-modal', (n) => n.hidden));
}

await page.screenshot({ path: 'tests/ui-desktop.png' });

// mobile
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.reload({ waitUntil: 'networkidle0' });
await wait(3000);
check('モバイル: サイドバーは隠れている', await page.$eval('#sidebar', (n) => n.getBoundingClientRect().right <= 1));
check('モバイル: メニューボタンが見える', await page.$eval('#toggle-sidebar', (n) => getComputedStyle(n).display !== 'none'));
await page.click('#toggle-sidebar');
await wait(500);
check('モバイル: サイドバーが開く', await page.$eval('#sidebar', (n) => n.getBoundingClientRect().right > 100));
check('モバイル: スクリムが出る', await page.$eval('#scrim', (n) => !n.hidden));
await page.mouse.click(375, 520); // right edge, clear of the drawer
await wait(450);
check('モバイル: スクリムで閉じる', await page.$eval('#sidebar', (n) => n.getBoundingClientRect().right <= 1));
// edge swipe (ChatGPT-style drawer gesture)
async function swipe(fromX, toX, y = 500, steps = 12) {
  await page.evaluate(
    async (fromX, toX, y, steps) => {
      const target = document.elementFromPoint(fromX, y) || document.body;
      const mk = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
      const fire = (type, x) =>
        target.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x)], changedTouches: [mk(x)] })
        );
      fire('touchstart', fromX);
      for (let i = 1; i <= steps; i++) {
        fire('touchmove', fromX + ((toX - fromX) * i) / steps);
        await new Promise((r) => setTimeout(r, 12));
      }
      fire('touchend', toX);
    },
    fromX, toX, y, steps
  );
}
await swipe(5, 300);
await wait(600);
check('モバイル: 左端スワイプで開く', await page.$eval('#sidebar', (n) => n.classList.contains('open') && n.getBoundingClientRect().right > 100));
await swipe(280, 10);
await wait(600);
check('モバイル: 左スワイプで閉じる', await page.$eval('#sidebar', (n) => !n.classList.contains('open') && n.getBoundingClientRect().right <= 1));
await swipe(5, 60);
await wait(600);
check('モバイル: 浅いスワイプでは開かない', await page.$eval('#sidebar', (n) => !n.classList.contains('open')));
check('モバイル: 中断後にスタイルが残らない', await page.$eval('#sidebar', (n) => !n.style.transform && !n.classList.contains('dragging')));
await swipe(200, 320, 500);
await wait(500);
check('モバイル: 画面中央からは開かない', await page.$eval('#sidebar', (n) => !n.classList.contains('open')));

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('モバイル: 横スクロールなし', overflow <= 0, 'overflow=' + overflow);
await page.screenshot({ path: 'tests/ui-mobile.png' });
await page.click('#model-btn');
await wait(800);
check('モバイル: モデルシートがボトムシート', await page.$eval('#model-modal .sheet-card', (n) => {
  const r = n.getBoundingClientRect();
  return Math.abs(r.bottom - window.innerHeight) < 2 && r.width >= window.innerWidth - 2;
}));
await page.screenshot({ path: 'tests/ui-mobile-sheet.png' });

const realErrors = consoleErrors.filter((e) => !/favicon|401|403|Failed to load resource/.test(e));
check('コンソールエラーなし', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2])); process.exit(1); }
