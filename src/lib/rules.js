/* Project-rule constants and formatting, kept free of the Sandbox SDK so they
 * can be reasoned about — and tested — without the Workers runtime. */

export const RULES_FILE = 'AGENTS.md';

/** Read in order; the first one present wins, so an existing repo just works. */
export const RULES_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', '.agentrules', 'AGENT.md'];

export const MAX_RULES = 16000;

/* The template routes through skills rather than restating model names: the
 * skill carries the live catalogue, so this file cannot go stale. */
export const DEFAULT_RULES = [
  '# プロジェクトのルール',
  '',
  'このファイルはエージェントが毎回読み込みます。守ってほしい決まりをここに書いてください。',
  '',
  '## スキルの使い分け',
  '',
  '作業に入る前に `load_skill` で該当スキルを読むこと。推測でモデル名を書かない。',
  '',
  '| 状況 | 読むスキル |',
  '|---|---|',
  '| アイコン・ロゴ・背景・バナーが要る | `image` |',
  '| 動画・アニメーションが要る | `video` |',
  '| ナレーション・読み上げ音声が要る | `speech` |',
  '| 大量生成や単純作業を任せたい | `subagent` |',
  '| 動くアプリとして触れるようにしたい・データを保存したい | `preview` |',
  '',
  '## 素材の置き場所',
  '',
  '- 画像・動画・音声はすべて `public/assets/` に置く',
  '- ロゴとアイコンは SVG（`image` スキル参照）',
  '',
  '## コード',
  '',
  '- 変更したら必ずテストを実行して結果を確認する',
  '- 画面があるものは起動してスクリーンショットで見た目を確認する',
  '- 単純作業は安いモデルのサブエージェントに任せる',
].join('\n');

/** Wraps the rules so the model can tell them apart from the task. */
export function rulesBlock(rules) {
  if (!rules?.text?.trim()) return '';
  return (
    '\n\n<<<プロジェクト共通ルール（' + rules.name + '）— 以下は毎回必ず守ること>>>\n' +
    rules.text.trim() +
    '\n<<<ここまで>>>'
  );
}
