/* Reading and writing the project rules inside a sandbox.
 *
 * The convention every coding agent now follows is a markdown file at the root
 * of the workspace, so the same file works here and in OpenCode. It lives in
 * the workspace, which means the snapshot carries it like any other file. */

import { readFileRaw, writeFile, listFiles } from './sandbox.js';
import { RULES_FILE, RULES_CANDIDATES, MAX_RULES } from './rules.js';

export { RULES_FILE, DEFAULT_RULES, rulesBlock } from './rules.js';

/** Loads the rules file from the workspace, if the project has one. */
export async function loadRules(sandbox) {
  const files = await listFiles(sandbox, { limit: 400 }).catch(() => []);
  const names = new Set(files.map((f) => f.path));
  for (const candidate of RULES_CANDIDATES) {
    if (!names.has(candidate)) continue;
    const text = await readFileRaw(sandbox, candidate).catch(() => '');
    if (String(text).trim()) return { name: candidate, text: String(text).slice(0, MAX_RULES) };
  }
  return null;
}

export async function saveRules(sandbox, text) {
  return writeFile(sandbox, RULES_FILE, String(text ?? '').slice(0, MAX_RULES));
}
