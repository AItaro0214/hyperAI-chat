/**
 * Groq does not publish a machine-readable pricing endpoint, so this table is
 * maintained by hand and can be overridden from the admin console
 * (Settings -> Groq 料金テーブル, stored in app_settings under "groq_pricing").
 *
 * Units:
 *   chat  -> USD per 1,000,000 tokens
 *   asr   -> USD per hour of audio
 *   tts   -> USD per 1,000,000 characters
 */
export const GROQ_PRICING = {
  as_of: '2026-09-06',
  source: 'https://groq.com/pricing',
  note: '手動メンテナンス。Groq は料金APIを公開していないため、公式ページで最新値を確認して管理コンソールから更新してください。',
  models: {
    'llama-3.1-8b-instant': { kind: 'chat', input: 0.05, output: 0.08 },
    'llama-3.3-70b-versatile': { kind: 'chat', input: 0.59, output: 0.79 },
    'openai/gpt-oss-20b': { kind: 'chat', input: 0.1, output: 0.5 },
    'openai/gpt-oss-120b': { kind: 'chat', input: 0.15, output: 0.75 },
    'openai/gpt-oss-safeguard-20b': { kind: 'chat', input: 0.1, output: 0.5 },
    'moonshotai/kimi-k2-instruct-0905': { kind: 'chat', input: 1.0, output: 3.0, cached_input: 0.5 },
    'qwen/qwen3-32b': { kind: 'chat', input: 0.29, output: 0.59 },
    'groq/compound': { kind: 'chat', input: 0.15, output: 0.75, note: '内部で使うモデルのトークン + 組み込みツール利用料' },
    'groq/compound-mini': { kind: 'chat', input: 0.1, output: 0.5, note: '内部で使うモデルのトークン + 組み込みツール利用料' },
    'meta-llama/llama-4-scout-17b-16e-instruct': { kind: 'chat', input: 0.11, output: 0.34, vision: true },
    'meta-llama/llama-4-maverick-17b-128e-instruct': { kind: 'chat', input: 0.2, output: 0.6, vision: true },
    'whisper-large-v3': { kind: 'asr', per_hour: 0.111 },
    'whisper-large-v3-turbo': { kind: 'asr', per_hour: 0.04 },
    'canopylabs/orpheus-v1-english': { kind: 'tts', per_million_chars: 22.0 },
    'canopylabs/orpheus-arabic-saudi': { kind: 'tts', per_million_chars: 40.0 },
    'playai-tts': { kind: 'tts', per_million_chars: 50.0, note: 'Orpheus に置き換えられました（提供状況は要確認）' },
  },
  tools: {
    browser_search: {
      label: 'Browser Search（gpt-oss 系の組み込みWeb検索）',
      price: '公式の Pricing ページを参照（検索回数課金）',
      note: 'tools:[{type:"browser_search"}] を付けると呼ばれます。トークン課金とは別建て。',
    },
    compound_builtin: {
      label: 'groq/compound の組み込みツール（Web検索・コード実行・サイト閲覧）',
      price: '公式の Pricing ページを参照',
      note: 'モデル自身が必要に応じて呼び出します。',
    },
  },
};

export const OPENROUTER_TOOL_PRICING = {
  as_of: '2026-09-06',
  source: 'https://openrouter.ai/docs/features/web-search',
  web_plugin_exa: {
    label: 'OpenRouter Web検索プラグイン（Exa）',
    price_per_request: 0.007,
    included_results: 10,
    price_per_extra_result: 0.001,
    note: 'plugins:[{id:"web"}] または モデルIDに :online を付けた場合。1リクエスト $0.007（10件まで込み・以降1件 $0.001）。',
  },
  web_native: {
    label: 'ネイティブWeb検索（モデル提供元の検索機能）',
    note: 'OpenAI / Anthropic / Google / Perplexity / xAI など提供元の従量課金がそのまま乗ります。モデル一覧の pricing.web_search に単価が入っている場合はその値を表示します。',
  },
};
