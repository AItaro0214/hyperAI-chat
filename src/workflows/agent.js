/* The agent loop as a Workflow.
 *
 * A Worker request only survives ~30 seconds past a client disconnect, which
 * would cut a build off the moment the browser closed. A Workflow has no
 * wall-clock limit per step and keeps running on its own, so the run continues
 * and the panel simply re-attaches to the stored progress when reopened. */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { getSettings, logUsage } from '../lib/store.js';
import { getCatalog, findModel, turnCost } from '../lib/models.js';
import { requireKey } from '../lib/chat.js';
import { callProvider } from '../lib/agent-loop.js';
import { listFiles, sandboxFor } from '../lib/sandbox.js';
import { snapshotWorkspace, restoreWorkspace } from '../lib/workspace-store.js';
import { loadRules, rulesBlock } from '../lib/agent-rules.js';
import { skillIndex } from '../lib/skills.js';
import { TOOLS, SYSTEM_PROMPT, MAX_STEPS, parseArgs, toolResultMessage } from '../lib/agent.js';
import { loadAgentHistory, HISTORY_NOTE, DEFAULT_HISTORY_CHARS } from '../lib/agent-history.js';
import { runTool } from '../lib/agent-tools.js';

/** Appends one progress event; the SSE route replays these to the panel. */
async function record(env, runId, seq, kind, payload) {
  await env.DB.prepare('INSERT OR REPLACE INTO agent_events (run_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)')
    .bind(runId, seq, kind, JSON.stringify(payload).slice(0, 60000), now())
    .run();
}

export class AgentWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const { runId, userId, roomId, task, taskMessageId, provider, model, systemExtra, imageModel } = event.payload;

    const state = { touched: new Set(), preview: null };

    // The workspace comes back on its own, but the reasoning behind it does not.
    // Carrying the room's recent turns is what stops the agent re-deciding
    // things it already decided and retrying what it already found broken.
    const settings = await getSettings(env);
    const history = await loadAgentHistory(env, roomId, {
      excludeId: taskMessageId,
      maxChars: Number(settings.agentHistoryChars ?? DEFAULT_HISTORY_CHARS),
    });

    const messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT + (systemExtra ? '\n\n' + systemExtra : '') + (history.length ? HISTORY_NOTE : ''),
      },
      ...history,
      { role: 'user', content: task },
    ];
    const shots = [];
    let seq = 0;
    let cost = 0;
    let finalText = '';
    let steps = 0;
    let stopped = false;

    const emit = async (kind, payload) => {
      seq += 1;
      await record(env, runId, seq, kind, payload);
    };

    const apiKey = await requireKey(env, provider);
    const modelMeta = findModel(await getCatalog(env).catch(() => ({ models: [] })), provider + ':' + model);

    // The container may have slept since the last run and come up with a fresh
    // disk, so the workspace is put back before any tool touches it.
    // Restoring must never be able to strand the run: it is bounded, retried
    // once, and a failure just means starting from an empty workspace.
    await step
      .do(
        'restore workspace',
        { retries: { limit: 1, delay: '5 seconds' }, timeout: '5 minutes' },
        async () => {
          const out = await restoreWorkspace(env, roomId, sandboxFor(env, roomId));
          if (out.restored) await record(env, runId, ++seq, 'restored', { files: out.files, kind: out.kind });
          return out;
        }
      )
      .catch(async (e) => {
        await record(env, runId, ++seq, 'warn', {
          message: '前回の作業を復元できませんでした: ' + String(e?.message || e).slice(0, 200),
        });
        return { restored: false };
      });

    // Project rules are read after the restore, so an edited file takes effect
    // on the very next run.
    const rules = await loadRules(sandboxFor(env, roomId)).catch(() => null);
    if (rules) {
      messages[0].content += rulesBlock(rules);
      await emit('rules', { name: rules.name, chars: rules.text.length });
    }

    // Only the index rides in the prompt; load_skill fetches the rest, so the
    // model catalogues cost nothing on a job that never touches media.
    messages[0].content += skillIndex();

    try {
      for (steps = 1; steps <= MAX_STEPS; steps++) {
        await emit('step', { step: steps, of: MAX_STEPS });
        await env.DB.prepare('UPDATE agent_runs SET steps = ?, updated_at = ? WHERE id = ?')
          .bind(steps, now(), runId)
          .run();

        // Each provider turn is its own step so a transient failure is retried
        // rather than losing the whole run.
        const reply = await step.do(
          'model turn ' + steps,
          { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '6 minutes' },
          () => callProvider(provider, model, messages, apiKey, { temperature: settings.temperature })
        );

        const message = reply?.choices?.[0]?.message || {};
        // Groq returns no usage.cost, so the turn is priced from its tokens.
        cost += turnCost(modelMeta, reply?.usage);
        const calls = message.tool_calls || [];

        if (message.content) {
          finalText = message.content;
          await emit('text', { text: message.content });
        }
        if (!calls.length) break;

        messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });

        for (const call of calls) {
          const args = parseArgs(call.function?.arguments);
          await emit('tool', { name: call.function?.name, args, step: steps });

          let result;
          try {
            // Tool output is recorded as it streams so the panel can follow a
            // long install even after a reconnect.
            result = await runTool(
              env,
              roomId,
              call.function?.name,
              args,
              state,
              (stream, data) => {
                seq += 1;
                return record(env, runId, seq, 'output', { stream, data: String(data).slice(0, 4000) }).catch(() => {});
              },
              {
                imageModel,
                provider,
                model,
                temperature: settings.temperature,
                rules: rules ? rulesBlock(rules) : '',
                // Sub-agent activity is surfaced in the same stream, marked.
                onSubEvent: (kind, payload) => {
                  seq += 1;
                  return record(env, runId, seq, 'sub-' + kind, payload).catch(() => {});
                },
              }
            );
          } catch (e) {
            result = { text: 'エラー: ' + String(e?.message || e).slice(0, 800) };
          }

          if (result.image) {
            const id = newId('file');
            await env.KV.put('file:' + id, result.image.bytes, {
              metadata: { mime: result.image.mime, name: 'screenshot.png', at: now() },
            });
            await env.DB.prepare(
              'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )
              .bind(id, userId, roomId, 'image', result.image.mime, 'screenshot.png', result.image.bytes.length, now())
              .run();
            const url = '/api/files/' + id;
            shots.push({ id, url, kind: 'image', mime: result.image.mime, name: 'screenshot.png' });
            await emit('screenshot', { url, meta: result.meta || null });

            let bin = '';
            const chunk = 0x8000;
            for (let i = 0; i < result.image.bytes.length; i += chunk) {
              bin += String.fromCharCode.apply(null, result.image.bytes.subarray(i, i + chunk));
            }
            messages.push(toolResultMessage(call, result));
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: 'これが今のプレビューの見た目です。問題があれば直してください。' },
                { type: 'image_url', image_url: { url: 'data:' + result.image.mime + ';base64,' + btoa(bin) } },
              ],
            });
          } else {
            messages.push(toolResultMessage(call, result));
          }

          await emit('result', {
            name: call.function?.name,
            text: String(result.text || '').slice(0, 4000),
            meta: result.meta || null,
          });

          if (state.preview?.url) {
            await env.DB.prepare('UPDATE agent_runs SET preview_url = ? WHERE id = ?')
              .bind(state.preview.url, runId)
              .run();
          }
        }

        // Only the transcript grows without bound, so old turns are pruned.
        if (messages.length > 60) messages.splice(1, messages.length - 60);
      }
      // The loop counter runs one past the ceiling on exhaustion; report the
      // number of turns that actually happened, not the index that ended it.
      stopped = steps > MAX_STEPS;
      if (stopped) steps = MAX_STEPS;
      if (stopped && !finalText) finalText = '（上限に達したため中断しました。続けるにはもう一度依頼してください）';
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 600);
      await emit('error', { message: msg });
      await env.DB.prepare('UPDATE agent_runs SET status = ?, error = ?, cost = ?, steps = ?, updated_at = ? WHERE id = ?')
        .bind('failed', msg, cost || null, steps, now(), runId)
        .run();
      // A failed run still paid for every turn it took; leaving it out of the
      // ledger is how the usage tab came to show less than OpenRouter billed.
      if (cost) await logUsage(env, { userId, roomId, provider, model, kind: 'agent', cost });
      await emit('done', { steps, error: true });
      return;
    }

    const files = await listFiles(sandboxFor(env, roomId)).catch(() => []);
    // Snapshot before the container is allowed to sleep, or the work is lost.
    await step
      .do(
        'snapshot workspace',
        { retries: { limit: 1, delay: '5 seconds' }, timeout: '5 minutes' },
        () => snapshotWorkspace(env, roomId, sandboxFor(env, roomId))
      )
      .catch(() => null);
    const assistantId = newId('msg');
    await env.DB.prepare(
      'INSERT INTO messages (id, room_id, user_id, role, content, provider, model, attachments, annotations, meta, cost, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        assistantId,
        roomId,
        userId,
        'assistant',
        finalText || '（応答がありませんでした）',
        provider,
        model,
        JSON.stringify(shots.slice(-4)),
        '[]',
        JSON.stringify({ agent: { steps, files: files.length, preview: state.preview?.url || null, stopped } }),
        cost || null,
        now()
      )
      .run();
    await env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(now(), roomId).run();
    await env.DB.prepare('UPDATE agent_runs SET status = ?, cost = ?, steps = ?, updated_at = ? WHERE id = ?')
      .bind('done', cost || null, steps, now(), runId)
      .run();
    if (cost) await logUsage(env, { userId, roomId, provider, model, kind: 'agent', cost });

    await emit('done', {
      steps,
      stopped,
      cost: cost || null,
      files,
      preview: state.preview?.url || null,
      messageId: assistantId,
    });
  }
}
