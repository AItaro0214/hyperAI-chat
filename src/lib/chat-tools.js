/* Letting a chat model decide when to search.
 *
 * OpenRouter's server tools already do this for OpenRouter models: the model
 * asks for a search when it wants one, and skips it for "こんにちは". A
 * self-hosted model has no such thing, and searching unconditionally is the
 * wrong trade — it spends a search and several thousand tokens of context on
 * every turn, including the ones that needed neither.
 *
 * So the tools are offered, and the model is asked once, without streaming,
 * whether it wants them. If it does, they run and it is asked again. Only when
 * it stops asking does the real streaming reply begin — which keeps the
 * streaming UX while making the search conditional.
 *
 * The tools here are read-only on purpose. Chat is not the agent: it can look
 * things up, and that is all. */

/* How many times the model may go back for more.
 *
 * Each round is a full round trip to the model plus a search, so this is tens
 * of seconds apiece on a self-hosted 27B. Two is enough for "look it up and
 * answer"; more is for questions that genuinely need following a trail. The
 * ceiling exists because a model that is not getting what it wants will ask
 * forever, and every attempt costs GPU time whether or not it helps. */
export const MAX_ROUNDS = 2;
export const ROUND_CEILING = 10;

/* A wall clock as well as a count: ten rounds of a slow model is minutes of
 * someone watching a spinner. */
const DEFAULT_BUDGET_MS = 240000;

const SEARCH_DESCRIPTION =
  '必要なときだけウェブを検索する。返るのは検索エンジンの生の結果（タイトル・URL・抜粋）で、要約ではない。' +
  '最新の出来事、変わりやすい事実、固有名詞の確認などに使う。' +
  '一般的な知識や、雑談、コードの書き方のような自分で答えられることには使わないこと。';

/**
 * The tools offered to a self-hosted model.
 *
 * With two or more engines to choose from, web_search takes an `engine`, and
 * what each is good at goes into the description — that is all the model has
 * to choose by. With one or none there is no choice to offer, so the argument
 * is left out rather than shown with a single value.
 *
 * @param {{engines?: string[], strengths?: Record<string,string>}} [options]
 */
export function chatTools({ engines = [], strengths = {} } = {}) {
  const properties = {
    query: { type: 'string', description: '検索語' },
    max_results: { type: 'integer', description: '最大件数。既定 5、上限 10' },
  };
  let description = SEARCH_DESCRIPTION;
  if (engines.length > 1) {
    const guide = engines.map((e) => e + ': ' + (strengths[e] || '')).join(' / ');
    properties.engine = {
      type: 'string',
      enum: engines,
      description: '使う検索エンジン。内容に合う方を選ぶ。' + guide,
    };
    description += ' 検索エンジンは engine で選べる（' + guide + '）。';
  }
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description,
        parameters: { type: 'object', properties, required: ['query'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '検索結果の中身を確かめる必要があるときだけ、そのページ本文を取得する。どの検索エンジンで見つけたページでも読める。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'http(s) の URL' } },
          required: ['url'],
        },
      },
    },
  ];
}

export const CHAT_TOOLS = chatTools();

/* ---------------------------- context budget ----------------------------
 * Every search adds its results to the conversation, and they are sent again
 * with every later round and with the reply. Ten searches came to 34,479
 * tokens against a 32,768 window: llama-server refused the request, the job
 * failed, and the reply was never written. So the tool phase keeps to a
 * budget, shrinking old results before it would run out.
 *
 * The same pessimistic ratio as estimateTokens in chat.js (not imported:
 * chat.js imports this module). Tool-call arguments count too. */
const CHARS_PER_TOKEN = 1.5;
const MIN_TOOL_CHARS = 400;

export function approxTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += 24;
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) chars += String(p?.text || '').length;
    for (const call of m.tool_calls || []) chars += String(call.function?.arguments || '').length + 40;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/* The reply's own cap (buildRequest's default max_tokens for breakthrough). */
const REPLY_TOKENS = 16384;

/**
 * The prompt a self-hosted model can take while still leaving the reply room
 * to be written: its window less the reply's cap, or a quarter of a small
 * window. An unknown window is taken to be the old 32K, the cautious guess.
 */
export function promptBudgetFor(context) {
  const ctx = Number(context) || 32768;
  return ctx - Math.min(REPLY_TOKENS, Math.floor(ctx / 4)) - 512;
}

/* One tool result, at most: a page read is up to 40,000 characters, and with
 * a 262K window there is room for it whole. The budget above still applies
 * across all of them. */
const TOOL_RESULT_CHARS = 40000;

/**
 * Cuts tool results down until the conversation fits `budget` tokens: the
 * longest result is halved first, so nothing is dropped outright while there
 * is any room. Returns how many cuts it made; the array is changed in place.
 */
export function shrinkToolResults(messages, budget) {
  let cuts = 0;
  while (approxTokens(messages) > budget) {
    let longest = null;
    for (const m of messages) {
      if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= MIN_TOOL_CHARS) continue;
      if (!longest || m.content.length > longest.content.length) longest = m;
    }
    if (!longest) break;
    const keep = Math.max(MIN_TOOL_CHARS, Math.floor(longest.content.length / 2));
    longest.content = longest.content.slice(0, keep) + '\n…（会話の長さの上限のため、以降を省略しました）';
    cuts++;
  }
  return cuts;
}

/* The useful part of an error body: RunPod and llama-server nest the message
 * in JSON, sometimes JSON inside a string. */
export function errorText(raw) {
  let text = String(raw || '');
  for (let i = 0; i < 3; i++) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      break;
    }
    const next = typeof parsed === 'string' ? parsed : parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? null;
    if (next === null || next === undefined) break;
    text = typeof next === 'string' ? next : JSON.stringify(next);
  }
  return text.slice(0, 300);
}

/** Reasoning depth, as the one control a self-hosted Qwen actually has. */
export function thinkingFor(effort) {
  // Seven levels upstream, a switch here; treating "off"/"none"/"minimal" as
  // off is closer to the intent than pretending the granularity exists.
  if (!effort || effort === '') return null;
  return !['off', 'none', 'minimal'].includes(String(effort).toLowerCase());
}

/**
 * Runs the tool phase and returns the messages to send for the real reply.
 *
 * @param {object} config
 * @param {(name: string, args: object) => Promise<string>} config.execute
 * @param {(phase: string, detail?: object) => Promise<void>|void} [config.onPhase]
 * @param {(json: object) => Promise<void>|void} [config.onReply] each decision's raw response
 * @param {number} [config.promptBudget] tokens the conversation may use; unset = unbounded
 * @returns {Promise<{messages: object[], calls: string[], rounds: number}>}
 */
export async function resolveTools({
  url,
  headers,
  body,
  execute,
  onPhase,
  onReply,
  tools = CHAT_TOOLS,
  maxRounds = MAX_ROUNDS,
  timeoutMs = 900000,
  budgetMs = DEFAULT_BUDGET_MS,
  promptBudget = 0,
  // A self-hosted model's decisions go through RunPod jobs (runpodChatFetch).
  fetchImpl = fetch,
}) {
  const messages = body.messages.slice();
  const calls = [];
  const asked = new Set();
  const limit = Math.max(1, Math.min(Number(maxRounds) || MAX_ROUNDS, ROUND_CEILING));
  /* The clock starts when the model first answers. The first decision is
   * usually what wakes a cold worker, and the queue and the startup before
   * it — minutes, sometimes tens of them — are not searching. */
  let started = null;
  let rounds = 0;
  let stoppedBecause = null;

  // Each decision asks for up to 700 tokens on top of its prompt.
  const roundBudget = promptBudget > 0 ? Math.max(1000, promptBudget - 700) : 0;

  for (rounds = 1; rounds <= limit; rounds++) {
    if (started !== null && Date.now() - started > budgetMs) {
      stoppedBecause = '時間切れ';
      break;
    }
    /* Out of room: shrink what is there, and if even that is not enough
     * there is no space for another search's results anyway. */
    if (roundBudget && approxTokens(messages) > roundBudget) {
      shrinkToolResults(messages, roundBudget);
      if (approxTokens(messages) > roundBudget * 0.85) {
        stoppedBecause = '会話の長さの上限';
        break;
      }
    }
    await onPhase?.('deciding', { round: rounds, of: limit });
    const probe = {
      ...body,
      messages,
      tools,
      tool_choice: 'auto',
      stream: false,
      /* "Do I need to search?" is a routing decision, not a reasoning task.
       *
       * Spreading the caller's body carried its thinking setting in, and Qwen
       * thinks by default — so the budget below was spent entirely on an
       * internal monologue and the turn ended before any tool call was
       * emitted. Three rounds of that is a minute of nothing. Thinking is
       * switched off here regardless of what the answer itself will use. */
      chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false },
      // Enough for a tool call and its arguments, and no more.
      max_tokens: 700,
    };

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(probe),
      // A cold GPU answers the first request in minutes, not seconds.
      signal: AbortSignal.timeout(timeoutMs),
    });
    /* A failure here is not fatal: fall through and answer with what there
     * is. But it says why — "HTTP 400" alone was all there was to go on when
     * the reason was a context overflow. */
    if (!res.ok) {
      const detail = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      return { messages, calls, rounds: rounds - 1, failed: 'HTTP ' + res.status + (detail ? ': ' + errorText(detail) : '') };
    }

    const json = await res.json().catch(() => null);
    if (started === null) started = Date.now();
    if (json) await onReply?.(json);
    const message = json?.choices?.[0]?.message;
    const wanted = message?.tool_calls || [];
    if (!wanted.length) return { messages, calls, rounds: rounds - 1 };

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: wanted });

    for (const call of wanted) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      calls.push(name);

      /* The same query twice means it is not going to get anywhere.
       *
       * This is what an unbounded loop actually looks like in practice: not
       * novel searches forever, but the identical one repeated because the
       * results did not answer the question. Saying so is more useful than
       * running it again. */
      const signature = name + ':' + JSON.stringify(args);
      if (asked.has(signature)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'この検索は既に実行済みで、結果は上にあります。同じ検索を繰り返さず、得られた情報で回答してください。',
        });
        stoppedBecause = '同じ検索の繰り返し';
        continue;
      }
      asked.add(signature);
      await onPhase?.('tool', { name, args });

      let text;
      try {
        text = await execute(name, args);
      } catch (e) {
        text = 'エラー: ' + String(e?.message || e).slice(0, 400);
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: String(text ?? '').slice(0, TOOL_RESULT_CHARS),
      });
    }

    if (stoppedBecause) break;
  }

  /* Out of rounds, and the model does not know that.
   *
   * Left to itself it asks for another tool on the final turn — but that turn
   * offers none, and vLLM's tool parser is enabled endpoint-wide, so the call
   * it writes is stripped out and the reply arrives with content: null and
   * nothing else. Ninety-three tokens generated and thrown away. Saying the
   * search is over is what stops it reaching for one. */
  messages.push({
    role: 'user',
    content: 'これ以上は検索できません。ここまでに得られた情報だけで回答してください。分からない部分は分からないと述べてください。',
  });
  return { messages, calls, rounds: Math.min(rounds, limit), exhausted: true, stoppedBecause };
}
