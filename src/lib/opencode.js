/* OpenCode running inside the room's sandbox.
 *
 * The CLI is installed on demand rather than baked into the image, so the
 * container keeps Python and the data-science packages while still offering the
 * OpenCode workflow. The server is pointed at the user's own OpenRouter key,
 * which is what makes Qwen / Kimi / GLM usable as coding agents here. */

import { createOpencodeServer, proxyToOpencode } from '@cloudflare/sandbox/opencode';
import { WORKSPACE } from './workspace.js';
import { runCommand, ensureWorkspace } from './sandbox.js';

export const OPENCODE_PORT = 4096;

/** Installs the CLI once per container; later calls are a fast no-op. */
export async function ensureOpencode(sandbox) {
  const probe = await runCommand(sandbox, 'command -v opencode', { timeout: 20000 });
  if (probe.ok && probe.stdout.trim()) return { installed: false, path: probe.stdout.trim() };

  const install = await runCommand(sandbox, 'npm install -g opencode-ai@latest', { timeout: 300000 });
  if (!install.ok) {
    throw new Error('OpenCode のインストールに失敗しました: ' + (install.stderr || install.stdout).slice(0, 400));
  }
  const again = await runCommand(sandbox, 'command -v opencode', { timeout: 20000 });
  if (!again.ok || !again.stdout.trim()) throw new Error('OpenCode をインストールできませんでした');
  return { installed: true, path: again.stdout.trim() };
}

/**
 * Starts (or reuses) the OpenCode server for this sandbox.
 * @param {string} apiKey OpenRouter key — OpenCode talks to the provider itself.
 * @param {string} model  e.g. "openrouter/z-ai/glm-5.3"
 */
export async function startOpencode(sandbox, apiKey, model) {
  await ensureWorkspace(sandbox);
  await ensureOpencode(sandbox);

  const config = {
    provider: {
      openrouter: {
        options: { apiKey },
      },
    },
  };
  // OpenCode expects "<provider>/<model>"; the picker hands over the bare id.
  if (model) config.model = model.startsWith('openrouter/') ? model : 'openrouter/' + model;

  const server = await createOpencodeServer(sandbox, {
    port: OPENCODE_PORT,
    directory: WORKSPACE,
    config,
    env: { OPENROUTER_API_KEY: apiKey },
  });
  return server;
}

export async function stopOpencode(sandbox) {
  // Killing by port is more reliable than tracking a process id across requests.
  await runCommand(sandbox, "pkill -f 'opencode serve' || true", { timeout: 20000 });
}

export { proxyToOpencode };
