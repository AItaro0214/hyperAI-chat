/* The agent endpoint: a tool-calling loop against the room's sandbox, streamed
 * to the client so every command, screenshot and edit is visible as it happens. */

import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { getSettings, logUsage } from '../lib/store.js';
import { findModel, getCatalog } from '../lib/models.js';
import { requireKey } from '../lib/chat.js';
import {
  sandboxFor,
  runCommand,
  listFiles,
  readFile,
  readFileRaw,
  writeFile,
  deleteFile,
  previewUrls,
  stopPreview,
  zipWorkspace,
} from '../lib/sandbox.js';
import { startOpencode, stopOpencode, proxyToOpencode, OPENCODE_PORT } from '../lib/opencode.js';
import { snapshotWorkspace, restoreWorkspace, snapshotInfo } from '../lib/workspace-store.js';
import { loadRules, saveRules, DEFAULT_RULES, RULES_FILE } from '../lib/agent-rules.js';
import { SKILLS, SKILL_IDS, renderSkill, skillPath } from '../lib/skills.js';
import { startEnvironment, environmentInfo, destroyEnvironment, touchEnvironment, PREVIEW_TTL_DAYS } from '../lib/preview.js';

const agent = new Hono();
agent.use('/agent', requireAuth);
agent.use('/agent/*', requireAuth);

/* ------------------------------ workspace ------------------------------- */

/** Container failures surface as opaque SDK errors; this makes them actionable. */
function sandboxError(e) {
  const raw = String(e?.message || e);
  if (/unauthorized|not enabled|no container|payment|subscription|403|401/i.test(raw)) {
    return (
      'コンテナが利用できません。Cloudflare の Workers Paid プラン（$5/月）を有効にし、' +
      '`wrangler login` でトークンを取り直してから再デプロイしてください。（詳細: ' + raw.slice(0, 200) + '）'
    );
  }
  return raw.slice(0, 400);
}

agent.get('/agent/files', async (c) => {
  const roomId = c.req.query('roomId');
  try {
    const sandbox = sandboxFor(c.env, roomId);
    // Container disk is wiped whenever the instance sleeps, so a cold start is
    // repopulated from the stored snapshot before the listing is taken.
    const restored = await restoreWorkspace(c.env, roomId, sandbox).catch(() => ({ restored: false }));
    return c.json({
      files: await listFiles(sandbox),
      previews: await previewUrls(sandbox),
      restored: restored.restored ? restored : null,
      snapshot: await snapshotInfo(c.env, roomId).catch(() => null),
    });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 503);
  }
});

/** The always-applied project rules, edited from the panel. */
agent.get('/agent/rules', async (c) => {
  try {
    const sandbox = sandboxFor(c.env, c.req.query('roomId'));
    await restoreWorkspace(c.env, c.req.query('roomId'), sandbox).catch(() => null);
    const rules = await loadRules(sandbox);
    return c.json({ name: rules?.name || RULES_FILE, text: rules?.text ?? '', template: DEFAULT_RULES });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 503);
  }
});

agent.post('/agent/rules', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    const out = await saveRules(sandbox, body.text);
    // Rules only survive the container sleeping once they are in a snapshot.
    await snapshotWorkspace(c.env, body.roomId, sandbox).catch(() => null);
    return c.json(out);
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

/** The skills the agent can load, and any project-specific overrides. */
agent.get('/agent/skills', async (c) => {
  const roomId = c.req.query('roomId');
  const id = c.req.query('name');
  try {
    const sandbox = sandboxFor(c.env, roomId);
    if (id) {
      if (!SKILL_IDS.includes(id)) return c.json({ error: '未知のスキルです' }, 400);
      const override = await readFileRaw(sandbox, skillPath(id)).catch(() => '');
      return c.json({
        id,
        title: SKILLS[id].title,
        when: SKILLS[id].when,
        builtin: SKILLS[id].guide,
        override: String(override || ''),
        rendered: await renderSkill(c.env, id, override),
      });
    }
    const files = await listFiles(sandbox).catch(() => []);
    const custom = new Set(files.map((f) => f.path));
    return c.json({
      skills: SKILL_IDS.map((key) => ({
        id: key,
        title: SKILLS[key].title,
        when: SKILLS[key].when,
        custom: custom.has(skillPath(key)),
      })),
    });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 503);
  }
});

agent.post('/agent/skills', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!SKILL_IDS.includes(body.name)) return c.json({ error: '未知のスキルです' }, 400);
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    const text = String(body.text ?? '');
    // An empty body removes the override and restores the built-in guidance.
    await writeFile(sandbox, skillPath(body.name), text);
    await snapshotWorkspace(c.env, body.roomId, sandbox).catch(() => null);
    return c.json({ ok: true, custom: !!text.trim() });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

/* -------------------------- preview environment -------------------------- */

agent.get('/agent/preview', async (c) => {
  try {
    return c.json({ env: await environmentInfo(c.env, c.req.query('roomId')), ttlDays: PREVIEW_TTL_DAYS });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 503);
  }
});

agent.post('/agent/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const userId = c.get('userId');
  const room = await c.env.DB.prepare('SELECT id FROM rooms WHERE id = ? AND user_id = ?')
    .bind(body.roomId, userId)
    .first();
  if (!room) return c.json({ error: 'トークルームを選んでください' }, 400);
  const command = String(body.command || '').trim();
  if (!command) return c.json({ error: '起動コマンドが必要です' }, 400);
  try {
    const out = await startEnvironment(c.env, userId, room.id, {
      command,
      port: Number(body.port) || 8080,
    });
    return c.json(out, out.ok ? 200 : 502);
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

agent.post('/agent/preview/extend', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await touchEnvironment(c.env, body.roomId);
  return c.json({ ok: true, ttlDays: PREVIEW_TTL_DAYS });
});

agent.delete('/agent/preview', async (c) => {
  const roomId = c.req.query('roomId');
  try {
    return c.json(await destroyEnvironment(c.env, roomId));
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

agent.post('/agent/snapshot', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    const out = await snapshotWorkspace(c.env, body.roomId, sandbox);
    return c.json(out);
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

agent.get('/agent/file', async (c) => {
  try {
    const sandbox = sandboxFor(c.env, c.req.query('roomId'));
    return c.json({ path: c.req.query('path'), content: await readFile(sandbox, c.req.query('path')) });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

agent.post('/agent/file', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    if (body.delete) return c.json(await deleteFile(sandbox, body.path));
    return c.json(await writeFile(sandbox, body.path, body.content));
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

/** Streams one workspace file out as a download. */
agent.get('/agent/download', async (c) => {
  const path = c.req.query('path') || '';
  try {
    const sandbox = sandboxFor(c.env, c.req.query('roomId'));
    const content = await readFileRaw(sandbox, path);
    const name = path.split('/').pop() || 'file.txt';
    return new Response(content, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      },
    });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

agent.post('/agent/exec', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    return c.json(await runCommand(sandbox, String(body.command || ''), { timeout: 120000 }));
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

agent.post('/agent/stop-preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    await stopPreview(sandboxFor(c.env, body.roomId), Number(body.port), body.processId);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 400);
  }
});

/** Bundles the workspace and stores it as a normal downloadable file. */
agent.post('/agent/zip', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    const bytes = await zipWorkspace(sandbox, body.name || 'project');
    const id = newId('file');
    const name = String(body.name || 'project').replace(/[^\w.-]/g, '_') + '.zip';
    await c.env.KV.put('file:' + id, bytes, { metadata: { mime: 'application/zip', name, at: now() } });
    await c.env.DB.prepare(
      'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, body.roomId || null, 'doc', 'application/zip', name, bytes.length, now())
      .run();
    return c.json({ id, url: '/api/files/' + id + '?download=1', name, size: bytes.length }, 201);
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

agent.post('/agent/reset', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    const res = await runCommand(sandbox, 'rm -rf /workspace/project && mkdir -p /workspace/project', { timeout: 60000 });
    return c.json({ ok: res.ok });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

/** A run silent for this long is assumed dead, whatever the row says. */
const STALE_RUN_SECONDS = 15 * 60;

/** Marks a stranded run failed and stops its workflow, freeing the room. */
async function reapRun(env, run) {
  if (run.instance_id && env.AGENT) {
    await env.AGENT.get(run.instance_id)
      .then((i) => i.terminate?.())
      .catch(() => {});
  }
  await env.DB.prepare(
    "UPDATE agent_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
  )
    .bind('応答が途絶えたため打ち切りました', now(), run.id)
    .run();
}

/* -------------------------------- OpenCode ------------------------------- */

/** Only tool-calling models can drive an agent; the picker is filtered to them. */
agent.get('/agent/models', async (c) => {
  const data = await getCatalog(c.env).catch(() => ({ models: [] }));
  const models = (data.models || [])
    .filter((m) => m.tools && m.kind === 'chat')
    .map((m) => ({
      ref: m.ref,
      id: m.id,
      name: m.name,
      provider: m.provider,
      family: m.family,
      free: !!m.free,
      pricing: m.pricing,
    }));
  return c.json({ models });
});

agent.post('/agent/opencode/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let apiKey;
  try {
    apiKey = await requireKey(c.env, 'openrouter');
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
  try {
    const sandbox = sandboxFor(c.env, body.roomId);
    const server = await startOpencode(sandbox, apiKey, body.model);
    return c.json({ ok: true, port: server.port, url: '/opencode/?roomId=' + encodeURIComponent(body.roomId || '') });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

agent.post('/agent/opencode/stop', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    await stopOpencode(sandboxFor(c.env, body.roomId));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: sandboxError(e) }, 500);
  }
});

agent.post('/agent', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const task = String(body.task || '').trim();
  if (!task) return c.json({ error: '依頼内容を入力してください' }, 400);

  const room = body.roomId
    ? await c.env.DB.prepare('SELECT * FROM rooms WHERE id = ? AND user_id = ?').bind(body.roomId, userId).first()
    : null;
  if (!room) return c.json({ error: 'トークルームを選んでください' }, 400);
  if (!c.env.Sandbox) return c.json({ error: 'サンドボックスが未設定です（Workers Paid プランが必要です）' }, 503);
  if (!c.env.AGENT) return c.json({ error: 'エージェントのワークフローが未設定です' }, 503);

  // One run at a time per room; two agents in one workspace would collide.
  // A run that stopped reporting is treated as dead rather than blocking the
  // room forever — a deploy or a hung command can strand one mid-flight.
  const active = await c.env.DB.prepare(
    "SELECT id, instance_id, updated_at FROM agent_runs WHERE room_id = ? AND status = 'running' " +
      'ORDER BY created_at DESC LIMIT 1'
  )
    .bind(room.id)
    .first();
  if (active) {
    const silentFor = now() - Number(active.updated_at || 0);
    let alive = silentFor < STALE_RUN_SECONDS;
    if (alive && active.instance_id && c.env.AGENT) {
      // The workflow is the authority; the row can lag behind it.
      const state = await c.env.AGENT.get(active.instance_id)
        .then((i) => i.status())
        .catch(() => null);
      if (state && !['running', 'queued', 'waiting', 'paused'].includes(String(state.status))) alive = false;
    }
    if (alive) {
      return c.json(
        {
          error: 'このルームでは既にエージェントが動いています。パネルを開き直すと進捗に再接続できます。停止したい場合は「停止」を押してください。',
          runId: active.id,
        },
        409
      );
    }
    await reapRun(c.env, active);
  }

  const settings = await getSettings(c.env);
  const provider = body.provider || room.provider || settings.defaultProvider;
  const modelId = body.model || room.model || settings.defaultModel;
  const catalog = await getCatalog(c.env).catch(() => ({ models: [] }));
  const meta = findModel(catalog, provider + ':' + modelId);
  if (meta && meta.tools === false) {
    return c.json(
      { error: modelId + ' はツール呼び出しに対応していないため、エージェントでは使えません。別のモデルを選んでください。' },
      400
    );
  }
  try {
    await requireKey(c.env, provider);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }

  const runId = newId('run');
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO agent_runs (id, user_id, room_id, task, provider, model, status, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)"
  )
    .bind(runId, userId, room.id, task, provider, modelId, t, t)
    .run();
  await c.env.DB.prepare(
    'INSERT INTO messages (id, room_id, user_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(newId('msg'), room.id, userId, 'user', '🛠 ' + task, '[]', t)
    .run();

  const instance = await c.env.AGENT.create({
    params: {
      runId,
      userId,
      roomId: room.id,
      task,
      provider,
      model: modelId,
      imageModel: body.imageModel || settings.imageModel || undefined,
      systemExtra: settings.systemPrompt || '',
    },
  });
  await c.env.DB.prepare('UPDATE agent_runs SET instance_id = ? WHERE id = ?').bind(instance.id, runId).run();

  return c.json({ runId, instanceId: instance.id }, 202);
});

/** The run currently attached to a room, so the panel can re-attach on open. */
agent.get('/agent/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, task, status, steps, cost, preview_url, error, created_at FROM agent_runs ' +
      'WHERE room_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 5'
  )
    .bind(c.req.query('roomId') || '', c.get('userId'))
    .all();
  return c.json({ runs: results || [] });
});

agent.post('/agent/cancel', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const run = await c.env.DB.prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .bind(body.runId, c.get('userId'))
    .first();
  if (!run) return c.json({ error: 'not found' }, 404);
  if (run.instance_id && c.env.AGENT) {
    const instance = await c.env.AGENT.get(run.instance_id).catch(() => null);
    await instance?.terminate?.().catch(() => {});
  }
  await c.env.DB.prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .bind(now(), body.runId)
    .run();
  return c.json({ ok: true });
});

/**
 * Replays a run's recorded progress and follows it live.
 *
 * The workflow writes events to the database, so this endpoint is a reader:
 * closing the browser cannot stop the run, and reopening resumes the log from
 * the beginning.
 */
agent.get('/agent/stream', async (c) => {
  const userId = c.get('userId');
  const runId = c.req.query('runId') || '';
  const run = await c.env.DB.prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .bind(runId, userId)
    .first();
  if (!run) return c.json({ error: 'not found' }, 404);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const pump = (async () => {
    let after = Number(c.req.query('after')) || 0;
    let idle = 0;
    const send = async (event, data) => {
      await writer.write(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
    };

    try {
      // Poll rather than subscribe: D1 has no change feed, and a run emits at
      // human speed so a one-second cadence is plenty.
      for (;;) {
        const { results } = await c.env.DB.prepare(
          'SELECT seq, kind, payload FROM agent_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 200'
        )
          .bind(runId, after)
          .all();

        for (const row of results || []) {
          after = row.seq;
          await send(row.kind, { ...JSON.parse(row.payload), seq: row.seq });
        }

        if ((results || []).length) {
          idle = 0;
        } else {
          const status = await c.env.DB.prepare('SELECT status FROM agent_runs WHERE id = ?').bind(runId).first();
          if (status && status.status !== 'running') break;
          idle += 1;
          // A run that goes quiet for ten minutes is not coming back.
          if (idle > 600) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      await send('closed', { runId });
    } catch {
      /* the client went away */
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  c.executionCtx.waitUntil(pump);
  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
});

export default agent;
