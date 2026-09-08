/* Workspace path handling, kept free of the Sandbox SDK so it can be reasoned
 * about — and tested — on its own. */

export const WORKSPACE = '/workspace/project';
export const MAX_OUTPUT = 20000;

export function clip(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  return s.length > limit ? s.slice(0, limit) + '\n…（出力が長いため ' + (s.length - limit) + ' 文字を省略）' : s;
}

/**
 * A DNS-safe, collision-free sandbox id for a room.
 *
 * Room ids are base64url, so roughly one in sixty ends with "-" or "_", and the
 * SDK rejects those outright ("Sandbox ID cannot start or end with hyphens").
 * Hex-encoding the id sidesteps the whole character class rather than
 * substituting characters, which would let two rooms collide onto one sandbox.
 */
export function sandboxId(roomId) {
  const source = String(roomId || 'scratch');
  let hex = '';
  for (let i = 0; i < source.length; i++) hex += source.charCodeAt(i).toString(16).padStart(2, '0');
  // DNS labels stop at 63 characters; the tail is the random part of the id.
  return 'room' + (hex.length > 56 ? hex.slice(-56) : hex);
}

/**
 * Maps a model-supplied path into the workspace. Every traversal segment is
 * dropped rather than rejected, so a confused model lands somewhere harmless
 * inside the workspace instead of reaching the container's filesystem.
 */
export function resolvePath(rel) {
  const clean = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  if (!clean) throw new Error('パスが不正です: ' + rel);
  return WORKSPACE + '/' + clean;
}
