# llama.cpp's own CUDA 12 server image. qwen4exp (Qwen3.8-Flash-Next) arrived
# in b10660 (ggml-org/llama.cpp#27742); b11804 is a later build with the fixes
# since, and with --lazy-mode for the n-gram table. Pinned: the tag is also
# LLAMACPP_IMAGE's in src/lib/runpod.js, so the app names the build it runs.
FROM ghcr.io/ggml-org/llama.cpp:server-cuda-b11804

LABEL org.opencontainers.image.source="https://github.com/AItaro0214/hyperAI-chat" \
      org.opencontainers.image.description="RunPod Serverless worker: llama-server behind RunPod's OpenAI route" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir "runpod>=1.7,<2" "huggingface_hub>=0.30" "httpx>=0.27" "boto3>=1.36"

# Bumped with every change to handler.py. The image tag is <build>-<this>, so
# RunPod's hosts cannot keep running an older handler under an unchanged tag.
ENV WORKER_VERSION=6 \
    LLAMA_SERVER=/app/llama-server \
    PYTHONUNBUFFERED=1

COPY handler.py /handler.py

# The base image starts llama-server directly; the handler starts it instead.
ENTRYPOINT []
CMD ["/opt/venv/bin/python", "/handler.py"]
