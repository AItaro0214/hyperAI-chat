"""RunPod Serverless worker: llama-server behind RunPod's OpenAI route.

The app talks to https://api.runpod.ai/v2/<id>/openai/v1, and RunPod turns each
request into a job whose input is {"openai_route": ..., "openai_input": ...} —
the same contract the vLLM worker implements. This does the same for
llama-server, so nothing in the app has to know which engine is behind it.

Configuration comes from the template's environment (see src/lib/runpod.js):
  MODEL_REPO, MODEL_FILE                   what to load
  MODEL_REVISION                           the commit to load it at
  MODEL_CACHE                              "on": look in RunPod's model cache first
  MODEL_INCLUDE                            what to download when it is not there
  R2_ENDPOINT, R2_ACCESS_KEY_ID,           the app's own copy in Cloudflare R2, for
  R2_SECRET_ACCESS_KEY, R2_BUCKET,         when Hugging Face no longer serves the files
  R2_PREFIX                                (scripts/mirror_model.py made it)
  CTX_SIZE, PARALLEL, LAZY_MODE            the llama-server flags that vary
  SERVED_MODEL_NAME                        the name the app sends as `model`
  HF_TOKEN                                 only for gated repositories

The weights come from, in order: RunPod's model cache, Hugging Face, R2.
"""

import collections
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time

import httpx
import runpod
from huggingface_hub import snapshot_download

PORT = 8080
BASE = f"http://127.0.0.1:{PORT}"
MODELS = "/models"
# Where RunPod mounts a cached model: the Hugging Face cache layout.
HF_CACHE = "/runpod-volume/huggingface-cache/hub"
LLAMA_SERVER = os.environ.get("LLAMA_SERVER", "/app/llama-server")
PARALLEL = max(1, int(os.environ.get("PARALLEL", "1")))

# The tail of llama-server's output, so a failed start can say why.
LOG = collections.deque(maxlen=60)

# How this worker started, for the app's 診断 button.
INFO = {"version": os.environ.get("WORKER_VERSION"), "source": None, "path": None, "seconds": {}}
# Startup is timed from here: the process starts once RunPod has the
# container (and any cached model) in place.
PROCESS_START = time.time()
# The key the app reads startup details from, on a reply or a stream chunk.
META_KEY = "hyperai_worker"


def worker_meta():
    """What the app shows under a reply: how this worker got its weights, how
    long it took to become ready, and when — the app compares readyAt with the
    turn's own start to tell a cold start from a worker that was already up."""
    return {
        "source": INFO["source"],
        "startupSeconds": INFO["seconds"].get("startup"),
        "readyAt": INFO.get("readyAt"),
        "version": INFO["version"],
    }


def meta_chunk():
    """One SSE frame carrying worker_meta(). It has no choices, which OpenAI
    clients already expect of the usage frame, so it adds nothing to the text."""
    return "data: " + json.dumps({"object": "chat.completion.chunk", "choices": [], META_KEY: worker_meta()}) + "\n\n"


def env(name, default=""):
    return os.environ.get(name, default)


def shards(first):
    """Every file of a split GGUF, from the path of its first."""
    m = re.search(r"-(\d{5})-of-(\d{5})\.gguf$", first)
    if not m:
        return [first]
    total = int(m.group(2))
    return [first[: m.start()] + f"-{i:05d}-of-{total:05d}.gguf" for i in range(1, total + 1)]


def from_cache():
    """The first shard inside RunPod's model cache, if every shard is there.

    The cache holds the whole repository under snapshots/<revision>/. Files
    appear there only once complete, so a missing shard means the cache is
    absent or still filling, and either way it cannot be used yet."""
    repo = "models--" + env("MODEL_REPO").replace("/", "--")
    snapshots = glob.glob(os.path.join(HF_CACHE, repo, "snapshots", "*"))
    # The pinned commit first; then newest first, in case another is around.
    pinned = env("MODEL_REVISION")
    ordered = sorted(snapshots, key=lambda s: (os.path.basename(s) != pinned, -os.path.getmtime(s)))
    for snap in ordered:
        first = os.path.join(snap, env("MODEL_FILE"))
        if all(os.path.isfile(p) for p in shards(first)):
            return first
    return None


def supports(flag):
    """Whether this build knows a flag. An unknown one stops llama-server
    from starting at all, so optional flags are checked before use."""
    try:
        out = subprocess.run([LLAMA_SERVER, "--help"], capture_output=True, text=True, timeout=60)
        return flag in (out.stdout + out.stderr)
    except Exception:
        return False


def download():
    started = time.time()
    root = snapshot_download(
        repo_id=env("MODEL_REPO"),
        # Pinned, so a download gets exactly what the R2 copy holds.
        revision=env("MODEL_REVISION") or None,
        allow_patterns=[env("MODEL_INCLUDE")],
        local_dir=MODELS,
        token=env("HF_TOKEN") or None,
    )
    INFO["seconds"]["download"] = round(time.time() - started)
    print(f"[worker] downloaded in {INFO['seconds']['download']}s", flush=True)
    return os.path.join(root, env("MODEL_FILE"))


def r2_settings():
    """The R2 copy's settings, or None if they are not all there. A RunPod
    secret that was referenced but never created arrives as its literal
    "{{ RUNPOD_SECRET_… }}" placeholder, which counts as missing."""
    names = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PREFIX"]
    values = {n: env(n).strip() for n in names}
    if any(not v or v.startswith("{{") for v in values.values()):
        return None
    return values


def r2_client(cfg):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=cfg["R2_ENDPOINT"],
        aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        # R2 does not take the CRC checksums newer boto3 sends by default.
        config=Config(
            retries={"max_attempts": 10, "mode": "standard"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def from_r2(cfg):
    """This quant's files from the R2 copy, onto container disk where a
    Hugging Face download would have put them.

    The copy was checked against Hugging Face's sha256 when it was made; here
    each file's size is checked against the manifest, and its hash too when
    R2_VERIFY=1 (minutes for 78 GiB, so off by default)."""
    from boto3.s3.transfer import TransferConfig

    started = time.time()
    s3 = r2_client(cfg)
    bucket, prefix = cfg["R2_BUCKET"], cfg["R2_PREFIX"].strip("/")
    manifest = json.loads(s3.get_object(Bucket=bucket, Key=f"{prefix}/manifest.json")["Body"].read())
    folder = env("MODEL_INCLUDE").split("/")[0]
    files = [f for f in manifest.get("files", []) if f["path"].startswith(folder + "/")]
    if not files:
        raise RuntimeError(f"R2 の控えに {folder} がありません（{bucket}/{prefix}）")

    # Whatever a failed Hugging Face download left behind, out of the way.
    shutil.rmtree(os.path.join(MODELS, ".cache"), ignore_errors=True)
    transfer = TransferConfig(multipart_chunksize=64 * 1024 * 1024, max_concurrency=16)
    for f in files:
        dest = os.path.join(MODELS, f["path"])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        print(f"[worker] R2: {f['path']} ({f['size'] / 1e9:.1f} GB)", flush=True)
        s3.download_file(bucket, f"{prefix}/{f['path']}", dest, Config=transfer)
        size = os.path.getsize(dest)
        if size != f["size"]:
            raise RuntimeError(f"R2 から取った {f['path']} の大きさが違います（{size} / {f['size']}）")
        if env("R2_VERIFY") == "1":
            digest = hashlib.sha256()
            with open(dest, "rb") as fh:
                for chunk in iter(lambda: fh.read(16 * 1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != f["sha256"]:
                raise RuntimeError(f"R2 から取った {f['path']} の sha256 が違います")
    INFO["seconds"]["download"] = round(time.time() - started)
    print(f"[worker] R2 copy downloaded in {INFO['seconds']['download']}s", flush=True)
    return os.path.join(MODELS, env("MODEL_FILE"))


def locate():
    """RunPod's cache when it has the files; otherwise only this quant, from
    Hugging Face; and if Hugging Face no longer has it — deleted, made
    private, or down — from the app's own copy in R2."""
    if env("MODEL_CACHE", "on") == "on":
        cached = from_cache()
        if cached:
            INFO["source"] = "cache"
            return cached
        INFO["cacheMissing"] = True
        print("[worker] not in RunPod's model cache; downloading " + env("MODEL_INCLUDE"), flush=True)
    try:
        path = download()
        INFO["source"] = "download"
        return path
    except Exception as e:  # noqa: BLE001 — 404, 401, a network failure: all mean "try the copy"
        INFO["hfError"] = f"{type(e).__name__}: {str(e)[:300]}"
        print("[worker] Hugging Face failed: " + INFO["hfError"], flush=True)
        cfg = r2_settings()
        if not cfg:
            raise RuntimeError("Hugging Face から取れず、R2 の控えも設定されていません: " + INFO["hfError"]) from e
    INFO["source"] = "r2"
    return from_r2(cfg)


def command(model_path):
    args = [
        LLAMA_SERVER,
        "-m", model_path,
        "--host", "127.0.0.1",
        "--port", str(PORT),
        "--alias", env("SERVED_MODEL_NAME", "breakthrough"),
        # The model's trained length; the template sets it (LLAMACPP_SPEC.maxModelLen).
        "-c", env("CTX_SIZE", "262144"),
        "-np", str(PARALLEL),
        "-ngl", "999",
        # The model's own chat template: thinking, tools and images all live in it.
        "--jinja",
        # Thinking comes back as reasoning_content, which is what the app reads.
        "--reasoning-format", "deepseek",
    ]
    # One pool shared by the slots, so a single long conversation can use all
    # of CTX_SIZE rather than CTX_SIZE / PARALLEL.
    if PARALLEL > 1 and supports("--kv-unified"):
        args.append("--kv-unified")
    if env("LAZY_MODE") and supports("--lazy-mode"):
        args += ["--lazy-mode", env("LAZY_MODE")]
    return args


def start():
    path = locate()
    INFO["path"] = path
    args = command(path)
    INFO["args"] = args[3:]
    try:
        out = subprocess.run([LLAMA_SERVER, "--version"], capture_output=True, text=True, timeout=60)
        INFO["build"] = (out.stdout + out.stderr).strip()[-200:]
    except Exception:  # noqa: BLE001
        pass
    print("[worker] " + " ".join(args), flush=True)
    started = time.time()
    global PROC
    proc = PROC = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

    def pump():
        for line in proc.stdout:
            LOG.append(line.rstrip())
            print(line, end="", flush=True)

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()

    # /health is 503 while the weights load and 200 once a slot can answer.
    while True:
        if proc.poll() is not None:
            # Its last lines — "cudaMalloc failed: out of memory", typically —
            # may still be in the pipe; read them before saying why it stopped.
            reader.join(timeout=5)
            raise RuntimeError(f"llama-server exited ({proc.returncode}):\n" + "\n".join(LOG))
        try:
            if httpx.get(BASE + "/health", timeout=5).status_code == 200:
                INFO["readyAt"] = time.time()
                INFO["seconds"]["load"] = round(INFO["readyAt"] - started)
                INFO["seconds"]["startup"] = round(INFO["readyAt"] - PROCESS_START)
                print(f"[worker] ready ({INFO['source']}) in {INFO['seconds']['load']}s", flush=True)
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)


STARTUP_ERROR = None
PROC = None


def failure(status=None, text="", exc=None):
    """A failed job's output. RunPod keeps only the "error" string, and its
    worker logs cannot be read from outside, so everything needed to explain
    the failure goes into that string: llama-server's own message, whether it
    is still running, and — when something went wrong in it rather than with
    the request — the tail of its log."""
    parts = []
    if status is not None:
        parts.append(f"llama-server {status}: {str(text)[:1500]}")
    if exc is not None:
        parts.append(f"{type(exc).__name__}: {str(exc)[:600]}")
    dead = PROC is not None and PROC.poll() is not None
    if dead:
        parts.append(f"llama-server は終了しています（終了コード {PROC.returncode}）")
    if exc is not None or dead or (status is not None and status >= 500):
        tail = "\n".join(line[:300] for line in list(LOG)[-25:])
        if tail:
            parts.append("--- llama-server log（末尾） ---\n" + tail)
    return {"error": "\n".join(parts)[:4000]}


async def handler(job):
    inp = job.get("input") or {}
    if STARTUP_ERROR:
        yield {"error": "startup failed: " + STARTUP_ERROR, "worker": INFO}
        return
    # Anything raised mid-request — llama-server dying under a stream, a reply
    # that is not JSON — becomes a failure with its reason, not a bare one.
    try:
        async for item in serve(inp):
            yield item
    except Exception as e:  # noqa: BLE001
        print("[worker] job failed: " + repr(e), flush=True)
        yield failure(exc=e)


async def serve(inp):
    async with httpx.AsyncClient(base_url=BASE, timeout=httpx.Timeout(None, connect=10)) as client:
        route = inp.get("openai_route")
        if route:
            body = inp.get("openai_input") or {}
            if route.rstrip("/").endswith("/models"):
                yield (await client.get("/v1/models")).json()
                return
            if body.get("stream"):
                # Passed through as SSE text, as the vLLM worker does: RunPod
                # relays it to the client and keeps it as the job's output,
                # which is where the app recovers lost replies from.
                async with client.stream("POST", route, json=body) as res:
                    if res.status_code != 200:
                        yield failure(res.status_code, (await res.aread()).decode(errors="replace"))
                        return
                    # First, so the reader sees how the worker started as soon
                    # as the reply does.
                    yield meta_chunk()
                    async for line in res.aiter_lines():
                        if line:
                            yield line + "\n\n"
                return
            res = await client.post(route, json=body)
            if res.status_code != 200:
                yield failure(res.status_code, res.text)
                return
            yield {**res.json(), META_KEY: worker_meta()}
            return

        # The native shape, which the app's diagnosis sends:
        # {"prompt": "...", "sampling_params": {"max_tokens": n}, "worker_info": true}
        params = inp.get("sampling_params") or {}
        res = await client.post(
            "/v1/completions",
            json={"prompt": inp.get("prompt") or "", "max_tokens": int(params.get("max_tokens", 16))},
        )
        out = res.json() if res.status_code == 200 else failure(res.status_code, res.text)
        if inp.get("worker_info"):
            out = {**out, "worker": INFO}
        yield out


if __name__ == "__main__":
    # Loaded before the first job is taken, as RunPod expects. A failure is
    # kept rather than raised: a crashing worker is restarted in a loop and its
    # reason is lost, while a job that returns it can be read from the app's
    # 診断 button.
    try:
        start()
    except Exception as e:  # noqa: BLE001
        STARTUP_ERROR = str(e)[-4000:]
        print("[worker] startup failed: " + STARTUP_ERROR, flush=True)

    runpod.serverless.start({
        "handler": handler,
        "concurrency_modifier": lambda _current: PARALLEL,
        # Keeps the whole stream as the job's output, for recovery.
        "return_aggregate_stream": True,
    })
