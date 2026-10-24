"""RunPod Serverless worker: llama-server behind RunPod's OpenAI route.

The app talks to https://api.runpod.ai/v2/<id>/openai/v1, and RunPod turns each
request into a job whose input is {"openai_route": ..., "openai_input": ...} —
the same contract the vLLM worker implements. This does the same for
llama-server, so nothing in the app has to know which engine is behind it.

Configuration comes from the template's environment (see src/lib/runpod.js):
  MODEL_REPO, MODEL_FILE                   what to load
  MODEL_CACHE                              "on": look in RunPod's model cache first
  MODEL_INCLUDE                            what to download when it is not there
  CTX_SIZE, PARALLEL, LAZY_MODE            the llama-server flags that vary
  SERVED_MODEL_NAME                        the name the app sends as `model`
  HF_TOKEN                                 only for gated repositories
"""

import collections
import glob
import os
import re
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
    # Newest first, in case an older revision is still around.
    for snap in sorted(snapshots, key=os.path.getmtime, reverse=True):
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
        allow_patterns=[env("MODEL_INCLUDE")],
        local_dir=MODELS,
        token=env("HF_TOKEN") or None,
    )
    INFO["seconds"]["download"] = round(time.time() - started)
    print(f"[worker] downloaded in {INFO['seconds']['download']}s", flush=True)
    return os.path.join(root, env("MODEL_FILE"))


def locate():
    """RunPod's cache when it has the files; otherwise only this quant, fetched
    onto container disk — slower, but it still starts."""
    if env("MODEL_CACHE", "on") == "on":
        cached = from_cache()
        if cached:
            INFO["source"] = "cache"
            return cached
        INFO["cacheMissing"] = True
        print("[worker] not in RunPod's model cache; downloading " + env("MODEL_INCLUDE"), flush=True)
    INFO["source"] = "download"
    return download()


def command(model_path):
    args = [
        LLAMA_SERVER,
        "-m", model_path,
        "--host", "127.0.0.1",
        "--port", str(PORT),
        "--alias", env("SERVED_MODEL_NAME", "breakthrough"),
        "-c", env("CTX_SIZE", "32768"),
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
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

    def pump():
        for line in proc.stdout:
            LOG.append(line.rstrip())
            print(line, end="", flush=True)

    threading.Thread(target=pump, daemon=True).start()

    # /health is 503 while the weights load and 200 once a slot can answer.
    while True:
        if proc.poll() is not None:
            raise RuntimeError(f"llama-server exited ({proc.returncode}):\n" + "\n".join(LOG))
        try:
            if httpx.get(BASE + "/health", timeout=5).status_code == 200:
                INFO["seconds"]["load"] = round(time.time() - started)
                print(f"[worker] ready ({INFO['source']}) in {INFO['seconds']['load']}s", flush=True)
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)


STARTUP_ERROR = None


async def handler(job):
    inp = job.get("input") or {}
    if STARTUP_ERROR:
        yield {"error": "startup failed: " + STARTUP_ERROR, "worker": INFO}
        return

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
                        yield {"error": (await res.aread()).decode(errors="replace")[:2000], "status": res.status_code}
                        return
                    async for line in res.aiter_lines():
                        if line:
                            yield line + "\n\n"
                return
            res = await client.post(route, json=body)
            yield res.json() if res.status_code == 200 else {"error": res.text[:2000], "status": res.status_code}
            return

        # The native shape, which the app's diagnosis sends:
        # {"prompt": "...", "sampling_params": {"max_tokens": n}, "worker_info": true}
        params = inp.get("sampling_params") or {}
        res = await client.post(
            "/v1/completions",
            json={"prompt": inp.get("prompt") or "", "max_tokens": int(params.get("max_tokens", 16))},
        )
        out = res.json() if res.status_code == 200 else {"error": res.text[:2000], "status": res.status_code}
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
