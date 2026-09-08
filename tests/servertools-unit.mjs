import { buildRequest } from '../src/lib/chat.js';
const results = [];
const check = (n, ok, extra='') => { results.push([ok,n,extra]); console.log((ok?'PASS':'FAIL')+' - '+n+(extra?' :: '+extra:'')); };
const base = { provider:'openrouter', model:'openai/gpt-6-astra', messages:[], apiKey:'k', stream:false,
  modelMeta:{ output:['text'], reasoning:true, input:['text'] } };
const types = b => (b.tools||[]).map(t=>t.type);

// default: hand the model the server tools and let it decide
let r = buildRequest({ ...base, options:{ webSearchEngine:'server', imageMode:'off' } });
check('検索=自動 で server tools を渡す', types(r.body).includes('openrouter:web_search'), types(r.body).join(','));
check('  web_fetch も付く', types(r.body).includes('openrouter:web_fetch'));
check('  datetime も付く', types(r.body).includes('openrouter:datetime'));
check('  plugins は使わない', !r.body.plugins);
check('  通知でモードが分かる', r.notices.some(n=>n.includes('モデルの判断')), r.notices.join(' / '));

// forced modes still work
r = buildRequest({ ...base, options:{ webSearchEngine:'exa', imageMode:'off', webSearchMaxResults:5 } });
check('検索=exa は毎回検索（plugins）', r.body.plugins?.[0]?.engine === 'exa' && !r.body.tools, JSON.stringify(r.body.plugins));
r = buildRequest({ ...base, options:{ webSearchEngine:'native', imageMode:'off' } });
check('検索=native は plugins（max_results なし）', r.body.plugins?.[0]?.engine === 'native' && r.body.plugins[0].max_results === undefined);

// image generation
r = buildRequest({ ...base, options:{ imageMode:'server', webSearchEngine:'off' } });
check('画像=自動 で image_generation を渡す', types(r.body).includes('openrouter:image_generation'), types(r.body).join(','));
check('  テキスト専用モデルでも渡せる', !r.body.modalities);
r = buildRequest({ ...base, options:{ imageMode:'force', webSearchEngine:'off' } });
check('画像=強制 は非対応モデルだと無視して通知', !r.body.modalities && r.notices.some(n=>n.includes('対応していない')), r.notices.join(' / '));
r = buildRequest({ ...base, modelMeta:{ output:['text','image'] }, options:{ imageMode:'force', webSearchEngine:'off' } });
check('  対応モデルなら modalities を送る', JSON.stringify(r.body.modalities) === '["image","text"]');

// combined
r = buildRequest({ ...base, options:{} });
check('検索＋画像を同時に渡せる', ['openrouter:web_search','openrouter:image_generation','openrouter:datetime'].every(t=>types(r.body).includes(t)), types(r.body).join(','));

// explicit off
r = buildRequest({ ...base, options:{ webSearchEngine:'off', imageMode:'off' } });
check('モードが off なら何も送らない', !r.body.tools && !r.body.plugins);
r = buildRequest({ ...base, options:{} });
check('モード未指定は自動（既定でツールを渡す）', types(r.body).includes('openrouter:web_search') && types(r.body).includes('openrouter:image_generation'), types(r.body).join(','));
r = buildRequest({ ...base, options:{ imageMode:'off' } });
check('画像だけ off にできる', types(r.body).includes('openrouter:web_search') && !types(r.body).includes('openrouter:image_generation'), types(r.body).join(','));

// groq is untouched by server tools
r = buildRequest({ provider:'groq', model:'openai/gpt-oss-120b', messages:[], apiKey:'k', stream:false,
  modelMeta:{ browserSearch:true, reasoning:true }, options:{ webSearch:true } });
check('Groq は従来どおり browser_search', types(r.body).includes('browser_search') && !types(r.body).some(t=>String(t).startsWith('openrouter:')), types(r.body).join(','));

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
