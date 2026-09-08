// The parts of the agent loop that do not need a live container: path safety,
// tool-call assembly, and argument parsing.
import { resolvePath, WORKSPACE, clip, sandboxId } from '../src/lib/workspace.js';
import { TOOLS, SYSTEM_PROMPT, MAX_STEPS, mergeToolCalls, parseArgs, toolResultMessage } from '../src/lib/agent.js';
import {
  PURPOSES, PURPOSE_KEYS, pickImageModel, fixExtension, resolveModelHint,
  VIDEO_PURPOSE_KEYS, SPEECH_PURPOSE_KEYS, pickVideoModel, pickSpeechModel, helpFor, VIDEO_PURPOSES, SPEECH_PURPOSES,
} from '../src/lib/image-purpose.js';
import { DEFAULT_RULES, RULES_FILE, RULES_CANDIDATES, rulesBlock } from '../src/lib/rules.js';
import { subagentTools, SUBAGENT_MAX_STEPS } from '../src/lib/agent-loop.js';
import { detectServerCommand, checkPreviewPort, RESERVED_PORT } from '../src/lib/commands.js';
import { SKILLS, SKILL_IDS, skillIndex, skillPath, SKILL_DIR } from '../src/lib/skills.js';

const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};

/* ------------------------------ path safety ----------------------------- */
check('相対パスを作業ディレクトリに閉じ込める', resolvePath('src/App.jsx') === WORKSPACE + '/src/App.jsx', resolvePath('src/App.jsx'));
check('先頭のスラッシュを剥がす', resolvePath('/etc/passwd') === WORKSPACE + '/etc/passwd', resolvePath('/etc/passwd'));
check('.. で外に出られない', resolvePath('../../etc/passwd') === WORKSPACE + '/etc/passwd', resolvePath('../../etc/passwd'));
check('  途中の .. も落とす', resolvePath('src/../../../root/.ssh/id_rsa') === WORKSPACE + '/src/root/.ssh/id_rsa', resolvePath('src/../../../root/.ssh/id_rsa'));
check('バックスラッシュも正規化', resolvePath('src\\lib\\a.js') === WORKSPACE + '/src/lib/a.js', resolvePath('src\\lib\\a.js'));
check('. は無視', resolvePath('./a/./b.txt') === WORKSPACE + '/a/b.txt');
for (const bad of ['', '/', '..', '../..', './']) {
  let threw = false;
  try {
    resolvePath(bad);
  } catch {
    threw = true;
  }
  check('空になるパスは拒否 (' + JSON.stringify(bad) + ')', threw);
}

check('長い出力は印を付けて切る', clip('x'.repeat(30000)).startsWith('x') && clip('x'.repeat(30000)).includes('省略'), clip('x'.repeat(30000)).length + ' chars');
check('  短い出力はそのまま', clip('hello') === 'hello');

/* ----------------------------- tool schema ------------------------------ */
const names = TOOLS.map((t) => t.function.name);
check('ツールが揃っている',
  ['write_file', 'read_file', 'list_files', 'delete_file', 'run_command', 'start_preview', 'stop_preview',
   'screenshot', 'generate_image', 'generate_video', 'generate_speech', 'spawn_subagent',
   'load_skill'].every((n) => names.includes(n)),
  names.join(', '));
const gen = TOOLS.find((t) => t.function.name === 'generate_image').function;
check('  画像生成ツールは prompt と path を要求する', gen.parameters.required.join(',') === 'prompt,path');
check('  コーディングモデル自身の画像対応は不要と明記', gen.description.includes('対応している必要はない'));
check('  用途を列挙している', gen.parameters.properties.purpose.enum.join(',') === PURPOSE_KEYS.join(','), PURPOSE_KEYS.join(','));
check('  モデル直指定も残してある', !!gen.parameters.properties.model);

/* --------------------------- image model choice ------------------------- */
const catalogue = [
  { id: 'google/gemini-3.1-flash-image' },
  { id: 'recraft/recraft-v4.1-vector' },
  { id: 'openai/gpt-image-2' },
  { id: 'bytedance-seed/seedream-4.5' },
];
check('用途からモデルを選ぶ', pickImageModel(catalogue, { purpose: 'vector' }).model.id === 'recraft/recraft-v4.1-vector');
check('  ベクターは svg を要求する', pickImageModel(catalogue, { purpose: 'vector' }).format === 'svg');
check('  文字入りは GPT image', pickImageModel(catalogue, { purpose: 'text' }).model.id === 'openai/gpt-image-2');
check('  写真は候補順に降りる', pickImageModel(catalogue, { purpose: 'photo' }).model.id === 'bytedance-seed/seedream-4.5');
check('  直接指定が最優先', pickImageModel(catalogue, { model: 'openai/gpt-image-2', purpose: 'photo' }).model.id === 'openai/gpt-image-2');
check('  存在しない指定は用途にフォールバック', pickImageModel(catalogue, { model: 'nope/nope', purpose: 'vector' }).model.id === 'recraft/recraft-v4.1-vector');
check('  用途なしはパネルの既定', pickImageModel(catalogue, { fallback: 'openai/gpt-image-2' }).model.id === 'openai/gpt-image-2');
check('  候補が全滅しても何か返す', !!pickImageModel([{ id: 'x/y' }], { purpose: 'vector' }).model);
check('  空カタログなら null', pickImageModel([], { purpose: 'photo' }).model === null);
check('拡張子を形式に合わせる', fixExtension('public/logo.png', 'svg') === 'public/logo.svg');
check('  拡張子なしにも付ける', fixExtension('public/logo', 'svg') === 'public/logo.svg');
check('  形式指定なしは触らない', fixExtension('a/b.png', null) === 'a/b.png');
check('全用途にモデル候補がある', PURPOSE_KEYS.every((k) => PURPOSES[k].models.length > 0));

/* --------------------------- video and speech --------------------------- */
const videoCat = [
  { id: 'bytedance/seedance-2.0-mini' },
  { id: 'bytedance/seedance-2.5' },
  { id: 'google/veo-3.1' },
  { id: 'minimax/hailuo-3' },
];
/* Ids mirror the live catalogue, so version handling is checked as shipped. */
const realVideo = [
  { id: 'bytedance/seedance-1-5-pro' },
  { id: 'bytedance/seedance-2.0-mini' },
  { id: 'bytedance/seedance-2.5' },
  { id: 'google/veo-3.1' },
  { id: 'minimax/hailuo-3' },
  { id: 'minimax/hailuo-3-max' },
  { id: 'alibaba/wan-3.0-prime' },
];
const vhint = (h) => resolveModelHint(realVideo, h)?.id ?? null;
check('動画をざっくり指名できる（バージョンつき）', vhint('seedance2.5') === 'bytedance/seedance-2.5', vhint('seedance2.5'));
check('  空白入りでも同じ', vhint('seedance 2.5') === 'bytedance/seedance-2.5');
check('  カタカナ＋数字でも', vhint('シードダンス2.5') === 'bytedance/seedance-2.5', vhint('シードダンス2.5'));
check('  修飾語で下位版も選べる', vhint('seedance mini') === 'bytedance/seedance-2.0-mini', vhint('seedance mini'));
check('  ファミリー名だけなら上位版', vhint('minimax') === 'minimax/hailuo-3-max', vhint('minimax'));
check('  veo', vhint('veoで作って') === 'google/veo-3.1');
check('  wan', vhint('wan') === 'alibaba/wan-3.0-prime');
check('  日本語だけならモデル指定なし', vhint('一番安いやつ') === null);

const realImage = [
  { id: 'openai/gpt-image-2' },
  { id: 'openai/gpt-image-1-mini' },
  { id: 'bytedance-seed/seedream-4.5' },
  { id: 'bytedance-seed/seedream-5-0-pro' },
  { id: 'black-forest-labs/flux.2-pro' },
  { id: 'black-forest-labs/flux.2-max' },
  { id: 'recraft/recraft-v4.1' },
  { id: 'recraft/recraft-v4.1-pro-vector' },
];
const ihint = (h) => resolveModelHint(realImage, h)?.id ?? null;
check('画像も同じ規則', ihint('seedream4.5') === 'bytedance-seed/seedream-4.5', ihint('seedream4.5'));
check('  汎用語だけに引っ張られない', ihint('flux2 pro') === 'black-forest-labs/flux.2-pro', ihint('flux2 pro'));
check('  バージョン無指定なら上位版', ihint('seedream') === 'bytedance-seed/seedream-5-0-pro');

check('動画: 安いのを選べる', pickVideoModel(videoCat, { purpose: 'fast' }).model.id === 'bytedance/seedance-2.0-mini');
check('  高品質は veo', pickVideoModel(videoCat, { purpose: 'quality' }).model.id === 'google/veo-3.1');
check('  通称でも引ける', pickVideoModel(videoCat, { model: 'veoで' }).model.id === 'google/veo-3.1');
check('  既定は安いモデル', pickVideoModel(videoCat, {}).model.id === 'bytedance/seedance-2.0-mini');

const speechCat = [
  { id: 'google/gemini-3.1-flash-tts-preview' },
  { id: 'qwen/qwen-audio-3.0-tts-plus' },
  { id: 'deepgram/flux-tts:free' },
];
check('音声: 自然さ優先は Gemini', pickSpeechModel(speechCat, { purpose: 'natural' }).model.id === 'google/gemini-3.1-flash-tts-preview');
check('  高品質は qwen plus', pickSpeechModel(speechCat, { purpose: 'quality' }).model.id === 'qwen/qwen-audio-3.0-tts-plus');
check('  無料枠も選べる', pickSpeechModel(speechCat, { purpose: 'free' }).model.id === 'deepgram/flux-tts:free');
check('  空カタログなら null', pickSpeechModel([], { purpose: 'natural' }).model === null);

const videoTool = TOOLS.find((t) => t.function.name === 'generate_video').function;
const speechTool = TOOLS.find((t) => t.function.name === 'generate_speech').function;
check('動画ツールの用途が列挙されている', videoTool.parameters.properties.purpose.enum.join(',') === VIDEO_PURPOSE_KEYS.join(','));
check('  時間のかかる処理だと明記', videoTool.description.includes('数分'));
check('音声ツールの用途が列挙されている', speechTool.parameters.properties.purpose.enum.join(',') === SPEECH_PURPOSE_KEYS.join(','));
check('  声も指定できる', !!speechTool.parameters.properties.voice);
check('用途の説明文が生成される', helpFor(VIDEO_PURPOSES).includes('速い') && helpFor(SPEECH_PURPOSES).includes('無料'));

/* ------------------------- loose model names ---------------------------- */
const wide = [
  { id: 'google/gemini-3.1-flash-image' },
  { id: 'google/gemini-3-pro-image' },
  { id: 'openai/gpt-image-2' },
  { id: 'openai/gpt-image-1-mini' },
  { id: 'bytedance-seed/seedream-5-0-pro' },
  { id: 'black-forest-labs/flux.2-pro' },
  { id: 'recraft/recraft-v4.1' },
  { id: 'recraft/recraft-v4.1-vector' },
  { id: 'qwen/qwen-image-3' },
  { id: 'x-ai/grok-imagine-image-2.0' },
];
const hint = (h) => resolveModelHint(wide, h)?.id ?? null;
check('通称からモデルを引ける（GPT）', hint('gptの画像生成') === 'openai/gpt-image-2', hint('gptの画像生成'));
check('  日本語のカタカナでも引ける', hint('ジェミニで') === 'google/gemini-3-pro-image', hint('ジェミニで'));
check('  nano banana は該当モデルに', hint('nano bananaで作って') === 'google/gemini-3.1-flash-image');
check('  seedream', hint('シードリーム') === 'bytedance-seed/seedream-5-0-pro');
check('  flux', hint('fluxで') === 'black-forest-labs/flux.2-pro');
check('  grok', hint('グロックの画像') === 'x-ai/grok-imagine-image-2.0');
check('  recraft はベクター指定を汲む', hint('recraftのベクターで') === 'recraft/recraft-v4.1-vector', hint('recraftのベクターで'));
check('  ベクター指定なしなら通常版', hint('recraft') === 'recraft/recraft-v4.1', hint('recraft'));
check('  正確なIDはそのまま', hint('qwen/qwen-image-3') === 'qwen/qwen-image-3');
check('  該当なしは null', hint('存在しないモデル') === null);
check('  空文字も null', hint('') === null);
const viaTool = pickImageModel(wide, { model: 'gptで', purpose: 'photo' });
check('曖昧指定でも用途より優先される', viaTool.model.id === 'openai/gpt-image-2', viaTool.why);
check('  ベクターを指定すると svg になる', pickImageModel(wide, { model: 'recraftのベクター' }).format === 'svg');
check('  すべて function 型', TOOLS.every((t) => t.type === 'function' && t.function.parameters?.type === 'object'));
check('  必須引数が定義されている',
  TOOLS.find((t) => t.function.name === 'write_file').function.parameters.required.join(',') === 'path,content');
check('  説明が入っている', TOOLS.every((t) => (t.function.description || '').length > 10));
check('システムプロンプトが確認を要求する', SYSTEM_PROMPT.includes('推測で') && SYSTEM_PROMPT.includes('スクリーンショット'));
check('  0.0.0.0 の注意がある', SYSTEM_PROMPT.includes('0.0.0.0'));
// The image has no Python; claiming otherwise sends the agent down a dead end.
check('  使える処理系を正しく伝えている', SYSTEM_PROMPT.includes('Node.js 24') && !/Python 3/.test(SYSTEM_PROMPT));
check('  素材は generate_image を使うよう指示している', SYSTEM_PROMPT.includes('generate_image'));
check('反復上限が設定されている', MAX_STEPS > 0 && MAX_STEPS <= 50, String(MAX_STEPS));

/* --------------------------- streamed tool calls ------------------------ */
let calls = mergeToolCalls([], [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"comm' } }]);
calls = mergeToolCalls(calls, [{ index: 0, function: { arguments: 'and":"npm test"}' } }]);
check('分割されたツール呼び出しを結合する', calls.length === 1 && calls[0].function.arguments === '{"command":"npm test"}', JSON.stringify(calls[0]));
check('  id と name が保たれる', calls[0].id === 'call_1' && calls[0].function.name === 'run_command');

calls = mergeToolCalls([], [
  { index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } },
  { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } },
]);
check('複数の呼び出しを並べて保持する', calls.length === 2 && calls[1].id === 'b');

/* ------------------------------- arguments ------------------------------ */
check('JSON 引数を読む', parseArgs('{"path":"a.txt"}').path === 'a.txt');
check('前後にゴミが付いても読む', parseArgs('ここです {"path":"a.txt"} 以上') .path === 'a.txt');
check('壊れた引数は空オブジェクト', JSON.stringify(parseArgs('{{{')) === '{}');
check('未指定も空オブジェクト', JSON.stringify(parseArgs(undefined)) === '{}');

/* ------------------------------ tool results ---------------------------- */
const msg = toolResultMessage({ id: 'c1', function: { name: 'run_command' } }, { text: 'x'.repeat(40000) });
check('ツール結果は tool ロールで返す', msg.role === 'tool' && msg.tool_call_id === 'c1' && msg.name === 'run_command');
check('  長すぎる出力は切り詰める', msg.content.length === 24000, msg.content.length + ' chars');

/* --------------------- long-running command guardrail -------------------- */
for (const cmd of ['npm run dev', 'npm run dev -- --host 0.0.0.0', 'vite', 'npx vite --host',
                   'next dev', 'pnpm dev', 'python3 -m http.server 8000', 'tsc --watch', 'nodemon app.js']) {
  check('止まらないコマンドを弾く: ' + cmd, detectServerCommand(cmd) !== null, detectServerCommand(cmd));
}
for (const cmd of ['npm run build', 'npm test', 'vite build', 'npm install', 'ls -la', 'git status',
                   'node server.js &', 'npx vitest run']) {
  check('  通す: ' + cmd, detectServerCommand(cmd) === null, String(detectServerCommand(cmd)));
}

/* ------------------------------ preview ports --------------------------- */
// Port 3000 is the sandbox control plane; using it fails after the server is
// already up, which used to leave an orphan process behind.
check('予約ポート 3000 を弾く', checkPreviewPort(3000) !== null, checkPreviewPort(3000));
check('  代替ポートを案内する', checkPreviewPort(3000).includes('8080'));
check('  1024 未満を弾く', checkPreviewPort(80) !== null);
check('  65535 超を弾く', checkPreviewPort(70000) !== null);
check('  数値でないものを弾く', checkPreviewPort('abc') !== null);
for (const ok of [1024, 5173, 8080, 8000, 4173, 65535]) {
  check('  通す: ' + ok, checkPreviewPort(ok) === null);
}
check('予約ポートは 3000 のみ', RESERVED_PORT === 3000);

/* ------------------------------ sandbox ids ----------------------------- */
const dnsSafe = (id) => /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id) && id.length <= 63;
check('サンドボックスIDはDNS的に安全', dnsSafe(sandboxId('room_jGc8L-uV4AhD_CyB')), sandboxId('room_jGc8L-uV4AhD_CyB'));
check('  ハイフン終わりのIDでも壊れない', dnsSafe(sandboxId('room_abcdefghijklmn-')), sandboxId('room_abcdefghijklmn-'));
check('  ハイフン始まりでも壊れない', dnsSafe(sandboxId('-room_abc')), sandboxId('-room_abc'));
check('  アンダースコア終わりでも壊れない', dnsSafe(sandboxId('room_abc_')));
check('  未指定でも有効', dnsSafe(sandboxId(null)) && dnsSafe(sandboxId('')));
check('  同じ入力は同じID', sandboxId('room_x') === sandboxId('room_x'));
check('  違う入力は違うID（衝突しない）', sandboxId('room_a-b') !== sandboxId('room_a0b'));
check('  長いIDでも63文字以内', dnsSafe(sandboxId('room_' + 'x'.repeat(120))), String(sandboxId('room_' + 'x'.repeat(120)).length));
let collisions = 0;
const seen = new Set();
for (let i = 0; i < 3000; i++) {
  const id = sandboxId('room_' + Math.random().toString(36).slice(2) + '-');
  if (seen.has(id)) collisions++;
  seen.add(id);
}
check('  3000件でも衝突なし', collisions === 0);

/* -------------------------------- skills -------------------------------- */
check('スキルが5種そろっている', SKILL_IDS.join(',') === 'image,video,speech,preview,subagent', SKILL_IDS.join(','));
check('  プレビューのスキルが使い捨てDBを説明している',
  SKILLS.preview.guide.includes('PREVIEW_DB') && SKILLS.preview.guide.includes('node:sqlite'));
check('    3日で消えると明記', SKILLS.preview.guide.includes('3日'));
for (const id of SKILL_IDS) {
  const skill = SKILLS[id];
  check('  ' + id + ' に説明と使いどころがある', !!skill.title && skill.when.length > 8 && skill.guide.length > 100);
  check('    モデル一覧を持っている', typeof skill.catalogue === 'function');
}
const index = skillIndex();
check('索引は全スキルを並べる', SKILL_IDS.every((id) => index.includes('`' + id + '`')));
check('  いつ使うかが索引に書いてある', index.includes(SKILLS.image.when));
// The index is what rides in every prompt, so its size is the thing to watch.
check('  索引は十分に小さい', index.length < 700, index.length + ' 文字');
check('  読めと指示している', index.includes('load_skill'));
check('スキルの保存先は .agent/skills', skillPath('image') === SKILL_DIR + '/image.md', skillPath('image'));

const skillTool = TOOLS.find((t) => t.function.name === 'load_skill').function;
check('load_skill は候補を列挙する', skillTool.parameters.properties.name.enum.join(',') === SKILL_IDS.join(','));
check('  使う前に読めと書いてある', skillTool.description.includes('前に'));
check('画像スキルがベクターを勧めている', SKILLS.image.guide.includes('vector'));
check('動画スキルが時間とコストを警告している', SKILLS.video.guide.includes('数分') && SKILLS.video.guide.includes('秒単価'));
check('サブエージェントのスキルが安いモデルを勧めている', SKILLS.subagent.guide.includes('安いモデル'));

/* ------------------------------ sub-agents ------------------------------ */
const subTools = subagentTools().map((t) => t.function.name);
check('下請けは自分では再帰できない', !subTools.includes('spawn_subagent'), subTools.length + ' tools');
check('  それ以外のツールは全部使える', subTools.length === TOOLS.length - 1);
check('  反復上限が決まっている', SUBAGENT_MAX_STEPS > 0 && SUBAGENT_MAX_STEPS <= 20, String(SUBAGENT_MAX_STEPS));
const spawn = TOOLS.find((t) => t.function.name === 'spawn_subagent').function;
check('  task が必須', spawn.parameters.required.join(',') === 'task');
check('  モデルは通称でよいと書いてある', spawn.parameters.properties.model.description.includes('通称'));
check('  結果が要約で返ると明記', spawn.description.includes('要約'));
check('システムプロンプトが下請けの使いどころを説明', SYSTEM_PROMPT.includes('spawn_subagent'));

/* ----------------------------- project rules ---------------------------- */
check('ルールファイルは AGENTS.md', RULES_FILE === 'AGENTS.md');
check('ひな形がスキルへの導線になっている',
  SKILL_IDS.every((id) => DEFAULT_RULES.includes('`' + id + '`')) && DEFAULT_RULES.includes('load_skill'));
check('  モデル名を直書きしていない', !/gpt-image|seedance|gemini-3/.test(DEFAULT_RULES));
const block = rulesBlock({ name: 'AGENTS.md', text: '- 必ず日本語で答える' });
check('ルールは区切って渡す', block.includes('プロジェクト共通ルール') && block.includes('必ず日本語で答える'));
check('  空なら何も足さない', rulesBlock(null) === '' && rulesBlock({ name: 'x', text: '   ' }) === '');
check('既存リポジトリの慣習も拾う', RULES_CANDIDATES.includes('CLAUDE.md') && RULES_CANDIDATES[0] === 'AGENTS.md', RULES_CANDIDATES.join(', '));

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2]));
  process.exit(1);
}
