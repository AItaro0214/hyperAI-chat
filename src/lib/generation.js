/* What OpenRouter actually charged, as opposed to what we estimated.
 *
 * Checked on 2026-09-24 against a key's own usage counter:
 *
 *   - usage.cost in a chat response is exact, search included. Three test
 *     requests (server-tool search, Exa plugin, TTS) summed to the key's
 *     usage delta to the ninth decimal.
 *   - TTS reports no cost at all, and the per-character estimate this app
 *     used was a hundredth of the real charge: Gemini TTS bills its audio
 *     output tokens, which a character count cannot see. The response does
 *     carry X-Generation-Id, and /generation returns the real figure for it
 *     within about fifteen seconds.
 *   - /generation is *not* a fallback for chat with server tools: for those
 *     it keeps reporting total_cost 0 even after the key has been charged.
 *     There the only reliable figure is the one in the stream, which is why
 *     reconcile() compares totals at the key level instead.
 */

import { OPENROUTER_BASE } from './chat.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The settled charge for one generation, or null if it never appears. */
export async function generationCost(apiKey, id, { tries = 6, delayMs = 4000 } = {}) {
  if (!id) return null;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(delayMs);
    try {
      const res = await fetch(OPENROUTER_BASE + '/generation?id=' + encodeURIComponent(id), {
        headers: { authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const cost = Number((await res.json())?.data?.total_cost);
      if (Number.isFinite(cost) && cost > 0) return cost;
    } catch {
      /* not settled yet */
    }
  }
  return null;
}

/** This key's own usage counters, in dollars. */
export async function keyUsage(apiKey) {
  const res = await fetch(OPENROUTER_BASE + '/key', {
    headers: { authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('OpenRouter /key → ' + res.status);
  const d = (await res.json())?.data || {};
  return {
    total: Number(d.usage) || 0,
    day: Number(d.usage_daily) || 0,
    week: Number(d.usage_weekly) || 0,
    month: Number(d.usage_monthly) || 0,
    limit: d.limit ?? null,
    remaining: d.limit_remaining ?? null,
  };
}

/** Credits and usage across every key on the account. */
export async function accountCredits(apiKey) {
  const res = await fetch(OPENROUTER_BASE + '/credits', {
    headers: { authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const d = (await res.json())?.data || {};
  return { credits: Number(d.total_credits) || 0, usage: Number(d.total_usage) || 0 };
}

/* OpenRouter's daily / weekly / monthly counters reset on UTC boundaries, the
 * week starting on Monday. The same windows are cut from our own ledger so the
 * two can be compared line for line. */
export function utcWindows(nowSec = Math.floor(Date.now() / 1000)) {
  const d = new Date(nowSec * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return {
    day,
    week: day - sinceMonday * 86400,
    month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000,
  };
}
