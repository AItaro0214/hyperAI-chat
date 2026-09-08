/* Room-scoped development sandboxes.
 *
 * Each talk room owns one container with a persistent /workspace, so a project
 * survives between turns and the model can pick up where it left off. The
 * container sleeps when idle and is only billed while it runs. */

import { getSandbox, collectFile } from '@cloudflare/sandbox';
import { WORKSPACE, clip, resolvePath, sandboxId } from './workspace.js';

export { WORKSPACE, resolvePath, sandboxId };

const DEFAULT_TIMEOUT = 120000;
/* A container that cannot start leaves the SDK promise pending forever, which
 * stalls a workflow step with no upper bound. Every call gets a wall clock. */
const CALL_TIMEOUT = 90000;

export function withTimeout(promise, ms = CALL_TIMEOUT, what = 'サンドボックス操作') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(what + 'がタイムアウトしました（' + Math.round(ms / 1000) + '秒）')), ms)
    ),
  ]);
}

/**
 * One sandbox per room; the id is what keeps the workspace stable.
 * sandboxId() keeps it within what the SDK accepts as a hostname label.
 */
export function sandboxFor(env, roomId) {
  if (!env.Sandbox) throw new Error('サンドボックスが有効になっていません（Workers Paid プランが必要です）');
  // The tunnels API is only available over the RPC transport, and the option
  // must be identical on every call for a given sandbox id.
  return getSandbox(env.Sandbox, sandboxId(roomId), { transport: 'rpc' });
}

export async function ensureWorkspace(sandbox) {
  await withTimeout(sandbox.mkdir(WORKSPACE, { recursive: true }), 60000, 'ワークスペースの準備').catch(() => {});
}

/**
 * Runs a command to completion. `onOutput` receives stdout/stderr as it is
 * produced, so a long install can be shown live instead of looking hung.
 */
export async function runCommand(sandbox, command, { cwd = WORKSPACE, timeout = DEFAULT_TIMEOUT, onOutput } = {}) {
  await ensureWorkspace(sandbox);
  const started = Date.now();
  try {
    const options = { cwd, timeout };
    if (onOutput) {
      options.stream = true;
      options.onOutput = (stream, data) => {
        try {
          onOutput(stream, data);
        } catch {
          /* a failing consumer must not kill the command */
        }
      };
    }
    // The exec option is the in-container limit; this one covers the RPC itself.
    const result = await withTimeout(sandbox.exec(command, options), timeout + 30000, 'コマンド実行');
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? 0,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, exitCode: -1, stdout: '', stderr: clip(String(e?.message || e), 4000), ms: Date.now() - started };
  }
}

export async function writeFile(sandbox, rel, contents) {
  const path = resolvePath(rel);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await sandbox.mkdir(dir, { recursive: true }).catch(() => {});
  await withTimeout(sandbox.writeFile(path, String(contents ?? '')), CALL_TIMEOUT, 'ファイル書き込み');
  return { path: path.slice(WORKSPACE.length + 1), bytes: new TextEncoder().encode(String(contents ?? '')).length };
}

/** Binary in, via base64 — the file API only carries text. */
export async function writeBinary(sandbox, rel, bytes) {
  const path = resolvePath(rel);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await sandbox.mkdir(dir, { recursive: true }).catch(() => {});

  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  const staging = path + '.b64';
  await sandbox.writeFile(staging, btoa(bin));
  const res = await runCommand(sandbox, 'base64 -d ' + JSON.stringify(staging) + ' > ' + JSON.stringify(path) +
    ' && rm -f ' + JSON.stringify(staging), { timeout: 60000 });
  if (!res.ok) throw new Error('ファイルを書き込めませんでした: ' + (res.stderr || res.stdout).slice(0, 200));
  return { path: path.slice(WORKSPACE.length + 1), bytes: bytes.length };
}

/** Clipped for the model's benefit; downloads use readFileRaw instead. */
export async function readFile(sandbox, rel) {
  return clip(await readFileRaw(sandbox, rel));
}

/** The whole file, for downloads where truncating would corrupt the result. */
export async function readFileRaw(sandbox, rel) {
  const result = await withTimeout(sandbox.readFile(resolvePath(rel)), CALL_TIMEOUT, 'ファイル読み込み');
  return typeof result === 'string' ? result : result?.content ?? '';
}

/** A flat listing of the workspace, with build output filtered out. */
export async function listFiles(sandbox, { limit = 400 } = {}) {
  const res = await runCommand(
    sandbox,
    "find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' " +
      "-not -path './.next/*' -not -path './build/*' -printf '%P\\t%s\\n' | sort | head -" + limit,
    { timeout: 20000 }
  );
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [path, size] = line.split('\t');
      return { path, size: Number(size) || 0 };
    });
}

export async function deleteFile(sandbox, rel) {
  await runCommand(sandbox, 'rm -rf ' + JSON.stringify(resolvePath(rel)), { timeout: 20000 });
  return { deleted: rel };
}

/* ----------------------------- dev server ------------------------------- */

/**
 * Starts a long-running command and puts it behind a preview URL.
 *
 * A quick tunnel is used rather than exposePort: it needs no wildcard DNS on
 * our own zone, and Browser Rendering can reach the resulting URL directly.
 * @returns {Promise<{url: string|null, processId: string|null, log: string, error: string|null}>}
 */
export async function startPreview(sandbox, command, port) {
  await ensureWorkspace(sandbox);
  const process = await withTimeout(sandbox.startProcess(command, { cwd: WORKSPACE }), CALL_TIMEOUT, 'プロセス起動');

  let error = null;
  try {
    // waitForPort lives on the process so it fails fast if the server dies.
    await process.waitForPort(port, { timeout: 90000 });
  } catch (e) {
    error = String(e?.message || e).slice(0, 300);
  }

  let url = null;
  if (!error) {
    try {
      const tunnel = await sandbox.tunnels.get(port);
      url = tunnel?.url || null;
    } catch (e) {
      error = 'プレビューURLの発行に失敗: ' + String(e?.message || e).slice(0, 200);
    }
  }

  const logs = await sandbox.getProcessLogs(process.id).catch(() => null);
  return {
    url,
    processId: process.id || null,
    port,
    error,
    log: clip([logs?.stdout, logs?.stderr].filter(Boolean).join('\n'), 4000),
  };
}

export async function stopPreview(sandbox, port, processId) {
  if (port) await sandbox.tunnels.destroy(port).catch(() => {});
  if (processId) await sandbox.killProcess(processId).catch(() => {});
}

/** Proxies a request straight into the container, for the stable preview URL. */
export function containerFetch(sandbox, request, port) {
  return withTimeout(sandbox.containerFetch(request, port), 60000, 'プレビューへの転送');
}

export async function previewUrls(sandbox) {
  const list = await sandbox.tunnels.list().catch(() => []);
  return (list || []).map((t) => ({ port: t.port, url: t.url }));
}

export async function listProcesses(sandbox) {
  const res = await sandbox.listProcesses().catch(() => null);
  const list = res?.processes || res || [];
  return (Array.isArray(list) ? list : []).map((p) => ({
    id: p.id,
    command: p.command,
    status: p.status,
  }));
}

/* -------------------------------- export -------------------------------- */

/**
 * Zips the workspace inside the container and returns the bytes.
 *
 * The archive is read back as a binary stream: routing it through a shell
 * base64 would be truncated by the command-output cap, which silently produced
 * a corrupt file.
 */
export async function zipWorkspace(sandbox, name = 'project') {
  const safe = String(name || 'project').replace(/[^\w.-]/g, '_') || 'project';
  const archive = '/tmp/' + safe + '.zip';

  // `zip` exits 12 when there is nothing to add, which is not a failure worth
  // an opaque error message.
  const res = await runCommand(
    sandbox,
    'rm -f ' + JSON.stringify(archive) +
      "; zip -r -q " + JSON.stringify(archive) +
      " . -x 'node_modules/*' -x '.git/*' -x '.next/cache/*'; echo exit=$?; ls -l " + JSON.stringify(archive),
    { timeout: 180000 }
  );
  const code = Number((res.stdout.match(/exit=(\d+)/) || [])[1] ?? -1);
  if (code === 12 || /No such file/.test(res.stdout + res.stderr)) {
    throw new Error('ワークスペースが空です。まず何か作ってからお試しください。');
  }
  if (code !== 0) {
    throw new Error('zip の作成に失敗しました: ' + (res.stderr || res.stdout).slice(0, 300));
  }

  const stream = await withTimeout(sandbox.readFileStream(archive), 180000, 'zip の読み出し');
  const collected = await collectFile(stream);
  const content = collected?.content;
  if (content instanceof Uint8Array) return content;
  if (typeof content === 'string') {
    // A text transport hands the bytes back as latin-1.
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
    return bytes;
  }
  throw new Error('zip を読み出せませんでした');
}

/* ------------------------------ screenshots ------------------------------ */

/** Renders a preview URL with Browser Rendering so the model can see it. */
export async function screenshot(env, url, { width = 1280, height = 800, fullPage = false, wait = 1200 } = {}) {
  if (!env.BROWSER) throw new Error('Browser Rendering が有効になっていません');
  const puppeteer = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    // Listeners go on before navigation, or the page's own errors are missed.
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
    });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 400)));
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const buf = await page.screenshot({ fullPage, type: 'png' });
    return { bytes: new Uint8Array(buf), consoleErrors: consoleErrors.slice(0, 20) };
  } finally {
    await browser.close().catch(() => {});
  }
}
