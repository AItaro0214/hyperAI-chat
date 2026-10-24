/* RunPod calls this when a breakthrough reply's job ends.
 *
 * There is no session: RunPod is the caller. The URL is signed per message
 * (webhookUrl in runpod-jobs.js), and the body is not trusted or even needed —
 * the app reads the job from RunPod by the id it stored on the message. That
 * also means the webhook's payload format, which RunPod does not document,
 * does not matter.
 *
 * Always 200 once the signature checks out, so RunPod does not retry for
 * something a retry would not change. */

import { Hono } from 'hono';
import { verifyWebhook, settleMessage } from '../lib/runpod-jobs.js';

const hook = new Hono();

hook.post('/webhook/:mid', async (c) => {
  const mid = c.req.param('mid');
  if (!(await verifyWebhook(c.env, mid, c.req.query('sig')))) return c.json({ error: 'forbidden' }, 403);
  await c.req.text().catch(() => '');

  const row = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(mid).first();
  if (!row) return c.json({ ok: true, state: 'unknown message' });
  const out = await settleMessage(c.env, row).catch((e) => ({ state: 'error', error: String(e?.message || e).slice(0, 200) }));
  return c.json({ ok: true, ...out });
});

export default hook;
