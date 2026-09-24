/* Settings forms built from what each model publishes.
 *
 * Fixtures are copied from the live OpenRouter listings (2026-09-24) so the
 * shapes are the real ones: a typed schema for images, typed lists and bare
 * passthrough names for video, and the verified speech manifest.
 */
import {
  imageFields,
  videoFields,
  speechFields,
  styledText,
  sanitizeParams,
  passthroughBody,
  speechFamily,
} from '../src/lib/media-params.js';
import { formatFor, readAudioStream } from '../src/lib/speech.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};
const keys = (fields) => fields.map((f) => f.key).join(',');

/* -------------------------------- images --------------------------------- */
const gptImage = {
  aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'] },
  quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
  background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] },
  n: { type: 'range', min: 1, max: 10 },
  input_references: { type: 'range', min: 0, max: 16 },
  output_compression: { type: 'range', min: 0, max: 100 },
  seed: { type: 'boolean' },
};
const gf = imageFields(gptImage);
check('画像: 公開スキーマから項目を作る', keys(gf) === 'aspect_ratio,quality,background,output_compression,seed', keys(gf));
check('  枚数と参照画像は専用 UI に任せる', !gf.some((f) => f.key === 'n' || f.key === 'input_references'));
check('  enum は選択肢をそのまま', gf.find((f) => f.key === 'quality').values.includes('xhigh'));
check('  range はスライダー', gf.find((f) => f.key === 'output_compression').type === 'range');
check('  seed は数値入力', gf.find((f) => f.key === 'seed').type === 'number', '宣言は boolean、入力は数値');

const qwenImage = {
  resolution: { type: 'enum', values: ['1K', '2K'] },
  aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
  n: { type: 'range', min: 1, max: 6 },
};
check('Qwen Image も同じ仕組みで', keys(imageFields(qwenImage)) === 'aspect_ratio,resolution');
check('選択肢が1つなら出さない', imageFields({ resolution: { type: 'enum', values: ['1K'] } }).length === 0);
check('未知の型は出さない', imageFields({ mystery: { type: 'vector' } }).length === 0);

/* --------------------------------- video --------------------------------- */
const seedance = {
  id: 'bytedance/seedance-2.0',
  resolutions: ['480p', '720p', '1080p', '4K'],
  aspectRatios: ['16:9', '9:16', '1:1'],
  durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  sizes: [],
  generateAudio: true,
  seed: true,
  passthrough: ['watermark', 'req_key'],
};
const sf = videoFields(seedance);
check('Seedance: 項目を作る', keys(sf) === 'duration,resolution,aspect_ratio,generate_audio,seed,watermark', keys(sf));
check('  既定の長さは 5 秒', sf.find((f) => f.key === 'duration').default === 5);
check('  内部キー req_key は出さない', !sf.some((f) => f.key === 'req_key'));
check('  watermark は真偽で', sf.find((f) => f.key === 'watermark').type === 'boolean');
check('  watermark は既定値なし（3択）', sf.find((f) => f.key === 'watermark').default === undefined, '触らなければ送らない');

const hailuo = { id: 'minimax/hailuo-3', resolutions: ['2K'], aspectRatios: ['16:9', '9:16'], durations: [5, 6, 10], sizes: [], generateAudio: true, seed: false, passthrough: ['aigc_watermark'] };
const hf = videoFields(hailuo);
check('Hailuo: 解像度1つなら出さない', !hf.some((f) => f.key === 'resolution'), keys(hf));
check('  seed 非対応なら出さない', !hf.some((f) => f.key === 'seed'));

const veo = { id: 'google/veo-3.1', resolutions: ['720p', '1080p', '4K'], aspectRatios: [], durations: [4, 6, 8], sizes: [], generateAudio: true, seed: true, passthrough: ['personGeneration', 'aspectRatio', 'negativePrompt', 'conditioningScale', 'enhancePrompt'] };
const vf = videoFields(veo);
check('Veo: 既存項目と重複する aspectRatio は出さない', !vf.some((f) => f.key === 'aspectRatio'), keys(vf));
check('  negativePrompt はテキスト', vf.find((f) => f.key === 'negativePrompt')?.type === 'text');
check('  意味不明な名前は自由入力', vf.find((f) => f.key === 'personGeneration')?.type === 'raw');
check('  固有項目は詳細側', vf.filter((f) => f.target === 'passthrough').every((f) => f.advanced));

const wan = { id: 'alibaba/wan-2.7', resolutions: ['720p', '1080p'], aspectRatios: [], durations: [2, 5], sizes: [], generateAudio: true, seed: true, passthrough: ['negative_prompt', 'prompt_extend', 'audio', 'ratio', 'last_image', 'video', 'videos', 'images'] };
const wf = videoFields(wan);
check('Wan: メディア入力の名前はテキスト欄にしない', !wf.some((f) => ['audio', 'last_image', 'video', 'videos', 'images'].includes(f.key)), keys(wf));

/* ----------------------------- passthrough ------------------------------- */
check('Vertex は parameters で包む', JSON.stringify(passthroughBody('google-vertex', { negativePrompt: 'blur' })) === '{"options":{"google-vertex":{"parameters":{"negativePrompt":"blur"}}}}');
check('他はそのまま', JSON.stringify(passthroughBody('seed', { watermark: false })) === '{"options":{"seed":{"watermark":false}}}');
check('空なら付けない', passthroughBody('seed', {}) === null && passthroughBody(null, { a: 1 }) === null);

/* ------------------------------ validation ------------------------------- */
const clean = sanitizeParams(sf, {
  duration: '8',
  resolution: '8K',
  generate_audio: 'true',
  seed: '12.7',
  watermark: false,
  req_key: 'x',
  evil: '<script>',
});
check('検証: 文字列の "8" を数値 8 に戻す', clean.body.duration === 8, JSON.stringify(clean.body));
check('  選択肢外の値は捨てる', !('resolution' in clean.body));
check('  真偽は真偽に', clean.body.generate_audio === true);
check('  整数は丸める', clean.body.seed === 13);
check('  固有項目は passthrough へ', clean.passthrough.watermark === false);
check('  宣言のない項目は転送しない', !('req_key' in clean.body) && !('evil' in clean.body));
check('  除外したものは申告する', clean.dropped.includes('evil') && clean.dropped.includes('req_key'), clean.dropped.join(','));

const clamp = sanitizeParams(imageFields(gptImage), { output_compression: 500 });
check('範囲外は上限で止める', clamp.body.output_compression === 100);
const raw = sanitizeParams(vf, { personGeneration: 'allow_adult', conditioningScale: 'abc' });
check('自由入力は文字列のまま', raw.passthrough.personGeneration === 'allow_adult');
check('数値欄に文字は入れない', !('conditioningScale' in raw.passthrough));

/* -------------------------------- speech --------------------------------- */
const gem = speechFields('google/gemini-3.8-flash-tts');
check('Gemini: 速さは出さない（無視されるため）', !gem.some((f) => f.key === 'speed'), keys(gem));
check('  読み方タグを出す', gem.some((f) => f.key === 'style_tags' && f.type === 'tags'));
check('  形式は pcm に固定', formatFor('google/gemini-3.8-flash-tts', 'mp3') === 'pcm');
const tagged = styledText('google/gemini-3.8-flash-tts', 'こんにちは', { style_tags: ['slowly', 'whispering'] });
check('  タグは [ ] で先頭に付く', tagged === '[slowly] [whispering] こんにちは', tagged);
check('  文章の指示にはしない', !/読んで/.test(tagged), '文章の指示は読み上げられてしまう');

const mm = speechFields('minimax/speech-2.8-turbo');
check('MiniMax: 速さを出す', mm.some((f) => f.key === 'speed' && f.min === 0.5 && f.max === 2), keys(mm));
check('  ピッチや感情は出さない（黙って捨てられるため）', !mm.some((f) => /pitch|emotion/.test(f.key)));
check('  任意のボイスIDも入れられる', mm.some((f) => f.key === 'voice_custom'));
check('  形式は mp3 に固定', formatFor('minimax/speech-2.8-turbo', 'pcm') === 'mp3');
check('  MiniMax にタグは付けない', styledText('minimax/speech-2.8-turbo', 'あ', { style_tags: ['slowly'] }) === 'あ');

const gpt = speechFields('openai/gpt-audio-mini');
check('GPT: 読み方を文章で指示できる', gpt.some((f) => f.key === 'instructions' && f.type === 'longtext'), keys(gpt));
check('  チャット経路で合成する', speechFamily('openai/gpt-audio-mini')?.route === 'chat');
check('  GPT にタグは付けない', styledText('openai/gpt-audio', 'あ', { style_tags: ['slowly'] }) === 'あ');

const fish = speechFields('fish-audio/s2.1-pro');
check('Fish: 速さと ( ) タグ', fish.some((f) => f.key === 'speed') && fish.some((f) => f.key === 'style_tags'), keys(fish));
check('  タグは ( ) で付く', styledText('fish-audio/s2.1-pro', 'あ', { style_tags: ['whispering'] }) === '(whispering) あ');

const qw = speechFields('qwen/qwen-audio-3.0-tts-flash');
check('Qwen: ボイスIDを手入力にする', qw.length === 1 && qw[0].key === 'voice_custom' && !qw[0].advanced, keys(qw));
check('xAI: 速さは出さない（無視されるため）', !speechFields('x-ai/grok-voice-tts-1.0').some((f) => f.key === 'speed'));
check('未知のモデルは何も出さない', speechFields('someone/new-tts').length === 0);

const st = sanitizeParams(gem, { style_tags: ['slowly', '[injected]]', ''], speed: 0.3 });
check('タグの括弧は除去する', JSON.stringify(st.speech.style_tags) === '["slowly","injected"]', JSON.stringify(st.speech.style_tags));
check('  Gemini に speed は通さない', !('speed' in st.speech) && st.dropped.includes('speed'));

/* -------------------------- GPT audio stream ----------------------------- */
const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const frames = [
  'data: ' + JSON.stringify({ choices: [{ delta: { audio: { data: b64([1, 2, 3, 4]), transcript: 'あ' } } }] }) + '\n',
  // A frame split across two network chunks.
  ('data: ' + JSON.stringify({ choices: [{ delta: { audio: { data: b64([5, 6]) } } }] })).slice(0, 20),
  JSON.stringify({ choices: [{ delta: { audio: { data: b64([5, 6]) } } }] }).slice(14) + '\n',
  'data: ' + JSON.stringify({ choices: [], usage: { cost: 0.0003 } }) + '\n',
  'data: [DONE]\n',
];
const stream = new ReadableStream({
  start(c) {
    for (const f of frames) c.enqueue(enc.encode(f));
    c.close();
  },
});
const got = await readAudioStream(stream);
check('音声ストリームを繋ぎ合わせる', got.audio.join(',') === '1,2,3,4,5,6', got.audio.join(','));
check('  チャンク境界で割れたフレームも読む', got.audio.length === 6);
check('  コストを拾う', got.usage?.cost === 0.0003);

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
