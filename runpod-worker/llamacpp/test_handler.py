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

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
