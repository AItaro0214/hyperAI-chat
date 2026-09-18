/* Skills: guidance the agent pulls in only when the job calls for it.
 *
 * The system prompt carries a short index — name and when to use it — and the
 * full text is fetched with load_skill. Progressive disclosure: the index costs
 * a couple of hundred tokens, and the guidance is only paid for when relevant.
 *
 * Model ids are deliberately not in here. A rendered list is stale the moment a
 * generation ships, and it was two thirds of this file's output by volume; the
 * skill teaches the judgement and list_models supplies the facts.
 *
 * A workspace file at .agent/skills/<id>.md overrides the built-in guidance, so
 * a project can teach the agent its own conventions. */


export const SKILL_DIR = '.agent/skills';

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
      '- ユーザーがモデル名を言った場合は `model` にそのまま渡してください。通称でも解決されます',
      '- ロゴやアイコンは `purpose: "vector"` を強く推奨します。SVGで出るので拡大しても劣化しません（拡張子は自動で .svg になります）',
      '- 画像内に文字を入れる場合は `purpose: "text"`。他のモデルは文字が崩れます',
      '',
      '## 注意',
      '',
      '- プロンプトは具体的に。「青いアイコン」より「青を基調にした、角丸の、チェックマークのフラットなアイコン」',
      '- 同じ見た目を揃えたいときは、同じモデル・同じ語彙で書くこと',
    ].join('\n'),
    models: true,
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
    models: true,
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
      '- `voice` はモデルごとに使える名前が違います。`list_models({ kind: "speech" })` で確認してから指定してください',
      '- 拡張子を `.wav` にすると WAV、それ以外は MP3 で保存されます',
      '',
      '## 注意',
      '',
      '- 課金は入力文字数です。長文は分割せず一度に渡して構いません',
      '- 声を指定しない場合はモデルの既定が使われます',
    ].join('\n'),
    models: true,
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
  },

  xsearch: {
    title: 'X（旧Twitter）検索',
    when: '世間の反応・最新の話題・特定アカウントの発言など、Xの一次情報が要るとき',
    guide: [
      '`search_x({ query, from_date, to_date, handles, exclude_handles, images, videos, also_web })` で、Xをリアルタイム検索して要約と引用元URLを受け取ります。',
      '検索はxAI側（Grok）で実行されます。こちらでURLを組み立てたり、スクレイピングしたりする必要はありません。',
      '',
      '## いつ使うか',
      '',
      '- **通常のWeb検索では届かないとき**に使ってください。Xの投稿は検索エンジンにほとんど載りません',
      '- 向いていること: 発表直後の反応、不具合の目撃報告、特定の人物・企業アカウントの発言、いま話題になっていること',
      '- 向いていないこと: 定義や仕様の確認、安定した事実。それはWeb検索のほうが正確です',
      '',
      '## 書き方',
      '',
      '- `query` はキーワードの羅列ではなく**質問文**にしてください。「Cloudflare Containers 障害」より「Cloudflare Containers で最近報告されている不具合は何か」のほうが精度が上がります',
      '- 期間を絞ると精度も速度も上がります。「最近」と書くだけでは絞られないので `from_date` を明示してください',
      '- 特定アカウントを追うなら `handles: ["CloudflareDev"]`（@は不要、最大20）。`exclude_handles` とは同時に使えません',
      '- 画像や動画の中身まで読ませたいときだけ `images` / `videos` を true に。既定はオフで、有効にすると目に見えて遅くなります',
      '',
      '## 注意',
      '',
      '- **`XAI_API_KEY` の登録が必要です**（管理コンソール → キー）。未登録ならこのツールは使えません',
      '- 課金はトークンに加えて**読んだ投稿数**でも発生します（1件あたり約 $0.005）。期間やアカウントで絞るほど安くなります',
      '- 返ってくるのは要約と引用元URLです。**そのまま事実として扱わないでください** — Xの投稿は裏取りされていません。重要な主張は引用元を開いて確認するか、Web検索で突き合わせること',
    ].join('\n'),
    models: true,
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
    models: true,
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

/** The full skill text. A workspace override replaces the guidance. */
export function renderSkill(env, id, override) {
  const skill = SKILLS[id];
  if (!skill) return null;
  const guide = override?.trim() ? override.trim() : skill.guide;
  return (
    '# スキル: ' + skill.title + '\n\n' +
    guide +
    (skill.models
      ? '\n\n## モデルID\n\n' +
        'ここには一覧を載せていません。**`list_models` で引いてください。**\n' +
        '提供元のカタログを直接読むので、そこに出たIDだけが今日実在するIDです。\n' +
        '記憶で書いたIDは世代が古いことがあります。'
      : '')
  );
}

export const skillPath = (id) => SKILL_DIR + '/' + id + '.md';
