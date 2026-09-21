/* Prompt caching, for the providers that need to be told.
 *
 * An agent run re-sends its whole transcript on every step, so by step ten the
 * same tens of thousands of tokens have been read ten times. Most providers
 * notice this on their own — OpenAI, Gemini 2.5, Grok, Groq and DeepSeek cache
 * a repeated prefix with no help. Anthropic and Qwen do not: they cache only
 * what a `cache_control` breakpoint marks, and without one an agent loop pays
 * full price for the same prefix every turn.
 *
 * Cached reads bill at 0.1x on Anthropic, so this is most of the cost of a long
 * run. Writes cost 1.25x, which is why breakpoints go on content that will
 * certainly be re-sent rather than on whatever happens to be last. */

/** Families that ignore a repeated prefix unless a breakpoint marks it. */
const EXPLICIT = /^(anthropic|qwen)\//i;

/* Below the provider minimum a breakpoint does nothing but add a write
 * surcharge, so the prefix has to be worth caching first. The lowest documented
 * floor is 1,024 tokens; this is that, in characters, conservatively. */
const MIN_CACHE_CHARS = 4000;

export const needsExplicitCache = (provider, model) =>
  provider !== 'groq' && EXPLICIT.test(String(model || ''));

const lengthOf = (content) => {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n, b) => n + (b?.text?.length || 0), 0);
  return 0;
};

/** Returns a copy of the message with the breakpoint on its last text block. */
function marked(message) {
  const content = message.content;
  if (typeof content === 'string') {
    return { ...message, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
  }
  if (Array.isArray(content) && content.length) {
    const blocks = content.map((b) => ({ ...b }));
    // Only a text block can carry the marker; an image cannot.
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.type === 'text' || typeof blocks[i]?.text === 'string') {
        blocks[i].cache_control = { type: 'ephemeral' };
        return { ...message, content: blocks };
      }
    }
  }
  return null;
}

/**
 * Adds cache breakpoints to a message list.
 *
 * Two of the four Anthropic allows are used:
 *   - the system message, which covers the tool definitions too and never
 *     changes for the life of a run;
 *   - the newest message that will still be there next turn, which caches the
 *     transcript as it grows.
 *
 * The second one moves forward each turn. That is the point: the previous
 * position stays cached and the new one extends it, so each step reads what the
 * step before it wrote.
 *
 * @returns a new array; the input is not modified
 */
export function withCacheBreakpoints(messages, { provider, model } = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  if (!needsExplicitCache(provider, model)) return messages;

  const out = messages.slice();

  // 1. System (and, on Anthropic, the tools that sit in front of it).
  if (out[0]?.role === 'system' && lengthOf(out[0].content) >= MIN_CACHE_CHARS) {
    const m = marked(out[0]);
    if (m) out[0] = m;
  }

  // 2. The transcript so far, anchored one message back from the end so the
  //    breakpoint lands on content that is already settled.
  let carried = 0;
  for (let i = out.length - 2; i >= 1; i--) {
    carried += lengthOf(out[i].content);
    if (carried < MIN_CACHE_CHARS) continue;
    const m = marked(out[i]);
    if (m) {
      out[i] = m;
      break;
    }
  }

  return out;
}

/** What the reply says was cached, for reporting. */
export function cacheStats(usage) {
  const details = usage?.prompt_tokens_details || {};
  const read = Number(details.cached_tokens) || 0;
  const written = Number(usage?.cache_creation_input_tokens) || 0;
  return { read, written };
}
