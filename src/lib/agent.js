/* The agent loop: the model writes code, runs it, looks at the result, fixes it.
 *
 * Tools are ordinary OpenAI-style function calls, so this works on both
 * OpenRouter and Groq. Every call is executed against the room's sandbox and
 * the result is fed straight back, up to a hard iteration and time budget. */

import { PURPOSE_KEYS, purposeHelp, VIDEO_PURPOSE_KEYS, SPEECH_PURPOSE_KEYS, VIDEO_PURPOSES, SPEECH_PURPOSES, helpFor } from './image-purpose.js';
import { SKILL_IDS } from './skills.js';

export const MAX_STEPS = 24;
export const MAX_WALL_MS = 9 * 60 * 1000;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'ワークスペースにファイルを書き込む（既存なら上書き）。パスは作業ディレクトリからの相対パス。親ディレクトリは自動で作成される。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '例: src/App.jsx' },
          content: { type: 'string', description: 'ファイルの全文' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'ワークスペースのファイルを読む。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'ワークスペースのファイル一覧を返す（node_modules と .git は除外）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'ワークスペースのファイルまたはディレクトリを削除する。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'ワークスペースでシェルコマンドを実行し、終了コードと標準出力・標準エラーを返す。npm install / テスト / ビルド / git などに使う。' +
        '完了まで待つので、開発サーバのような終了しないコマンドには start_preview を使うこと。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '例: npm install && npm test' },
          timeout_ms: { type: 'integer', description: '既定 120000、最大 300000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_preview',
      description:
        '開発サーバをバックグラウンドで起動し、プレビューURLを返す。' +
        'サーバは 0.0.0.0 で待ち受けること。ポートは 1024〜65535 で、' +
        '3000 はコンテナの制御用に予約されているため使えない（8080 などを使う）。' +
        '起動済みの場合は先に stop_preview すること。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '例: npm run dev -- --host 0.0.0.0 --port 8080' },
          port: { type: 'integer', description: 'サーバが待ち受けるポート番号。3000 は使用不可' },
        },
        required: ['command', 'port'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_preview',
      description: '開発サーバを停止してプレビューURLを閉じる。',
      parameters: {
        type: 'object',
        properties: { port: { type: 'integer' } },
        required: ['port'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        '画像を生成してワークスペースに保存する。アプリに必要な素材（アイコン・背景・イラスト等）を自分で用意するために使う。' +
        '画像生成専用のモデルが裏で動くので、あなた自身が画像生成に対応している必要はない。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '生成したい画像の説明。具体的に書くほど良い' },
          path: { type: 'string', description: '保存先の相対パス。例: public/assets/hero.png' },
          purpose: {
            type: 'string',
            enum: PURPOSE_KEYS,
            description: '用途に合わせてモデルが自動で選ばれる。' + purposeHelp(),
          },
          model: {
            type: 'string',
            description:
              'モデルを指定したい場合。正確なIDでなくてよく、「gpt」「gemini」「seedream」「flux」「recraft」' +
              'のような通称でも解決される。ユーザーがモデル名を指示したときはそのまま渡すこと',
          },
          aspect_ratio: { type: 'string', description: '例: 1:1, 16:9, 9:16。省略可' },
        },
        required: ['prompt', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description:
        '動画を生成してワークスペースに保存する。生成には数分かかるので、本当に必要なときだけ使うこと。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '生成したい映像の説明' },
          path: { type: 'string', description: '保存先の相対パス。例: public/assets/intro.mp4' },
          purpose: { type: 'string', enum: VIDEO_PURPOSE_KEYS, description: helpFor(VIDEO_PURPOSES) },
          model: { type: 'string', description: '通称でよい（seedance / veo / hailuo など）' },
          duration: { type: 'integer', description: '秒数。モデルが対応する値に丸められる' },
          resolution: { type: 'string', description: '例: 480p, 720p, 1080p' },
          aspect_ratio: { type: 'string', description: '例: 16:9, 9:16' },
          with_audio: { type: 'boolean', description: '音声つきで生成する（対応モデルのみ）' },
        },
        required: ['prompt', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_speech',
      description:
        'テキストを読み上げた音声ファイルをワークスペースに保存する。ナレーションや効果音の代わりに使う。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '読み上げる文章' },
          path: { type: 'string', description: '保存先の相対パス。例: public/assets/intro.mp3' },
          purpose: { type: 'string', enum: SPEECH_PURPOSE_KEYS, description: helpFor(SPEECH_PURPOSES) },
          model: { type: 'string', description: '通称でよい（gemini / qwen / minimax など）' },
          voice: { type: 'string', description: '声の名前。省略するとモデルの既定' },
        },
        required: ['text', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'スキルの説明と、そこで使えるモデルの正確な一覧を読み込む。' +
        '画像・動画・音声・サブエージェントを使う前に、対応するスキルを必ず読むこと。' +
        '一度読めば同じ実行の中で読み直す必要はない。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', enum: SKILL_IDS, description: '読み込むスキル' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        '同じワークスペースで作業する下請けのエージェントを立てて、まとまった作業を任せる。' +
        '結果は要約だけ返るので、大量のファイル生成や調査でこちらの文脈を汚したくないときに使う。' +
        '安いモデルを指定して単純作業を任せるのにも向く。下請けはさらに下請けを立てられない。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '任せる作業。単独で完結するように具体的に書くこと' },
          model: { type: 'string', description: '通称でよい（glm / qwen / kimi など）。省略すると自分と同じモデル' },
          max_steps: { type: 'integer', description: '下請けの反復上限。既定 12、最大 20' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        '起動中のプレビューを実際のブラウザで開いてスクリーンショットを撮り、画像とコンソールエラーを返す。' +
        '見た目を確認して直すために使う。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'プレビューURLからの相対パス。既定は /' },
          width: { type: 'integer', description: '既定 1280' },
          height: { type: 'integer', description: '既定 800' },
          full_page: { type: 'boolean', description: 'ページ全体を撮るなら true' },
        },
      },
    },
  },
];

export const SYSTEM_PROMPT = [
  'あなたは Linux コンテナの中で実際に手を動かせる開発エージェントです。',
  '作業ディレクトリは /workspace/project で、会話をまたいで内容が残ります。',
  'Node.js 24 / npm / npx / bun / git / zip が使えます。ネットワークも使えます。Python は入っていません。',
  '',
  '進め方:',
  '1. まず list_files で今の状態を確認する。',
  '2. コードを書いたら必ず run_command で実行・テストして、結果を見て直す。',
  '3. 画像素材が要るときは generate_image でワークスペースに直接書き出す。自分で描こうとしない。',
  '   用途に応じて purpose を指定する（ロゴやアイコンは vector で SVG、背景写真は photo、文字入りは text）。',
  '   動画は generate_video、ナレーションなどの音声は generate_speech で同じように用意できる。',
  '   使う前に load_skill で該当スキルを読むこと。正確なモデルIDと注意点が書いてある。',
  '4. 単純作業や大量生成は spawn_subagent に任せると、自分の文脈を汚さずに済む（結果は要約で返る）。',
  '5. 画面のあるものは start_preview でサーバを起動し、screenshot で見た目を自分の目で確認して直す。',
  '6. 推測で「できました」と言わない。実行結果かスクリーンショットで確かめてから報告する。',
  '',
  '注意:',
  '- 開発サーバは必ず 0.0.0.0 で待ち受けること（localhost だと外から見えない）。',
  '- ポート 3000 は予約済みで使えない。8080 など 1024〜65535 の別の番号にすること。',
  '- ファイルは write_file で書く。ヒアドキュメントでの書き込みは壊れやすい。',
  '- 長い作業は小さく分けて、都度確認する。',
  '- 最後に何を作り何を確認したかを日本語で簡潔に報告する。',
].join('\n');

/** Merges streamed tool-call deltas into whole calls. */
export function mergeToolCalls(existing, deltas) {
  const calls = existing.slice();
  for (const delta of deltas || []) {
    const at = delta.index ?? calls.length;
    if (!calls[at]) calls[at] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    const call = calls[at];
    if (delta.id) call.id = delta.id;
    if (delta.type) call.type = delta.type;
    if (delta.function?.name) call.function.name = delta.function.name;
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
  }
  return calls;
}

export function parseArgs(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Models occasionally emit trailing commentary after the JSON object.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

/** Nothing here should ever hand the model an unbounded transcript. */
export function toolResultMessage(call, result) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content: String(result.text || '').slice(0, 24000),
  };
}
