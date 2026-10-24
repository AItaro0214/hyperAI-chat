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

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
