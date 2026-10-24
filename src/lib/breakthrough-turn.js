/* One breakthrough turn — search decisions, searches, the reply — run to the
 * end whether or not anyone is watching.
 *
 * It used to run inside the chat request, and a Worker lasts about 30 seconds
 * after the browser goes: a phone screen turning off was enough to cut a turn
 * off mid-search. So it runs here, as a Cloudflare Workflow (BreakthroughWorkflow)
 * when that binding exists, and inline otherwise.
 *
 * Every stage is a step: each decision is submitted in one step and awaited
 * in the next, each search is a step, and so are the reply's submission, its
 * following, and the final save. A Workflow that is evicted and run again
 * returns the stored result of each finished step instead of doing it again,
 * so no decision, search or reply is ever sent twice.
 *
 * What it is doing is written to the message row as it goes — the phase and
 * notice in meta.progress, the reply's text in content — and the chat route
 * reads that back out as the same SSE the page always had. A page that comes
 * back later reads the same row. */

import { now } from './auth.js';
import { getApiKey, logUsage } from './store.js';
import { JOB_WAIT_MS, describeStartup } from './runpod.js';
import { submitChatJob, waitForJob, followReply, webhookUrl, queueNotice, noteAppJob } from './runpod-jobs.js';
import { resolveTools, chatTools, promptBudgetFor, shrinkToolResults } from './chat-tools.js';
import { webSearch, webFetch, formatResults, availableEngines, searchRecord, ENGINE_STRENGTHS, CHOOSE } from './search.js';
import { isContextError } from './chat.js';

/* ------------------------------ the turn's input ---------------------------
 * The built request can be most of a 262K window — too large for a
 * Workflow's parameters — so it waits in KV, keyed by the reply's message id. */
const TURN_KEY = (messageId) => 'bt-turn:' + messageId;

export async function saveTurn(env, turn) {
  await env.KV.put(TURN_KEY(turn.messageId), JSON.stringify(turn), { expirationTtl: 2 * 86400 });
}

export async function loadTurn(env, messageId) {
  const raw = await env.KV.get(TURN_KEY(messageId));
  return raw ? JSON.parse(raw) : null;
}

/* Steps for when there is no Workflow: run straight through. */
export const inlineStep = {
  do: async (_name, configOrFn, maybeFn) => (typeof configOrFn === 'function' ? configOrFn() : maybeFn()),
};

const QUICK = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '5 minutes' };
// Waiting on RunPod: the queue and a cold start can take most of two hours.
const LONG = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '150 minutes' };

const MAX_META_BYTES = 16000;

/* The page's own phase names (PHASES in app.js), for each stage here. */
export const PAGE_PHASE = { deciding: 'searching', searching: 'searching', waiting: 'connecting', writing: 'writing' };

/**
 * Runs the turn whose input saveTurn stored under messageId.
 * @param {{env: object, messageId: string, step?: object}} o  step: a Workflow's, or inlineStep
 */
export async function runTurn({ env, messageId, step = inlineStep }) {
  /* Read outside any step: a step's result is limited to 1 MiB, and the
   * request can be larger. It stays in KV until the save step has run. */
  const turn = await loadTurn(env, messageId);
  if (!turn) return { state: 'missing' };
  const ep = turn.endpointId;
  const apiKey = await getApiKey(env, 'RUNPOD_API_KEY');
  const deadline = turn.startedAt * 1000 + JOB_WAIT_MS;
  const body = { ...turn.body };

  /* -------------------------- what the row says -------------------------- */
  const st = {
    content: '',
    reasoning: '',
    notices: [...(turn.notices || [])],
    searches: [],
    decisionJobs: [],
    startup: null,
    runpodJob: null,
    progress: { phase: 'waiting', text: '準備しています' },
    usage: null,
    error: null,
  };
  const meta = (final) => {
    const m = {
      ...(turn.metaBase || {}),
      notices: st.notices,
      partial: !final,
      elapsed: now() - turn.startedAt,
      ...(st.startup ? { startup: st.startup } : {}),
      ...(st.searches.length ? { searches: st.searches.slice(0, 24) } : {}),
      ...(st.decisionJobs.length ? { decisionJobs: st.decisionJobs.slice(0, 20) } : {}),
      ...(st.runpodJob ? { runpodJob: st.runpodJob } : {}),
      ...(!final && st.progress ? { progress: st.progress } : {}),
      ...(turn.workflowId ? { workflow: turn.workflowId } : {}),
      tools: [],
    };
    let json = JSON.stringify(m);
    if (json.length > MAX_META_BYTES) json = JSON.stringify({ ...m, searches: (m.searches || []).slice(0, 6) });
    return json;
  };
  const write = async (final = false) => {
    await env.DB.prepare(
      'UPDATE messages SET content = ?, reasoning = ?, prompt_tokens = ?, completion_tokens = ?, meta = ?, error = ? WHERE id = ?'
    )
      .bind(
        st.content,
        st.reasoning ? st.reasoning.slice(0, 60000) : null,
        st.usage?.prompt_tokens ?? null,
        st.usage?.completion_tokens ?? null,
        meta(final),
        st.error,
        messageId
      )
      .run()
      .catch((e) => console.error('breakthrough write failed', e));
  };
  let lastProgressWrite = 0;
  let lastPhase = null;
  const progress = async (phase, text, { force = false } = {}) => {
    st.progress = { phase, text, at: Date.now() };
    /* A new stage is written at once; within one, the text every two
     * seconds and the waiting clock every ten — an hour in the queue is
     * not worth a write a second. */
    const every = phase === 'writing' ? 2000 : 10000;
    if (!force && phase === lastPhase && Date.now() - lastProgressWrite < every) return;
    lastProgressWrite = Date.now();
    lastPhase = phase;
    await write(false);
  };
  const noteStartup = (worker) => {
    if (st.startup || !worker) return;
    st.startup = describeStartup(worker, turn.startedAt);
  };

  try {
    /* --------------------------- search decisions --------------------------- */
    if (turn.webSearch) {
      await progress('deciding', '検索が必要か判断しています', { force: true });
      const searchMode = turn.searchMode || 'ollama';
      const engines = searchMode === CHOOSE ? await step.do('engines', QUICK, () => availableEngines(env).catch(() => [])) : [];
      const promptBudget = promptBudgetFor(turn.contextTokens);

      let decisionN = 0;
      let toolN = 0;
      const phase = await resolveTools({
        url: 'runpod://decision',
        headers: {},
        body,
        tools: chatTools({ engines, strengths: ENGINE_STRENGTHS }),
        maxRounds: turn.searchRounds || 2,
        promptBudget,
        /* Each decision: submitted in one step, awaited in the next. Run
         * again, the first returns the same job id instead of a new job. */
        fetchImpl: async (_url, init) => {
          const n = ++decisionN;
          const jobId = await step.do('decision ' + n + ': submit', QUICK, async () => {
            const id = await submitChatJob(apiKey, ep, JSON.parse(init.body));
            await noteAppJob(env, id).catch(() => {});
            return id;
          });
          if (!st.decisionJobs.includes(jobId)) st.decisionJobs.push(jobId);
          const out = await step.do('decision ' + n + ': result', LONG, () =>
            waitForJob(apiKey, ep, jobId, {
              deadline,
              onStatus: (s) => (s.status === 'COMPLETED' ? null : progress('waiting', queueNotice({ status: s.status, waitedMs: Date.now() - turn.startedAt * 1000 }))),
            })
          );
          return new Response(JSON.stringify(out.body), { status: out.httpStatus, headers: { 'content-type': 'application/json' } });
        },
        onReply: (json) => noteStartup(json?.hyperai_worker),
        onPhase: (kind, detail) =>
          kind === 'deciding'
            ? progress('deciding', '検索が必要か判断しています（' + detail.round + '/' + detail.of + '）', { force: true })
            : progress('searching', '検索: ' + String(detail?.args?.query || detail?.args?.url || '').slice(0, 80), { force: true }),
        // Each search or page read: a step, so it is never run twice.
        execute: async (name, args) => {
          const n = ++toolN;
          const done = await step.do('tool ' + n + ': ' + name, QUICK, () => runTool(env, name, args, searchMode, turn));
          st.searches.push(done.record);
          if (done.notice) await progress('searching', done.notice, { force: true });
          return done.text;
        },
      });
      body.messages = phase.messages;
      if (shrinkToolResults(body.messages, promptBudget)) st.notices.push('検索結果が長いため、一部を省略して回答します');
      if (phase.calls.length) st.notices.push('ウェブを ' + phase.calls.length + ' 回調べました');
      if (phase.stoppedBecause) st.notices.push('検索を打ち切りました（' + phase.stoppedBecause + '）');
      if (phase.failed) {
        st.notices.push(
          (phase.calls.length ? '検索の途中で' : '検索するかの判断で') + 'モデルがエラーを返しました（' + phase.failed + '）。ここまでの情報で回答します'
        );
      }
    }

    /* ------------------------------- the reply ------------------------------ */
    const webhook = await webhookUrl(env, messageId);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const sub = await step.do('reply ' + attempt + ': submit', QUICK, async () => ({
        jobId: await submitChatJob(apiKey, ep, body, { webhook }),
        submittedAt: Date.now(),
      }));
      st.runpodJob = { id: sub.jobId, endpointId: ep, submittedAt: sub.submittedAt, status: 'IN_QUEUE' };
      await progress('waiting', 'RunPod に回答を依頼しました', { force: true });

      const result = await step.do('reply ' + attempt + ': follow', LONG, async () =>
        capResult(await followReply(apiKey, ep, sub.jobId, {
          deadline,
          onProgress: async (p) => {
            st.runpodJob.status = p.status;
            noteStartup(p.worker);
            if (p.text || p.reasoning) {
              st.content = p.text;
              st.reasoning = p.reasoning;
              await progress('writing', '回答を書いています');
            } else if (p.status === 'IN_QUEUE' || p.status === 'IN_PROGRESS') {
              await progress('waiting', queueNotice({ status: p.status, waitedMs: Date.now() - sub.submittedAt }));
            }
          },
        }))
      );
      st.runpodJob.status = result.status;
      noteStartup(result.worker);

      if (result.status === 'COMPLETED') {
        st.content = result.text || '';
        st.reasoning = result.reasoning || '';
        st.usage = result.usage || null;
        st.error = null;
        break;
      }
      /* Over the window: one retry with the older half dropped, starting at a
       * user turn so no tool result is left without its call. */
      if (attempt === 1 && isContextError(result.error)) {
        const system = body.messages.filter((m) => m.role === 'system').slice(0, 1);
        const rest = body.messages.filter((m) => m.role !== 'system');
        let kept = rest.length > 1 ? rest.slice(Math.ceil(rest.length / 2)) : rest;
        const firstUser = kept.findIndex((m) => m.role === 'user');
        if (firstUser > 0) kept = kept.slice(firstUser);
        body.messages = [...system, ...(kept.length ? kept : rest.slice(-1))];
        st.notices.push('コンテキスト超過のため、古い ' + (rest.length - kept.length) + ' 件を除いて再実行しました');
        continue;
      }
      if (result.text) st.content = result.text;
      st.error = 'RunPod のジョブが終了しました（' + result.status + '）: ' + String(result.error || '').slice(0, 600);
      break;
    }
  } catch (e) {
    st.error = 'ブレイクスルーの処理が止まりました: ' + String(e?.message || e).slice(0, 600);
  }

  /* -------------------------------- the end -------------------------------- */
  await step.do('save', QUICK, async () => {
    await write(true);
    await logUsage(env, {
      userId: turn.userId,
      roomId: turn.roomId,
      provider: 'runpod',
      model: turn.model || 'breakthrough',
      kind: 'chat',
      promptTokens: st.usage?.prompt_tokens ?? null,
      completionTokens: st.usage?.completion_tokens ?? null,
      cost: null,
    }).catch(() => {});
    await env.KV.delete(TURN_KEY(messageId)).catch(() => {});
    return true;
  });
  return { state: st.error ? 'failed' : 'done', error: st.error };
}

/* A step's result is kept, and limited to 1 MiB: the reasoning is cut to
 * what the row keeps anyway, and the text well short of the limit. */
function capResult(r) {
  return { ...r, text: r.text ? r.text.slice(0, 700000) : r.text, reasoning: r.reasoning ? r.reasoning.slice(0, 60000) : r.reasoning };
}

/* One search or page read: the text for the model, the record for the
 * reply, and a notice for the page. */
async function runTool(env, name, args, searchMode, turn) {
  if (name === 'web_search') {
    try {
      const found = await webSearch(env, {
        query: args.query,
        maxResults: args.max_results || turn.webSearchMaxResults || 5,
        backend: searchMode,
        engine: args.engine,
      });
      return {
        text: formatResults(found),
        record: searchRecord({ kind: 'search', found, args }),
        notice:
          '検索（' + found.backend + (found.mode === CHOOSE ? '・モデルが選択' : '') + '）: ' +
          found.results.length + '件 — ' + String(args.query).slice(0, 60),
      };
    } catch (err) {
      const why = '検索に失敗しました（' + searchMode + '）: ' + String(err.message).slice(0, 200);
      return {
        text: why + ' 検索結果は得られませんでした。分かる範囲で答えるか、分からないと伝えてください。',
        record: searchRecord({ kind: 'search', args, mode: searchMode, error: err.message }),
        notice: why,
      };
    }
  }
  if (name === 'web_fetch') {
    try {
      const page = await webFetch(env, { url: args.url, backend: searchMode });
      return {
        text: [page.title, page.url, '', page.content].join('\n'),
        record: searchRecord({ kind: 'fetch', page, args }),
        notice: 'ページを読んでいます: ' + String(page.url).slice(0, 80),
      };
    } catch (err) {
      const why = 'ページを取得できませんでした: ' + String(err.message).slice(0, 200);
      return { text: why, record: searchRecord({ kind: 'fetch', args, error: err.message }), notice: why };
    }
  }
  return { text: '未知のツールです: ' + name, record: { kind: 'search', engine: null, query: name, count: 0, error: 'unknown tool' }, notice: null };
}
