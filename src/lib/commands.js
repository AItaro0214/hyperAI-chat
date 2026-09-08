/* Recognising commands that never return.
 *
 * Kept free of the Sandbox SDK so it can be tested directly. Small models
 * routinely start a dev server through run_command despite the instruction not
 * to; that blocks until the timeout and hangs the whole run, so the check is a
 * guardrail rather than a prompt. */

const SERVER_PATTERNS = [
  [/\bvite\b(?!\s+build)/, 'vite'],
  [/\bnpm\s+(run\s+)?(dev|start|serve|preview)\b/, 'npm run dev'],
  [/\b(pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b/, 'パッケージマネージャの dev'],
  [/\bnext\s+(dev|start)\b/, 'next dev'],
  [/\bnuxt\s+(dev|start)\b/, 'nuxt dev'],
  [/\b(webpack|rspack)\s+serve\b/, 'webpack serve'],
  [/\bhttp-server\b|\bnpx\s+serve\b|\bserve\s+-[a-z]/, '静的サーバ'],
  [/\bpython3?\s+-m\s+http\.server\b/, 'python http.server'],
  [/\b(nodemon|pm2|forever)\b/, 'プロセスマネージャ'],
  [/\bflask\s+run\b|\buvicorn\b|\bgunicorn\b|\brails\s+s(erver)?\b/, 'アプリサーバ'],
  [/--watch\b/, 'ウォッチモード'],
  [/\btail\s+-f\b/, 'tail -f'],
];

/**
 * @returns {string|null} a label for why the command would not return, or null.
 */
export function detectServerCommand(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  // A backgrounded command returns immediately, so it is not a problem.
  if (/&\s*$/.test(text)) return null;
  for (const [pattern, label] of SERVER_PATTERNS) if (pattern.test(text)) return label;
  return null;
}

/* The sandbox control plane owns port 3000, and anything below 1024 is
 * privileged. Checking before the process starts avoids leaving an orphan
 * server bound to a port that can never be exposed. */
export const RESERVED_PORT = 3000;
export const SUGGESTED_PORT = 8080;

export function checkPreviewPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n)) return 'ポート番号が不正です: ' + port;
  if (n === RESERVED_PORT) {
    return 'ポート 3000 はコンテナの制御用に予約されています。' +
      SUGGESTED_PORT + ' など別のポートで起動し直してください（サーバ側の待ち受けポートも合わせること）。';
  }
  if (n < 1024 || n > 65535) return 'ポートは 1024〜65535 の範囲で指定してください（指定: ' + n + '）。';
  return null;
}
