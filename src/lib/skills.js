/* Skills: guidance the agent pulls in only when the job calls for it.
 *
 * The system prompt carries a short index — name and when to use it — and the
 * full text, including the live model catalogue for that modality, is fetched
 * with load_skill. Progressive disclosure: the index costs a couple of hundred
 * tokens, and the expensive part is only paid when it is actually relevant.
 *
 * A workspace file at .agent/skills/<id>.md overrides the built-in guidance, so
 * a project can teach the agent its own conventions. */

import { fetchImageModels } from './images.js';
import { fetchVideoModels, estimateVideoCost, applyDiscount } from './video.js';
import { fetchSpeechModels } from './speech.js';
import { getCatalog } from './models.js';

export const SKILL_DIR = '.agent/skills';

const money = (n, digits = 3) => '$' + Number(n).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');

/* ------------------------------ catalogues ------------------------------- */

async function imageCatalogue(env) {
  const models = await fetchImageModels(env).catch(() => []);
  if (!models.length) return '（一覧を取得できませんでした）';
  return models
    .map((m) => {
      const notes = [];
      if (m.maxN > 1) notes.push('一括' + m.maxN + '枚');
      if (m.outputFormats?.includes('svg')) notes.push('SVG可');
      if (m.maxReferences > 0) notes.push('参照画像可');
      return '- `' + m.id + '`' + (notes.length ? ' — ' + notes.join('・') : '');
    })
    .join('\n');
}

async function videoCatalogue(env) {
  const models = await fetchVideoModels(env).catch(() => []);
  if (!models.length) return '（一覧を取得できませんでした）';
  return models
    .map((m) => {
      const res = m.resolutions?.includes('720p') ? '720p' : m.resolutions?.[0];
      const perSecond = applyDiscount(
        estimateVideoCost(m, { resolution: res, duration: 1, generateAudio: m.generateAudio }),
        m.discount
      );
      const notes = [];
      if (perSecond) notes.push(money(perSecond, 4) + '/秒');
      if (m.generateAudio) notes.push('音声可');
      if (m.durations?.length) notes.push(m.durations.join('/') + '秒');
      return '- `' + m.id + '`' + (notes.length ? ' — ' + notes.join('・') : '');
    })
    .join('\n');
}

async function speechCatalogue(env) {
  const models = await fetchSpeechModels(env).catch(() => []);
  if (!models.length) return '（一覧を取得できませんでした）';
  return models
    .map((m) => {
      const notes = [];
      if (m.free) notes.push('無料');
      else if (m.perMillionChars) notes.push(money(m.perMillionChars, 2) + '/100万字');
      if (m.voices?.length) notes.push('声: ' + m.voices.slice(0, 8).join(', ') + (m.voices.length > 8 ? ' ほか' : ''));
      return '- `' + m.id + '`' + (notes.length ? ' — ' + notes.join('・') : '');
    })
    .join('\n');
}

/** Tool-capable chat models, cheapest first — what a sub-agent should run on. */
async function chatCatalogue(env) {
  const data = await getCatalog(env).catch(() => ({ models: [] }));
  const models = (data.models || [])
    .filter((m) => m.tools && m.kind === 'chat' && !/:(batch|free)$/.test(m.id))
    .map((m) => ({ id: m.id, out: Number(m.pricing?.output_per_m) || 0 }))
    .filter((m) => m.out > 0)
    .sort((a, b) => a.out - b.out);

  if (!models.length) return '（一覧を取得できませんでした）';
  const cheap = models.slice(0, 18);
  const strong = models.slice(-6).reverse();
  return (
    '安い順（単純作業向け）:\n' +
    cheap.map((m) => '- `' + m.id + '` — 出力 ' + money(m.out, 2) + '/1Mトークン').join('\n') +
    '\n\n高価だが強力（難所だけ）:\n' +
    strong.map((m) => '- `' + m.id + '` — 出力 ' + money(m.out, 2) + '/1Mトークン').join('\n')
  );
}

/* -------------------------------- skills -------------------------------- */

export const SKILLS = {
  image: {
    title: '画像生成',
    when: 'アイコン・ロゴ・背景・バナーなど、画像素材が必要になったとき',
    guide: [
      '`generate_image({ prompt, path, purpose, model, aspect_ratio })` で生成し、そのままワークスペースに保存されます。',
      '',
      '## 選び方',
      '',
      '- `purpose` を渡せば自動で選ばれます: `fast`（下書き）/ `icon`（UI素材）/ `vector`（SVG）/ `photo`（写真）/ `illustration`（イラスト）/ `text`（文字入り）',
      '- ユーザーがモデル名を言った場合は `model` にそのまま渡してください（下の一覧のIDが確実です）',
      '- ロゴやアイコンは `purpose: "vector"` を強く推奨します。SVGで出るので拡大しても劣化しません（拡張子は自動で .svg になります）',
      '- 画像内に文字を入れる場合は `purpose: "text"`。他のモデルは文字が崩れます',
      '',
      '## 注意',
      '',
      '- プロンプトは具体的に。「青いアイコン」より「青を基調にした、角丸の、チェックマークのフラットなアイコン」',
      '- 同じ見た目を揃えたいときは、同じモデル・同じ語彙で書くこと',
    ].join('\n'),
    catalogue: imageCatalogue,
    catalogueTitle: '利用できる画像モデル',
  },

  video: {
    title: '動画生成',
    when: '動画・アニメーション素材が必要なとき（生成に数分かかるので必要なときだけ）',
    guide: [
      '`generate_video({ prompt, path, purpose, model, duration, resolution, aspect_ratio, with_audio })` で生成します。',
      '',
      '## 選び方',
      '',
      '- `purpose`: `fast`（確認用・最安）/ `quality`（仕上げ）/ `audio`（音声つき）',
      '- 尺・解像度はモデルが対応する値に自動で丸められます',
      '',
      '## 注意',
      '',
      '- **1本あたり数分かかります。** 反復回数を消費するので、本当に必要なときだけ使ってください',
      '- 秒単価が高いので、まず `purpose: "fast"` と短い尺で構図を確認し、良ければ本番を生成する進め方が安全です',
      '- 音声が要るかどうかで使えるモデルが変わります',
    ].join('\n'),
    catalogue: videoCatalogue,
    catalogueTitle: '利用できる動画モデル',
  },

  speech: {
    title: '読み上げ・音声生成',
    when: 'ナレーション・セリフ・読み上げ音声のファイルが必要なとき',
    guide: [
      '`generate_speech({ text, path, purpose, model, voice })` で音声ファイルを生成します。',
      '',
      '## 選び方',
      '',
      '- `purpose`: `natural`（日本語が自然・安い）/ `quality`（作品用）/ `free`（無料枠）',
      '- `voice` はモデルごとに使える名前が違います。下の一覧を見てから指定してください',
      '- 拡張子を `.wav` にすると WAV、それ以外は MP3 で保存されます',
      '',
      '## 注意',
      '',
      '- 課金は入力文字数です。長文は分割せず一度に渡して構いません',
      '- 声を指定しない場合はモデルの既定が使われます',
    ].join('\n'),
    catalogue: speechCatalogue,
    catalogueTitle: '利用できる読み上げモデル',
  },

  preview: {
    title: 'プレビュー環境',
    when: '作ったアプリを実際に触れる状態にしたいとき、データを保存するアプリを作るとき',
    guide: [
      '`start_preview` で起動したサーバは、このアプリのドメイン配下の固定URLで開けます。',
      'ユーザーはログイン済みのブラウザからそのまま操作できます。',
      '',
      '## 使い捨てデータベース',
      '',
      '環境変数が渡されているので、アプリ側はこれを読むだけで永続化できます。',
      '',
      '- `PREVIEW_DB` — SQLite ファイルの絶対パス',
      '- `DATABASE_URL` — 同じものを `file:` 形式で',
      '',
      'Node 24 には `node:sqlite` が標準で入っているので、インストールは不要です。',
      '',
      '```js',
      "import { DatabaseSync } from 'node:sqlite';",
      "const db = new DatabaseSync(process.env.PREVIEW_DB ?? './preview.sqlite');",
      "db.exec('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0)');",
      '```',
      '',
      '## 注意',
      '',
      '- サーバは必ず `0.0.0.0` で待ち受けること。**ポート 3000 は予約済み**なので 8080 などを使うこと',
      '- **環境もデータベースも3日で自動削除されます。** 本番用ではありません',
      '- トークルームを削除すると即座に消えます',
      '- 静的なファイルを配るだけなら `npx serve dist -l 0.0.0.0:8080` でも構いません',
    ].join('\n'),
    catalogue: async () => '（このスキルにモデル一覧はありません）',
    catalogueTitle: '補足',
  },

  subagent: {
    title: 'サブエージェント',
    when: '大量生成・単純作業・調査など、自分の文脈を汚したくないまとまった作業があるとき',
    guide: [
      '`spawn_subagent({ task, model, max_steps })` で下請けを立てます。同じワークスペースで作業し、結果は要約だけ返ります。',
      '',
      '## 使いどころ',
      '',
      '- アイコンを20個生成する、といった反復作業',
      '- 大量のファイルを読んで要約する調査',
      '- 自分は設計に集中し、実装の一部を任せたいとき',
      '',
      '## 注意',
      '',
      '- **単純作業には安いモデルを指定してください。** 指定しないと自分と同じモデルが使われ、無駄に高くつきます',
      '- タスクは単独で完結するように書くこと。下請けはこちらの会話を見ていません',
      '- 下請けはさらに下請けを立てられません',
      '- 既定の反復上限は12、最大20です',
    ].join('\n'),
    catalogue: chatCatalogue,
    catalogueTitle: 'サブエージェントに使えるモデル',
  },
};

export const SKILL_IDS = Object.keys(SKILLS);

/** The short index that lives in the system prompt. */
export function skillIndex() {
  return (
    '\n\n<<<利用できるスキル>>>\n' +
    '必要になったら `load_skill` で読み込んでください。読まずに推測で書かないこと。\n' +
    SKILL_IDS.map((id) => '- `' + id + '` — ' + SKILLS[id].title + '：' + SKILLS[id].when).join('\n') +
    '\n<<<ここまで>>>'
  );
}

/**
 * The full skill text. A workspace override replaces the guidance; the live
 * catalogue is always appended so model ids cannot go stale.
 */
export async function renderSkill(env, id, override) {
  const skill = SKILLS[id];
  if (!skill) return null;
  const guide = override?.trim() ? override.trim() : skill.guide;
  const catalogue = await skill.catalogue(env).catch(() => '（一覧を取得できませんでした）');
  return (
    '# スキル: ' + skill.title + '\n\n' +
    guide +
    '\n\n## ' + skill.catalogueTitle + '\n\n' +
    catalogue
  );
}

export const skillPath = (id) => SKILL_DIR + '/' + id + '.md';
