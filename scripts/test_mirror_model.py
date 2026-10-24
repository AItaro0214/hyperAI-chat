"""Offline checks for mirror_model.py, with Hugging Face and R2 faked.

    python -I scripts/test_mirror_model.py
"""

import argparse
import hashlib
import importlib.util
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("mirror_model", os.path.join(HERE, "mirror_model.py"))
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)

results = []


def check(name, ok, extra=""):
    results.append(ok)
    print(("PASS" if ok else "FAIL") + " - " + name + (" :: " + str(extra) if extra else ""))


REPO = "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF"
REV = "eec4e10a2c29b440a2ae85591fa11569ce752963"
FILES = {
    "IQ3_S/m-00001-of-00002.gguf": os.urandom(1000) * 7,  # 7,000 bytes
    "IQ3_S/m-00002-of-00002.gguf": os.urandom(2500),
}
sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731


class Res:
    def __init__(self, body=b"", data=None, status=200):
        self.body, self.data, self.status_code = body, data, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.data

    def iter_content(self, n):
        for i in range(0, len(self.body), 333):  # uneven chunks, as a network gives
            yield self.body[i:i + 333]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class HF:
    def __init__(self, files, corrupt=None):
        self.files, self.corrupt, self.urls = files, corrupt, []

    def get(self, url, headers=None, stream=False, timeout=None):
        self.urls.append(url)
        if "/api/models/" in url:
            return Res(data=[{"type": "directory", "path": "IQ3_S/sub"}] + [
                {"type": "file", "path": p, "size": len(b), "lfs": {"oid": sha(b), "size": len(b)}} for p, b in self.files.items()
            ])
        path = url.split(f"/resolve/{REV}/")[1]
        body = self.files[path]
        if self.corrupt == path:
            body = body[:-1] + bytes([body[-1] ^ 1])
        return Res(body=body)


class R2:
    def __init__(self):
        self.objects, self.uploads, self.aborted, self.parts_seen, self.deleted = {}, {}, [], [], []

    def create_multipart_upload(self, Bucket, Key):
        uid = f"u{len(self.uploads)}"
        self.uploads[uid] = {}
        return {"UploadId": uid}

    def upload_part(self, Bucket, Key, UploadId, PartNumber, Body):
        self.uploads[UploadId][PartNumber] = Body
        self.parts_seen.append(len(Body))
        return {"ETag": f'"e{PartNumber}"'}

    def complete_multipart_upload(self, Bucket, Key, UploadId, MultipartUpload):
        parts = self.uploads.pop(UploadId)
        numbers = [p["PartNumber"] for p in MultipartUpload["Parts"]]
        assert numbers == sorted(numbers) == list(range(1, len(parts) + 1))
        self.objects[Key] = b"".join(parts[n] for n in numbers)

    def abort_multipart_upload(self, Bucket, Key, UploadId):
        self.aborted.append(Key)

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise KeyError(Key)
        data = self.objects[Key]

        class Body:
            def read(self):
                return data

            def iter_chunks(self, n):
                for i in range(0, len(data), n):
                    yield data[i:i + n]

        return {"Body": Body()}

    def head_object(self, Bucket, Key):
        return {"ContentLength": len(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.objects[Key] = Body

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        self.objects.pop(Key, None)

    def head_bucket(self, Bucket):
        return {}


def args(**kw):
    base = dict(repo=REPO, revision=REV, folder="IQ3_S", bucket="hyperai-models", prefix="", dry_run=False, verify=True)
    base.update(kw)
    return argparse.Namespace(**base)


mm.PART_SIZE = 1024  # small parts so the fakes see several
prefix = f"{REPO}/{REV}"

# Parts
parts = list(mm.read_parts([b"ab", b"cdefg", b"", b"hij"], 4))
check("部分に分ける: 決まった大きさ、最後だけ短い", parts == [b"abcd", b"efgh", b"ij"], parts)

# HF file list
hf = HF(FILES)
files = mm.hf_files(hf, REPO, REV, "IQ3_S")
check("HF のファイル一覧: ファイルだけ、LFS の sha256 つき", [f["path"] for f in files] == list(FILES) and files[0]["sha256"] == sha(FILES["IQ3_S/m-00001-of-00002.gguf"]))

# A full copy
r2 = R2()
mm.PART_SIZE = 1024
manifest = mm.mirror(r2, hf, args(), None)
for path, body in FILES.items():
    check(f"複製: {path.split('/')[-1]} が同じ内容", r2.objects[f"{prefix}/{path}"] == body)
check("  複数の部分で送る（ディスクを使わない）", len(r2.parts_seen) > 2 and max(r2.parts_seen) <= mm.PART_SIZE, r2.parts_seen[:5])
check("  照合済みとして記録する", all(f["verified"] and f["sha256"] == sha(FILES[f["path"]]) for f in manifest["files"]))
stored = json.loads(r2.objects[f"{prefix}/manifest.json"])
check("  manifest.json を R2 に置く", stored["revision"] == REV and len(stored["files"]) == 2)
check("  コミットを固定して取る", all(f"/resolve/{REV}/" in u for u in hf.urls if "/resolve/" in u))

# A rerun skips what is verified
hf2 = HF(FILES)
mm.mirror(r2, hf2, args(), None)
check("再実行: 照合済みのファイルは取り直さない", not any("/resolve/" in u for u in hf2.urls), hf2.urls)

# Corruption in transit is caught and the object removed
r3 = R2()
bad = "IQ3_S/m-00002-of-00002.gguf"
try:
    mm.mirror(r3, HF(FILES, corrupt=bad), args(), None)
    raised = ""
except RuntimeError as e:
    raised = str(e)
check("転送中に壊れたら止めて消す", "sha256" in raised and f"{prefix}/{bad}" in r3.deleted, raised)

# A short download is caught before the upload completes
class Short(HF):
    def get(self, url, **kw):
        res = super().get(url, **kw)
        if "/resolve/" in url:
            res.body = res.body[:-10]
        return res


r4 = R2()
try:
    mm.mirror(r4, Short(FILES), args(), None)
    raised = ""
except RuntimeError as e:
    raised = str(e)
check("途中で切れたら完了させず、アップロードを破棄する", "サイズ" in raised and r4.aborted, raised)

# Reading back finds what the upload did not
r5 = R2()
orig = r5.complete_multipart_upload


def flip(Bucket, Key, UploadId, MultipartUpload):
    orig(Bucket, Key, UploadId, MultipartUpload)
    data = bytearray(r5.objects[Key])
    data[0] ^= 1
    r5.objects[Key] = bytes(data)


r5.complete_multipart_upload = flip
try:
    mm.mirror(r5, HF(FILES), args(), None)
    raised = ""
except RuntimeError as e:
    raised = str(e)
check("R2 から読み戻して違えば止める", "読み戻した" in raised, raised)

# Dry run copies nothing
r6 = R2()
hf6 = HF(FILES)
mm.mirror(r6, hf6, args(dry_run=True), None)
check("試行: 何も書かない", not r6.objects and not any("/resolve/" in u for u in hf6.urls))

# A branch name is refused
try:
    mm.main(["--repo", REPO, "--revision", "main", "--folder", "IQ3_S", "--bucket", "b"])
    refused = False
except SystemExit as e:
    refused = "sha" in str(e)
check("ブランチ名は断る（中身が変わり得る）", refused)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
