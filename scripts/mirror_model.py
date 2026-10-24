"""Copies one quant of a Hugging Face GGUF repository into Cloudflare R2.

Breakthrough mode runs a community upload that its author can delete or make
private at any time. This keeps a copy of exactly the files in use, at the
commit in use, so the worker can still start if Hugging Face no longer serves
them (see runpod-worker/llamacpp/handler.py, which falls back to it).

Each file is streamed from Hugging Face straight into an R2 multipart upload
and hashed on the way: nothing touches the disk, which on a GitHub runner is
far smaller than the 55 GB first shard. The hash is compared with the sha256
Hugging Face records for the file (its LFS oid); then, unless --no-verify, the
stored object is read back from R2 and hashed again. R2 charges nothing for
reading out, so the second pass costs only time.

A manifest.json beside the files records each file's size and sha256 once it
is verified. A rerun skips any file already in the manifest at the same size,
so an interrupted run picks up where it stopped (per file, not per part).

    python scripts/mirror_model.py --repo SC117/... --revision <sha> --folder IQ3_S \\
        --bucket hyperai-models [--dry-run] [--no-verify]

Credentials come from the environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY (an R2 API token with read and write on the bucket), and
optionally HF_TOKEN.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import threading
import time

PART_SIZE = 128 * 1024 * 1024  # 55 GB → ~410 parts; R2 allows 10,000
WORKERS = 4  # parts uploading at once; with the queue, ~1.5 GB of memory
READ_SIZE = 8 * 1024 * 1024


def log(*a):
    print("[mirror]", *a, flush=True)


def hf_url(repo, revision, path):
    return f"https://huggingface.co/{repo}/resolve/{revision}/{path}"


def hf_files(session, repo, revision, folder, token=None):
    """The files in one folder at one commit, with their LFS sha256."""
    headers = {"authorization": "Bearer " + token} if token else {}
    res = session.get(f"https://huggingface.co/api/models/{repo}/tree/{revision}/{folder}", headers=headers, timeout=60)
    res.raise_for_status()
    files = []
    for entry in res.json():
        if entry.get("type") != "file":
            continue
        lfs = entry.get("lfs") or {}
        files.append({"path": entry["path"], "size": int(lfs.get("size") or entry["size"]), "sha256": lfs.get("oid")})
    if not files:
        raise SystemExit(f"{repo}@{revision}/{folder} にファイルがありません")
    missing = [f["path"] for f in files if not f["sha256"]]
    if missing:
        raise SystemExit("LFS の sha256 が無いファイルがあります（照合できません）: " + ", ".join(missing))
    return files


def read_parts(chunks, size):
    """Regroups a stream of byte chunks into parts of exactly `size` bytes
    (the last may be shorter), as a multipart upload needs."""
    buf = bytearray()
    for chunk in chunks:
        if not chunk:
            continue
        buf.extend(chunk)
        while len(buf) >= size:
            yield bytes(buf[:size])
            del buf[:size]
    if buf:
        yield bytes(buf)


def put_part(s3, bucket, key, upload_id, number, data, attempts=4):
    for attempt in range(1, attempts + 1):
        try:
            res = s3.upload_part(Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=number, Body=data)
            return number, res["ETag"]
        except Exception as e:  # noqa: BLE001
            if attempt == attempts:
                raise
            log(f"part {number} failed ({e}); retrying")
            time.sleep(2 ** attempt)


def stream_to_r2(s3, session, url, bucket, key, expected_size, headers=None, part_size=None, workers=None):
    """Streams url into bucket/key. Returns (sha256 hex, bytes). Aborts the
    upload on any failure, including a size that does not match."""
    part_size = part_size or PART_SIZE
    workers = workers or WORKERS
    upload_id = s3.create_multipart_upload(Bucket=bucket, Key=key)["UploadId"]
    digest = hashlib.sha256()
    total = 0
    etags = {}
    # Bounds the parts held in memory: reading waits while too many are queued.
    slots = threading.BoundedSemaphore(workers * 2)
    started = time.time()
    try:
        with session.get(url, headers=headers or {}, stream=True, timeout=(30, 300)) as res, \
                concurrent.futures.ThreadPoolExecutor(workers) as pool:
            res.raise_for_status()
            futures = []
            for number, data in enumerate(read_parts(res.iter_content(READ_SIZE), part_size), start=1):
                # A part that failed for good stops the copy now, not 55 GB later.
                for done in (f for f in futures if f.done()):
                    done.result()
                digest.update(data)
                total += len(data)
                slots.acquire()
                future = pool.submit(put_part, s3, bucket, key, upload_id, number, data)
                future.add_done_callback(lambda _f: slots.release())
                futures.append(future)
                if number % 40 == 0:
                    rate = total / max(1, time.time() - started) / 1e6
                    log(f"{key}: {total / 1e9:.1f} / {expected_size / 1e9:.1f} GB ({rate:.0f} MB/s)")
            for future in futures:
                number, etag = future.result()
                etags[number] = etag
        if total != expected_size:
            raise RuntimeError(f"{key}: サイズが違います（{total} / 期待 {expected_size}）")
        s3.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": [{"PartNumber": n, "ETag": etags[n]} for n in sorted(etags)]},
        )
    except BaseException:
        try:
            s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        except Exception:  # noqa: BLE001
            pass
        raise
    return digest.hexdigest(), total


def hash_r2_object(s3, bucket, key):
    """Reads an object back out of R2 and hashes it. Returns (sha256 hex, bytes)."""
    body = s3.get_object(Bucket=bucket, Key=key)["Body"]
    digest = hashlib.sha256()
    total = 0
    for chunk in body.iter_chunks(16 * 1024 * 1024):
        digest.update(chunk)
        total += len(chunk)
    return digest.hexdigest(), total


def read_manifest(s3, bucket, key):
    try:
        return json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    except Exception:  # noqa: BLE001 — absent on the first run
        return None


def object_size(s3, bucket, key):
    try:
        return int(s3.head_object(Bucket=bucket, Key=key)["ContentLength"])
    except Exception:  # noqa: BLE001
        return None


def mirror(s3, session, args, token=None):
    """The whole copy. Returns the manifest written."""
    prefix = args.prefix or f"{args.repo}/{args.revision}"
    manifest_key = f"{prefix}/manifest.json"
    files = hf_files(session, args.repo, args.revision, args.folder, token)
    log(f"{len(files)} files, {sum(f['size'] for f in files) / 1e9:.1f} GB → r2://{args.bucket}/{prefix}/")
    if args.dry_run:
        for f in files:
            log(f"  {f['path']}  {f['size']}  sha256 {f['sha256']}")
        s3.head_bucket(Bucket=args.bucket)  # proves the credentials reach the bucket
        log("dry run: nothing copied")
        return None

    previous = read_manifest(s3, args.bucket, manifest_key) or {}
    done = {f["path"]: f for f in previous.get("files", []) if f.get("verified")}
    out = {"repo": args.repo, "revision": args.revision, "folder": args.folder, "files": []}
    headers = {"authorization": "Bearer " + token} if token else {}

    for f in files:
        key = f"{prefix}/{f['path']}"
        known = done.get(f["path"])
        if known and known.get("sha256") == f["sha256"] and object_size(s3, args.bucket, key) == f["size"]:
            log(f"skip {f['path']} (verified earlier)")
            out["files"].append(known)
            continue

        log(f"copy {f['path']} ({f['size'] / 1e9:.1f} GB)")
        sha, size = stream_to_r2(s3, session, hf_url(args.repo, args.revision, f["path"]), args.bucket, key, f["size"], headers)
        if sha != f["sha256"]:
            s3.delete_object(Bucket=args.bucket, Key=key)
            raise RuntimeError(f"{f['path']}: 転送中の sha256 が Hugging Face と違います（{sha} / {f['sha256']}）。削除しました")
        record = {"path": f["path"], "size": size, "sha256": sha, "copiedAt": int(time.time())}

        if args.verify:
            log(f"verify {f['path']} (reading back from R2)")
            stored, stored_size = hash_r2_object(s3, args.bucket, key)
            if stored != f["sha256"] or stored_size != f["size"]:
                raise RuntimeError(f"{f['path']}: R2 から読み戻した内容が違います（{stored} / {f['sha256']}）")
            record["verified"] = True
            record["verifiedAt"] = int(time.time())
        out["files"].append(record)
        # Written after every file, so an interrupted run keeps what finished.
        s3.put_object(Bucket=args.bucket, Key=manifest_key, Body=json.dumps(out, indent=1).encode(), ContentType="application/json")

    s3.put_object(Bucket=args.bucket, Key=manifest_key, Body=json.dumps(out, indent=1).encode(), ContentType="application/json")
    log("done: " + ", ".join(f"{f['path']} {'verified' if f.get('verified') else 'copied'}" for f in out["files"]))
    return out


def r2_client():
    import boto3
    from botocore.config import Config

    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        # R2 does not take the CRC checksums newer boto3 sends by default.
        config=Config(
            retries={"max_attempts": 10, "mode": "standard"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            max_pool_connections=WORKERS * 2,
        ),
    )


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--repo", required=True)
    p.add_argument("--revision", required=True, help="the commit sha, not a branch")
    p.add_argument("--folder", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--prefix", default="", help="default: <repo>/<revision>")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-verify", dest="verify", action="store_false")
    args = p.parse_args(argv)
    if len(args.revision) < 40:
        raise SystemExit("--revision はコミットの sha（40 文字）で指定してください。ブランチ名だと中身が変わり得ます")

    import requests

    mirror(r2_client(), requests.Session(), args, os.environ.get("HF_TOKEN") or None)


if __name__ == "__main__":
    sys.exit(main())
