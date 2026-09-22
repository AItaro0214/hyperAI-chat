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

export const MAX_ROUNDS = 3;

export const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '必要なときだけウェブを検索する。返るのは検索エンジンの生の結果（タイトル・URL・抜粋）で、要約ではない。' +
        '最新の出来事、変わりやすい事実、固有名詞の確認などに使う。' +
        '一般的な知識や、雑談、コードの書き方のような自分で答えられることには使わないこと。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索語' },
          max_results: { type: 'integer', description: '最大件数。既定 5、上限 10' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '検索結果の中身を確かめる必要があるときだけ、そのページ本文を取得する。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) の URL' } },
        required: ['url'],
      },
    },
  },
];

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
 * @returns {Promise<{messages: object[], calls: string[], rounds: number}>}
 */
export async function resolveTools({ url, headers, body, execute, onPhase, maxRounds = MAX_ROUNDS, timeoutMs = 900000 }) {
  const messages = body.messages.slice();
  const calls = [];
  let rounds = 0;

  for (rounds = 1; rounds <= maxRounds; rounds++) {
    const probe = {
      ...body,
      messages,
      tools: CHAT_TOOLS,
      tool_choice: 'auto',
      stream: false,
      // The decision needs a few tokens, not an essay; the answer comes later.
      max_tokens: 512,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(probe),
      // A cold GPU answers the first request in minutes, not seconds.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A model or endpoint that cannot do tools should still be able to answer,
    // so a failure here is not fatal: fall through with what we have.
    if (!res.ok) return { messages, calls, rounds: rounds - 1, failed: 'HTTP ' + res.status };

    const json = await res.json().catch(() => null);
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
        content: String(text ?? '').slice(0, 20000),
      });
    }
  }

  return { messages, calls, rounds: maxRounds, exhausted: true };
}
