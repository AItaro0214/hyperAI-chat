/* Executes the agent's tool calls against the room's sandbox. Split from
 * agent.js so the tool schema stays importable outside the Workers runtime. */

import {
  sandboxFor,
  runCommand,
  writeFile,
  readFile,
  readFileRaw,
  listFiles,
  deleteFile,
  startPreview,
  stopPreview,
  screenshot,
  writeBinary,
} from './sandbox.js';
import { requireKey } from './chat.js';
import { fetchImageModels, buildImageRequest, generateImages, imagesFrom } from './images.js';
import { pickImageModel, pickVideoModel, pickSpeechModel, fixExtension } from './image-purpose.js';
import { fetchVideoModels, submitVideoJob, pollVideoJob, videoUrlFrom, jobStatusOf, estimateVideoCost, applyDiscount } from './video.js';
import { fetchSpeechModels, synthesize, isGroqSpeech } from './speech.js';
import { getCatalog } from './models.js';
import { resolveModelHint } from './image-purpose.js';
import { runLoop, subagentTools, SUBAGENT_MAX_STEPS } from './agent-loop.js';
import { renderSkill, skillPath, SKILL_IDS } from './skills.js';
import { xaiKey, searchX, formatSearchResult, estimateSearchCost } from './xai.js';
import { listModels } from './catalogues.js';
import { detectServerCommand, checkPreviewPort } from './commands.js';
import { SYSTEM_PROMPT } from './agent.js';

/**
 * Executes one tool call.
 * @returns {Promise<{ text: string, image?: {bytes: Uint8Array, mime: string}, meta?: object }>}
 */
export async function runTool(env, roomId, name, args, state, onOutput, options = {}) {
  const sandbox = sandboxFor(env, roomId);

  switch (name) {
    case 'write_file': {
      const out = await writeFile(sandbox, args.path, args.content);
      state.touched.add(out.path);
      return { text: '書き込みました: ' + out.path + '（' + out.bytes + ' bytes）' };
    }
    case 'read_file':
      return { text: await readFile(sandbox, args.path) };
    case 'list_files': {
      const files = await listFiles(sandbox);
      return {
        text: files.length
          ? files.map((f) => f.path + '\t' + f.size).join('\n')
          : '（ワークスペースは空です）',
        meta: { files },
      };
    }
    case 'delete_file': {
      await deleteFile(sandbox, args.path);
      return { text: '削除しました: ' + args.path };
    }
    case 'run_command': {
      const command = String(args.command || '');
      // Small models ignore the instruction and run a dev server here, which
      // blocks until the timeout and hangs the whole run. Refuse deterministically.
      const server = detectServerCommand(command);
      if (server) {
        return {
          text:
            'このコマンドは終了しないため run_command では実行できません（' + server + '）。\n' +
            'start_preview を使ってください: start_preview({ command: ' + JSON.stringify(command) +
            ', port: <待ち受けポート> })',
          meta: { refused: 'long-running', command },
        };
      }
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 300000);
      const res = await runCommand(sandbox, command, { timeout, onOutput });
      return {
        text:
          'exit=' + res.exitCode + '（' + Math.round(res.ms / 1000) + '秒）\n' +
          (res.stdout ? '--- stdout ---\n' + res.stdout + '\n' : '') +
          (res.stderr ? '--- stderr ---\n' + res.stderr : ''),
        meta: { command: args.command, exitCode: res.exitCode, ms: res.ms },
      };
    }
    case 'start_preview': {
      const port = Number(args.port) || 8080;
      const bad = checkPreviewPort(port);
      if (bad) return { text: bad, meta: { refused: 'port', port } };
      const res = await startPreview(sandbox, String(args.command || ''), port);
      if (res.url) state.preview = { url: res.url, port, processId: res.processId };
      return {
        text: res.url
          ? 'プレビューを開始しました: ' + res.url + '\n' + (res.log ? '--- log ---\n' + res.log : '')
          : '起動できませんでした: ' + (res.error || '不明') + '\n' + (res.log ? '--- log ---\n' + res.log : ''),
        meta: { preview: res.url, port },
      };
    }
    case 'stop_preview': {
      const port = Number(args.port) || state.preview?.port;
      await stopPreview(sandbox, port, state.preview?.processId);
      if (state.preview?.port === port) state.preview = null;
      return { text: 'プレビューを停止しました（ポート ' + port + '）' };
    }
    case 'generate_image': {
      // The coding model does not need image output of its own; a dedicated
      // image model is called here and the bytes land in the workspace.
      const apiKey = await requireKey(env, 'openrouter');
      const catalogue = await fetchImageModels(env).catch(() => []);
      const picked = pickImageModel(catalogue, {
        model: args.model,
        purpose: args.purpose,
        fallback: options.imageModel,
      });
      if (!picked.model) return { text: '画像モデルの一覧を取得できませんでした' };

      const { body } = buildImageRequest(picked.model, {
        prompt: args.prompt,
        n: 1,
        aspectRatio: args.aspect_ratio,
        outputFormat: picked.format || undefined,
      });
      const res = await generateImages(apiKey, body);
      const [image] = imagesFrom(res);
      if (!image) return { text: '画像を生成できませんでした: ' + String(args.prompt).slice(0, 80) };

      const path = fixExtension(args.path, picked.format);
      const out = await writeBinary(sandbox, path, image.bytes);
      state.images = (state.images || 0) + 1;
      return {
        text:
          '画像を生成しました: ' + out.path + '（' + Math.round(out.bytes / 1024) + 'KB）\n' +
          'モデル: ' + picked.model.id + '（選定理由: ' + picked.why + '）',
        meta: { path: out.path, model: picked.model.id, purpose: args.purpose || null, prompt: args.prompt },
      };
    }
    case 'generate_video': {
      const apiKey = await requireKey(env, 'openrouter');
      const catalogue = await fetchVideoModels(env).catch(() => []);
      const picked = pickVideoModel(catalogue, { model: args.model, purpose: args.purpose });
      if (!picked.model) return { text: '動画モデルの一覧を取得できませんでした' };
      const spec = picked.model;

      // Only forward what this particular model declares it accepts.
      const payload = { model: spec.id, prompt: String(args.prompt || '') };
      const seconds = Number(args.duration) || 0;
      if (seconds && spec.durations.includes(seconds)) payload.duration = seconds;
      else if (spec.durations.length) payload.duration = spec.durations.includes(5) ? 5 : spec.durations[0];
      if (args.resolution && spec.resolutions.includes(args.resolution)) payload.resolution = args.resolution;
      else if (spec.resolutions.length) payload.resolution = spec.resolutions.includes('720p') ? '720p' : spec.resolutions[0];
      if (args.aspect_ratio && spec.aspectRatios.includes(args.aspect_ratio)) payload.aspect_ratio = args.aspect_ratio;
      if (spec.generateAudio && args.with_audio) payload.generate_audio = true;

      const estimate = applyDiscount(
        estimateVideoCost(spec, {
          resolution: payload.resolution,
          duration: payload.duration,
          generateAudio: payload.generate_audio,
        }),
        spec.discount
      );

      let job;
      try {
        job = await submitVideoJob(apiKey, payload);
      } catch (e) {
        return { text: '動画ジョブを投入できませんでした: ' + String(e.message).slice(0, 300) };
      }

      // Generation takes minutes; a workflow step has no wall-clock limit, so
      // polling here is fine, but it still gets a ceiling.
      const deadline = Date.now() + 10 * 60 * 1000;
      let status = jobStatusOf(job);
      let latest = job;
      while (['pending', 'in_progress'].includes(status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000));
        try {
          latest = await pollVideoJob(apiKey, job.id);
          status = jobStatusOf(latest);
        } catch {
          /* a transient poll failure should not abandon the job */
        }
      }
      if (status !== 'completed') {
        return { text: '動画が完成しませんでした（状態: ' + status + '）。時間をおいて再度お試しください。' };
      }

      const url = videoUrlFrom(latest);
      if (!url) return { text: '動画のURLを取得できませんでした' };
      const needsAuth = /^https:\/\/openrouter\.ai\//i.test(url);
      const res = await fetch(url, {
        headers: needsAuth ? { authorization: 'Bearer ' + apiKey } : {},
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) return { text: '動画をダウンロードできませんでした (' + res.status + ')' };
      const bytes = new Uint8Array(await res.arrayBuffer());

      const out = await writeBinary(sandbox, fixExtension(args.path, 'mp4'), bytes);
      return {
        text:
          '動画を生成しました: ' + out.path + '（' + Math.round(out.bytes / 1024 / 1024 * 10) / 10 + 'MB, ' +
          payload.duration + '秒 ' + (payload.resolution || '') + '）\n' +
          'モデル: ' + spec.id + '（選定理由: ' + picked.why + '）' +
          (estimate ? ' / 概算 $' + estimate.toFixed(4) : ''),
        meta: { path: out.path, model: spec.id, purpose: args.purpose || null, cost: estimate },
      };
    }
    case 'generate_speech': {
      const catalogue = await fetchSpeechModels(env).catch(() => []);
      const picked = pickSpeechModel(catalogue, { model: args.model, purpose: args.purpose });
      if (!picked.model) return { text: '読み上げモデルの一覧を取得できませんでした' };

      const groq = isGroqSpeech(picked.model.id);
      const apiKey = await requireKey(env, groq ? 'groq' : 'openrouter');
      const format = /\.wav$/i.test(String(args.path || '')) ? 'wav' : 'mp3';

      let out;
      try {
        out = await synthesize(apiKey, picked.model.id, {
          text: String(args.text || ''),
          voice: args.voice,
          format,
          provider: groq ? 'groq' : 'openrouter',
        });
      } catch (e) {
        return { text: '読み上げに失敗しました: ' + String(e.message).slice(0, 300) };
      }

      const saved = await writeBinary(sandbox, fixExtension(args.path, format), out.bytes);
      const cost = picked.model.perMillionChars
        ? (String(args.text || '').length / 1e6) * picked.model.perMillionChars
        : null;
      return {
        text:
          '音声を生成しました: ' + saved.path + '（' + Math.round(saved.bytes / 1024) + 'KB）\n' +
          'モデル: ' + picked.model.id + '（選定理由: ' + picked.why + '）' +
          (cost ? ' / 概算 $' + cost.toFixed(5) : ''),
        meta: { path: saved.path, model: picked.model.id, purpose: args.purpose || null, cost },
      };
    }
    case 'list_models': {
      try {
        const out = await listModels(env, args.kind, { query: args.query, limit: args.limit });
        return { text: out.text, meta: { kind: out.kind, total: out.total, shown: out.shown } };
      } catch (e) {
        return { text: String(e.message).slice(0, 300) };
      }
    }
    case 'search_x': {
      const query = String(args.query || '').trim();
      if (!query) return { text: 'query が必要です' };

      let apiKey;
      try {
        apiKey = await xaiKey(env);
      } catch (e) {
        return { text: String(e.message) };
      }

      let out;
      try {
        out = await searchX(apiKey, {
          query,
          model: args.model,
          fromDate: args.from_date,
          toDate: args.to_date,
          handles: args.handles,
          excludeHandles: args.exclude_handles,
          images: !!args.images,
          videos: !!args.videos,
          alsoWeb: !!args.also_web,
        });
      } catch (e) {
        return { text: String(e.message).slice(0, 400) };
      }

      const cost = estimateSearchCost(out.sourcesUsed);
      return {
        text: formatSearchResult(out),
        meta: { model: out.model, sources: out.sources.length, cost },
      };
    }
    case 'load_skill': {
      const id = String(args.name || '').toLowerCase();
      if (!SKILL_IDS.includes(id)) {
        return { text: '未知のスキルです: ' + id + '（使えるのは ' + SKILL_IDS.join(', ') + '）' };
      }
      // A project can override the guidance; the catalogue is always live.
      const override = await readFileRaw(sandbox, skillPath(id)).catch(() => '');
      const text = await renderSkill(env, id, override);
      state.skills = state.skills || new Set();
      state.skills.add(id);
      return { text, meta: { skill: id, custom: !!String(override || '').trim() } };
    }
    case 'spawn_subagent': {
      if (options.depth) {
        return { text: '下請けエージェントはさらに下請けを立てられません。自分で実行してください。' };
      }

      // The sub-agent may run on a different (usually cheaper) model, named
      // loosely: "glm", "qwen", "安いやつ".
      const catalog = await getCatalog(env).catch(() => ({ models: [] }));
      const chat = (catalog.models || []).filter((m) => m.tools && m.kind === 'chat');
      const wanted = args.model ? resolveModelHint(chat, args.model) : null;
      const provider = wanted?.provider || options.provider || 'openrouter';
      const modelId = wanted?.id || options.model;
      if (!modelId) return { text: 'サブエージェントのモデルを決められませんでした' };

      const apiKey = await requireKey(env, provider);
      const maxSteps = Math.min(Math.max(Number(args.max_steps) || SUBAGENT_MAX_STEPS, 1), 20);

      const system =
        SYSTEM_PROMPT +
        (options.rules || '') +
        '\n\nあなたは下請けのエージェントです。与えられた作業だけを終わらせ、' +
        '最後に「何をしたか」「作ったファイル」を簡潔にまとめて報告してください。' +
        'さらに下請けを立てることはできません。';

      const out = await runLoop({
        provider,
        model: modelId,
        apiKey,
        system,
        task: String(args.task || ''),
        tools: subagentTools(),
        maxSteps,
        temperature: options.temperature,
        // The sub-agent shares the workspace but cannot recurse.
        execute: (n, a) => runTool(env, roomId, n, a, state, onOutput, { ...options, depth: 1 }),
        onEvent: (kind, payload) => options.onSubEvent?.(kind, { ...payload, sub: true, model: modelId }),
      });

      state.subagents = (state.subagents || 0) + 1;
      return {
        text:
          '下請け（' + modelId + ' / ' + out.steps + 'ステップ）の報告:\n' +
          (out.text || '（報告なし）') +
          '\n使ったツール: ' + (out.calls.join(', ') || 'なし') +
          (out.cost ? '\n概算 $' + out.cost.toFixed(4) : ''),
        meta: { model: modelId, steps: out.steps, cost: out.cost, calls: out.calls },
      };
    }
    case 'screenshot': {
      if (!state.preview?.url) return { text: 'プレビューが起動していません。先に start_preview を呼んでください。' };
      const target = new URL(String(args.path || '/'), state.preview.url).toString();
      const shot = await screenshot(env, target, {
        width: Number(args.width) || 1280,
        height: Number(args.height) || 800,
        fullPage: !!args.full_page,
      });
      return {
        text:
          'スクリーンショットを撮りました: ' + target +
          (shot.consoleErrors.length ? '\nコンソールエラー:\n' + shot.consoleErrors.join('\n') : '\nコンソールエラーはありません。'),
        image: { bytes: shot.bytes, mime: 'image/png' },
        meta: { url: target, consoleErrors: shot.consoleErrors },
      };
    }
    default:
      return { text: '未知のツールです: ' + name };
  }
}

