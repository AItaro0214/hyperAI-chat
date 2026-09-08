import { collectImages } from '../src/lib/chat.js';
const results = [];
const check = (n, ok, extra='') => { results.push([ok,n,extra]); console.log((ok?'PASS':'FAIL')+' - '+n+(extra?' :: '+extra:'')); };
const urls = c => collectImages(c).map(i => i.image_url.url);

check('delta.images を拾う', urls({ delta: { images: [{ type:'image_url', image_url:{ url:'data:image/png;base64,AAA' } }] } })[0] === 'data:image/png;base64,AAA');
check('delta.attachments も拾う', urls({ delta: { attachments: [{ image_url:{ url:'data:image/webp;base64,BBB' } }] } })[0] === 'data:image/webp;base64,BBB');
check('message.images も拾う', urls({ message: { images: [{ image_url:{ url:'https://cdn.example.com/a.png' } }] } })[0] === 'https://cdn.example.com/a.png');
check('b64_json 形式も拾う', urls({ delta: { images: [{ b64_json: 'CCC' }] } })[0] === 'data:image/png;base64,CCC');
check('生の data URL 文字列も拾う', urls({ delta: { images: ['data:image/jpeg;base64,DDD'] } })[0] === 'data:image/jpeg;base64,DDD');
check('未知のキーでも走査で見つける', urls({ delta: { tool_result: { output: { file: { image_url: { url: 'data:image/png;base64,EEE' } } } } } })[0] === 'data:image/png;base64,EEE');
check('本文の URL は拾わない', urls({ delta: { content: 'https://example.com/a.png を見て' } }).length === 0);
check('推論テキストも拾わない', urls({ delta: { reasoning: 'data:image/png;base64,XXX' } }).length === 0);
check('画像が無ければ空', urls({ delta: { content: 'こんにちは' } }).length === 0);
check('最大 8 枚で打ち切る', collectImages({ delta: { images: Array.from({length: 20}, () => ({ image_url: { url: 'data:image/png;base64,A' } })) } }).length <= 9);

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
