import { clampEffort, EFFORT_LEVELS } from '../src/lib/chat.js';
const results = [];
const check = (n, ok, extra='') => { results.push([ok,n,extra]); console.log((ok?'PASS':'FAIL')+' - '+n+(extra?' :: '+extra:'')); };

check('7段階を定義', EFFORT_LEVELS.length === 7 && EFFORT_LEVELS.includes('xhigh') && EFFORT_LEVELS.includes('max'), EFFORT_LEVELS.join(','));

// OpenAI / Grok: pass through untouched
for (const lv of EFFORT_LEVELS) {
  const r = clampEffort('openrouter', 'openai/gpt-6-astra', lv);
  if (r.effort !== lv) { check('GPT-6 Astra は ' + lv + ' をそのまま送る', false, r.effort); break; }
}
check('GPT-6 Astra は7段階すべてそのまま', EFFORT_LEVELS.every(lv => clampEffort('openrouter','openai/gpt-6-astra',lv).effort === lv));

// Claude: none is rejected upstream, so it is downgraded
check('Claude Fable は xhigh をそのまま送る', clampEffort('openrouter','anthropic/claude-fable-5.1','xhigh').effort === 'xhigh');
check('Claude Fable は max をそのまま送る', clampEffort('openrouter','anthropic/claude-fable-5.1','max').effort === 'max');
const none = clampEffort('openrouter','anthropic/claude-fable-5.1','none');
check('Claude の none は minimal に調整', none.effort === 'minimal' && !!none.notice, none.notice || '');

// Gemini: OpenRouter maps xhigh down itself, so we forward as-is
check('Gemini は xhigh をそのまま送る（上流で丸められる）', clampEffort('openrouter','google/gemini-3.8-flash','xhigh').effort === 'xhigh');

// Groq only knows three levels
check('Groq: max → high', clampEffort('groq','openai/gpt-oss-120b','max').effort === 'high');
check('Groq: xhigh → high', clampEffort('groq','openai/gpt-oss-120b','xhigh').effort === 'high');
check('Groq: minimal → low', clampEffort('groq','openai/gpt-oss-120b','minimal').effort === 'low');
check('Groq: none → low', clampEffort('groq','openai/gpt-oss-120b','none').effort === 'low');
check('Groq: high はそのまま（通知なし）', clampEffort('groq','openai/gpt-oss-120b','high').effort === 'high' && !clampEffort('groq','openai/gpt-oss-120b','high').notice);
check('Groq: 調整時は理由を返す', !!clampEffort('groq','openai/gpt-oss-120b','max').notice, clampEffort('groq','openai/gpt-oss-120b','max').notice);

check('未指定は何も送らない', clampEffort('openrouter','openai/gpt-6-astra','').effort === null);
check('未知の値も送らない', clampEffort('openrouter','openai/gpt-6-astra','ultra').effort === null);

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
