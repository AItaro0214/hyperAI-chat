# hyperAI-chat

Cloudflare Workers 上で動く、シングルユーザー向けのマルチモデル AI チャットです。
OpenRouter と Groq のモデルを切り替えながら、チャット・文書生成・画像／動画／音声生成・
サンドボックスでのアプリ開発まで、ひとつの画面で完結します。

自分専用に作ったものですが、構成はそのまま流用できます。

---

## できること

### チャット
- **OpenRouter と Groq のモデルを会話の途中で切り替え可能**（履歴は引き継がれます）
- Web 検索（Server Tools / プラグインの二方式）、推論の深さ 7 段階、画像生成の自動起動
- 対応していないツールは、モデルを選んだ時点でグレーアウトされます

### ファイルの読み書き
- **読み取り**: Excel / Word / PowerPoint / CSV / PDF / ソースコードなど 30 種以上。
  Office 形式は自前で本文を抽出するため、ファイル入力に対応していないモデルでも読めます
- **書き出し**: 回答をそのまま **Excel / Word / PowerPoint / PDF / CSV** に変換。
  依存ライブラリなしで OOXML を組み立てているので、Workers 上で完結します
  - PowerPoint はネイティブの表・グラフ（編集可能）・図解・3D ピラミッドを生成します

### 生成
- **画像**: 50 モデル。最大 10 枚の一括生成、SVG 出力、参照画像
- **動画**: 28 モデル。秒単価つきで用途別に選択
- **読み上げ**: 18 モデル。日本語対応、ブラウザ内蔵音声へのフォールバックあり
- **録音**: システム音声とマイクをブラウザで録音し、MP3 に変換して添付

生成した画像と動画は、**3 日、またはトークルーム削除で自動的に消えます**
（保存量が増え続けるのを防ぐため）。残したいものはダウンロードしてください。
音声・生成した文書・アップロードしたファイルは対象外で、消えません。

### 開発エージェント
Cloudflare Containers 上のサンドボックスで、コードを書いて動かして直します。

- ファイル操作・コマンド実行・**開発サーバの起動**・**スクリーンショットによる目視確認**
- 素材が必要なら、エージェント自身が画像・動画・音声を生成してワークスペースに保存
- **サブエージェント**に安いモデルで単純作業を任せられます
- **スキル方式**: `AGENTS.md` に「いつどのスキルを読むか」を書いておくと、
  必要なときだけモデル一覧つきの詳細ガイドが読み込まれます
- **X（旧Twitter）検索**: xAI の `x_search` で、Xの投稿をリアルタイムに検索して
  引用元URLつきで受け取ります（`XAI_API_KEY` の登録が必要）
- **プレビュー環境**: 作ったアプリを固定 URL で操作できます。使い捨ての SQLite 付き。
  3 日、またはトークルーム削除で自動的に消えます
- Cloudflare Workflows で動くので、**ブラウザを閉じても作業は続きます**

---

## セキュリティ

シングルユーザー前提で、認証まわりは以下のようにしています。

- **パスワード**: ブラウザ側で PBKDF2 60 万回 → サーバ側で pepper 付き HMAC。
  Workers の CPU 制限下で強い KDF を成立させるための構成です。
  DB が漏れても、pepper（Worker シークレット）なしには総当たりできません
- **二要素認証**: TOTP（RFC 6238）必須。リカバリコードは HMAC ハッシュで保存、1 回限り
- **ロックアウト**: 10 回失敗でアカウントロック
- **API キー**: AES-256-GCM で封緘して D1 に保存。平文は返しません
- **アーティファクト**: `allow-same-origin` なしの iframe で実行するため、
  中身が何を読み込んでもアプリの Cookie やストレージには触れません

---

## 構成

| 用途 | 使っているもの |
|---|---|
| アプリ本体 | Cloudflare Workers + Hono |
| データ | D1（SQLite） |
| ファイル・キャッシュ | Workers KV |
| 開発サンドボックス | Cloudflare Containers + `@cloudflare/sandbox` |
| エージェントの実行 | Cloudflare Workflows |
| スクリーンショット | Browser Rendering |
| ワークスペースの保存 | R2（未設定なら KV にフォールバック） |

外部ライブラリはブラウザ側の 4 つだけです（marked / DOMPurify / qrcode / lamejs）。
サーバ側は Hono と Cloudflare の SDK のみで、OOXML も ZIP も MP3 も自前で組み立てています。

---

## セットアップ

前提: Node.js 18 以上、Cloudflare アカウント。
開発エージェントを使う場合は **Workers Paid プラン（$5/月）** が必要です。

```bash
git clone https://github.com/AItaro0214/hyperAI-chat.git
cd hyperAI-chat
npm install
```

### 1. 設定ファイル

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` を開いて、以下を自分の値に置き換えます。

- `database_id` / `database_name` — D1
- `kv_namespaces[].id` — KV
- `r2_buckets[].bucket_name` — R2（省略可）
- `routes[].pattern` と `vars.APP_NAME` — 独自ドメイン
- `vars.ALLOWED_EMAIL` — ログインを許可する唯一のメールアドレス

### 2. リソースの作成

```bash
npx wrangler d1 create <your-d1-database-name>
npx wrangler kv namespace create KV
npx wrangler r2 bucket create <your-r2-bucket>   # 任意
for f in ./migrations/*.sql; do
  npx wrangler d1 execute <your-d1-database-name> --remote --file="$f"
done
```

### 3. シークレット

```bash
npx wrangler secret put MASTER_KEY   # base64 の 32 バイト（API キーの封緘に使用）
npx wrangler secret put PW_PEPPER    # 十分に長いランダム文字列
```

`MASTER_KEY` の生成例:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

### 4. 最初のユーザー

```bash
node scripts/bootstrap.mjs <メールアドレス> <パスワード>
```

出力された SQL を D1 に流し込みます。初回ログイン時に TOTP の登録画面が出ます。

### 5. デプロイ

```bash
npx wrangler deploy
```

API キーは、デプロイ後に**アプリ内の管理コンソール**から登録します（暗号化して保存されます）。

| キー | 取得先 | 必須 |
|---|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | 必須 |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | 任意 |
| `XAI_API_KEY` | [console.x.ai](https://console.x.ai) | 任意（X検索を使う場合のみ） |

---

## テスト

```bash
npm run dev                       # 別ターミナルで起動しておく

npm run test:unit                 # 依存なしのユニットテスト
npm run test:agent                # エージェント（ツール定義・モデル解決・安全弁）
npm run test:office               # OOXML の生成と読み戻し
npm run test:visual               # グラフ・図解・画像埋め込み
npm run test:api                  # 認証・ルーム・カタログ
npm run test:retention            # 画像・動画の自動削除
npm run test:xai                  # xAI の X 検索
npm run test:ui                   # Puppeteer による画面テスト
```

UI テストは Chrome を使います。パスは環境変数で変えられます。

```bash
CHROME="/path/to/chrome" TEST_EMAIL=you@example.com TEST_PASSWORD=... npm run test:ui
```

---

## 費用の目安

- Workers / D1 / KV — 個人利用なら無料枠に収まります
- 開発エージェント — Workers Paid $5/月（月 6 時間ぶんのコンテナ稼働を含む。
  超過分は `standard-1` で約 $0.074/時。アイドル時は課金されません）
- モデルの利用料 — OpenRouter / Groq の従量課金。アプリ内に料金表があります
- X 検索 — トークン代に加えて**読んだ投稿数**でも課金されます（1件あたり約 $0.005）

画像・動画は 3 日で自動削除されるため、KV / R2 の保存量が積み上がることはありません。

---

## ライセンス

[MIT License](LICENSE) です。改変も再配布も商用利用も自由ですが、
**著作権表示とライセンス文の同梱は必須**です。
