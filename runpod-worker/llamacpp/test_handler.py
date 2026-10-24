"""Checks the parts of handler.py that run before llama-server does: finding
the model in RunPod's cache, and falling back when it is not there.

    python -I runpod-worker/llamacpp/test_handler.py

Needs none of the worker's packages; they are stubbed, since nothing here
reaches them.
"""

import importlib.util
import os
import sys
import tempfile
import types

for name in ("httpx", "runpod", "huggingface_hub"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["huggingface_hub"].snapshot_download = lambda **kw: kw["local_dir"]

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("handler", os.path.join(HERE, "handler.py"))
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)

REPO = "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF"
FILE = "IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002.gguf"
results = []


def check(name, ok, extra=""):
    results.append(ok)
    print(("PASS" if ok else "FAIL") + " - " + name + (" :: " + str(extra) if extra else ""))


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").close()


os.environ.update(MODEL_REPO=REPO, MODEL_FILE=FILE, MODEL_INCLUDE="IQ3_S/*", MODEL_CACHE="on")

check(
    "分割ファイルを全部挙げる",
    handler.shards("/x/a-00001-of-00002.gguf") == ["/x/a-00001-of-00002.gguf", "/x/a-00002-of-00002.gguf"],
)
check("分割でなければ 1 本", handler.shards("/x/a.gguf") == ["/x/a.gguf"])

with tempfile.TemporaryDirectory() as root:
    handler.HF_CACHE = os.path.join(root, "hub")
    handler.MODELS = os.path.join(root, "models")
    snap = os.path.join(handler.HF_CACHE, "models--SC117--Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF", "snapshots", "abc123")

    check("キャッシュが無ければ None", handler.from_cache() is None)

    touch(os.path.join(snap, FILE))
    check("1 本目だけでは使わない（まだ保存中）", handler.from_cache() is None)

    touch(os.path.join(snap, FILE.replace("00001-of", "00002-of")))
    found = handler.from_cache()
    check("2 本そろえばキャッシュを使う", found == os.path.join(snap, FILE), found)

    handler.INFO.update(source=None)
    path = handler.locate()
    check("  起動元は cache", handler.INFO["source"] == "cache" and path == found, handler.INFO["source"])

    os.environ["MODEL_CACHE"] = "off"
    handler.INFO.update(source=None)
    path = handler.locate()
    check("キャッシュ不使用ならダウンロード", handler.INFO["source"] == "download", handler.INFO["source"])
    check("  コンテナのディスクに置く", path == os.path.join(handler.MODELS, FILE), path)

    os.environ["MODEL_CACHE"] = "on"
    os.remove(os.path.join(snap, FILE))
    handler.INFO.update(source=None)
    handler.locate()
    check(
        "キャッシュが欠けていればダウンロードに切り替える",
        handler.INFO["source"] == "download" and handler.INFO.get("cacheMissing") is True,
        handler.INFO,
    )

import json  # noqa: E402

handler.INFO.update(source="cache", readyAt=1760000000.5, seconds={"startup": 42, "load": 40})
meta = handler.worker_meta()
check(
    "返答に付ける起動情報",
    meta["source"] == "cache" and meta["startupSeconds"] == 42 and meta["readyAt"] == 1760000000.5,
    meta,
)
frame = handler.meta_chunk()
check("  SSE の 1 フレームになる", frame.startswith("data: ") and frame.endswith("\n\n"), frame)
body = json.loads(frame[len("data: "):])
check("  本文を持たない（choices が空）", body["choices"] == [] and body["object"] == "chat.completion.chunk")
check("  アプリが読むキーに入れる", body[handler.META_KEY] == meta and handler.META_KEY == "hyperai_worker")

# A failed job's reason: all RunPod keeps is the "error" string.
handler.LOG.clear()
handler.LOG.extend(["load_tensors: ok", "CUDA error: out of memory"])
handler.PROC = None
f = handler.failure(400, '{"error":{"message":"request (34479 tokens) exceeds the available context size"}}')
check("失敗: llama-server の理由を残す", f["error"].startswith("llama-server 400:") and "34479" in f["error"], f)
check("  要求の誤り（4xx）にはログを付けない", "log" not in f["error"], f)
f = handler.failure(500, "internal")
check("  5xx はログの末尾を付ける", "CUDA error: out of memory" in f["error"], f)


class Dead:
    returncode = -9

    def poll(self):
        return -9


handler.PROC = Dead()
f = handler.failure(exc=ConnectionError("refused"))
check("  例外は種類と内容を残す", "ConnectionError: refused" in f["error"], f)
check("  落ちていればそう言う", "終了コード -9" in f["error"] and "CUDA error" in f["error"], f)
check("  長すぎない", len(handler.failure(500, "x" * 10000)["error"]) <= 4000)
handler.PROC = None

# Out of memory at startup: llama-server prints why and exits. The reason has
# to reach the job's error, since RunPod's own logs cannot be read from outside.
import asyncio  # noqa: E402


class HTTPError(Exception):
    pass


def refused(*_a, **_k):
    raise HTTPError("connection refused")


handler.httpx.HTTPError = HTTPError
handler.httpx.get = refused

with tempfile.TemporaryDirectory() as root:
    fake = os.path.join(root, "fake_server.py")
    with open(fake, "w", encoding="utf-8") as f:
        f.write(
            "import sys\n"
            "print('load_tensors: offloading 48 repeating layers to GPU')\n"
            "print('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 7680.00 MiB on device 0: "
            "cudaMalloc failed: out of memory')\n"
            "print('llama_init_from_model: failed to initialize the context')\n"
            "sys.exit(1)\n"
        )
    saved = (handler.locate, handler.command, handler.LLAMA_SERVER)
    handler.locate = lambda: "/models/x-00001-of-00002.gguf"
    handler.command = lambda path: [sys.executable, fake]
    handler.LLAMA_SERVER = sys.executable  # for --version only
    handler.LOG.clear()
    err = None
    try:
        handler.start()
    except RuntimeError as e:
        err = str(e)
    check("起動時のメモリ不足: 理由を最後の行まで上げる", bool(err) and "exited (1)" in err and "out of memory" in err and "failed to initialize" in err, err)

    handler.STARTUP_ERROR = (err or "")[-4000:]

    async def collect():
        job = {"input": {"openai_route": "/v1/chat/completions", "openai_input": {"stream": True}}}
        return [item async for item in handler.handler(job)]

    out = asyncio.run(collect())
    check("  以後のジョブはその理由で失敗する", len(out) == 1 and out[0]["error"].startswith("startup failed:") and "out of memory" in out[0]["error"], out)
    handler.STARTUP_ERROR = None
    handler.locate, handler.command, handler.LLAMA_SERVER = saved
    handler.PROC = None

# ----------------------------- the R2 copy ---------------------------------
# Hugging Face gone (deleted, private, down): the worker starts from the app's
# own copy in R2. boto3 is stubbed; the fake bucket holds the two shards and
# the manifest mirror_model.py writes.
import hashlib  # noqa: E402
import io  # noqa: E402
import time  # noqa: E402

SHARD1 = b"first shard " * 50
SHARD2 = b"second shard " * 30
PREFIX = REPO + "/eec4e10a2c29b440a2ae85591fa11569ce752963"
FILE2 = FILE.replace("00001-of", "00002-of")


class FakeS3:
    def __init__(self, objects):
        self.objects, self.downloads = objects, []

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.objects[Key])}

    def download_file(self, bucket, key, dest, Config=None):
        self.downloads.append(key)
        with open(dest, "wb") as fh:
            fh.write(self.objects[key])


def bucket(manifest_overrides=None, shard2=SHARD2):
    files = [
        {"path": FILE, "size": len(SHARD1), "sha256": hashlib.sha256(SHARD1).hexdigest()},
        {"path": FILE2, "size": len(SHARD2), "sha256": hashlib.sha256(SHARD2).hexdigest()},
    ]
    for f in files:
        f.update((manifest_overrides or {}).get(f["path"], {}))
    return FakeS3({
        PREFIX + "/manifest.json": json.dumps({"files": files}).encode(),
        PREFIX + "/" + FILE: SHARD1,
        PREFIX + "/" + FILE2: shard2,
    })


boto3 = types.ModuleType("boto3")
boto3.s3 = types.ModuleType("boto3.s3")
boto3.s3.transfer = types.ModuleType("boto3.s3.transfer")
boto3.s3.transfer.TransferConfig = lambda **kw: kw
botocore = types.ModuleType("botocore")
botocore.config = types.ModuleType("botocore.config")
botocore.config.Config = lambda **kw: kw
sys.modules.update({
    "boto3": boto3, "boto3.s3": boto3.s3, "boto3.s3.transfer": boto3.s3.transfer,
    "botocore": botocore, "botocore.config": botocore.config,
})
CURRENT = {"s3": None}
boto3.client = lambda *a, **kw: CURRENT["s3"]


def hf_gone(**kw):
    raise RuntimeError("404 Client Error: Repository Not Found")


R2_ENV = {
    "R2_ENDPOINT": "https://acct.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "id",
    "R2_SECRET_ACCESS_KEY": "secret",
    "R2_BUCKET": "hyperai-models",
    "R2_PREFIX": PREFIX,
}

with tempfile.TemporaryDirectory() as root:
    handler.HF_CACHE = os.path.join(root, "hub")  # empty: no RunPod cache
    handler.MODELS = os.path.join(root, "models")
    saved_download = handler.snapshot_download
    handler.snapshot_download = hf_gone
    os.environ.update(R2_ENV)
    os.environ.pop("R2_VERIFY", None)

    CURRENT["s3"] = bucket()
    handler.INFO.update(source=None)
    handler.INFO.pop("hfError", None)
    path = handler.locate()
    check("HF が消えたら R2 の控えから取る", handler.INFO["source"] == "r2" and path == os.path.join(handler.MODELS, FILE), handler.INFO["source"])
    check("  2 本とも、HF と同じ場所に置く", open(os.path.join(handler.MODELS, FILE2), "rb").read() == SHARD2)
    check("  HF の失敗の理由を残す", "404" in handler.INFO.get("hfError", ""), handler.INFO.get("hfError"))

    # A size that does not match the manifest is not started on.
    CURRENT["s3"] = bucket(shard2=SHARD2[:-5])
    try:
        handler.locate()
        err = ""
    except RuntimeError as e:
        err = str(e)
    check("  大きさが違えば起動しない", "大きさ" in err, err)

    # With R2_VERIFY=1, the hash too.
    os.environ["R2_VERIFY"] = "1"
    CURRENT["s3"] = bucket({FILE2: {"sha256": "0" * 64}})
    try:
        handler.locate()
        err = ""
    except RuntimeError as e:
        err = str(e)
    check("  R2_VERIFY=1 なら sha256 も照合する", "sha256" in err, err)
    CURRENT["s3"] = bucket()
    check("  正しければ通る", handler.locate() == os.path.join(handler.MODELS, FILE))
    os.environ.pop("R2_VERIFY", None)

    # A RunPod secret referenced but never created arrives as its placeholder.
    os.environ["R2_SECRET_ACCESS_KEY"] = "{{ RUNPOD_SECRET_hyperai_r2_secret_access_key }}"
    check("未作成の RunPod secret は設定なしとみなす", handler.r2_settings() is None)
    try:
        handler.locate()
        err = ""
    except RuntimeError as e:
        err = str(e)
    check("  HF も R2 も無ければ、両方の理由で失敗する", "R2" in err and "404" in err, err)

    # Hugging Face still there: R2 is not touched.
    os.environ.update(R2_ENV)
    handler.snapshot_download = saved_download
    CURRENT["s3"] = bucket()
    handler.INFO.update(source=None)
    handler.locate()
    check("HF が使えるうちは R2 を使わない", handler.INFO["source"] == "download" and CURRENT["s3"].downloads == [])

    # RunPod's cache: the pinned commit is preferred over a newer snapshot.
    os.environ["MODEL_REVISION"] = "eec4e10a2c29b440a2ae85591fa11569ce752963"
    snaps = os.path.join(handler.HF_CACHE, "models--SC117--Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF", "snapshots")
    for rev in ("eec4e10a2c29b440a2ae85591fa11569ce752963", "ffff000000000000000000000000000000000000"):
        touch(os.path.join(snaps, rev, FILE))
        touch(os.path.join(snaps, rev, FILE2))
        time.sleep(0.01)
    check("キャッシュ: 固定したコミットを優先する", "eec4e10a" in (handler.from_cache() or ""), handler.from_cache())
    for k in R2_ENV:
        os.environ.pop(k, None)
    os.environ.pop("MODEL_REVISION", None)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
