/* The tool-calling loop, shared by the main run and by sub-agents.
 *
 * A sub-agent is the same loop with its own budget, its own model and no
 * ability to spawn further sub-agents. Isolating it matters for cost as much as
 * for control: a cheap model can grind through bulk work without dragging its
 * tool output into the expensive model's context. */

import { postJson, OPENROUTER_BASE, GROQ_BASE, readProviderError } from './chat.js';
import { attribution } from './branding.js';
import { TOOLS, parseArgs, toolResultMessage } from './agent.js';

export const SUBAGENT_MAX_STEPS = 12;

/** The sub-agent gets everything except the ability to recurse. */
export const subagentTools = () => TOOLS.filter((t) => t.function.name !== 'spawn_subagent');

export async function callProvider(provider, model, messages, apiKey, { temperature, tools } = {}) {
  const base = provider === 'groq' ? GROQ_BASE : OPENROUTER_BASE;
  const body = { model, messages, tools: tools || TOOLS, tool_choice: 'auto', stream: false };
  if (temperature !== null && temperature !== undefined && temperature !== '') body.temperature = Number(temperature);
  if (provider === 'openrouter') body.usage = { include: true };

  const res = await postJson(
    base + '/chat/completions',
    {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      ...(provider === 'openrouter'
        ? attribution()
        : {}),
    },
    body,
    300000
  );
  if (!res.ok) throw new Error(await readProviderError(res));
  return res.json();
}

/**
 * Runs a bounded tool-calling loop.
 *
 * @param {object} config
 * @param {(name: string, args: object) => Promise<{text: string, meta?: object}>} config.execute
 * @param {(kind: string, payload: object) => Promise<void>|void} [config.onEvent]
 * @returns {Promise<{text: string, steps: number, cost: number, calls: string[]}>}
 */
export async function runLoop({
  provider,
  model,
  apiKey,
  system,
  task,
  tools,
  maxSteps = SUBAGENT_MAX_STEPS,
  temperature,
  execute,
  onEvent,
}) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ];
  const calls = [];
  let cost = 0;
  let text = '';
  let steps = 0;

  for (steps = 1; steps <= maxSteps; steps++) {
    const reply = await callProvider(provider, model, messages, apiKey, { temperature, tools });
    const message = reply?.choices?.[0]?.message || {};
    cost += Number(reply?.usage?.cost) || 0;

    if (message.content) text = message.content;
    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) break;

    messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      calls.push(name);
      await onEvent?.('tool', { name, args, step: steps });

      let result;
      try {
        result = await execute(name, args);
      } catch (e) {
        result = { text: 'エラー: ' + String(e?.message || e).slice(0, 600) };
      }
      messages.push(toolResultMessage(call, result));
      await onEvent?.('result', { name, text: String(result.text || '').slice(0, 2000) });
    }

    // Only the transcript grows without bound.
    if (messages.length > 40) messages.splice(1, messages.length - 40);
  }

  return { text, steps: Math.min(steps, maxSteps), cost, calls };
}
