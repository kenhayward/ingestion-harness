# The layout service (docs/superpowers/specs/2026-10-26-pdf-reader-design.md, section 4.1).
# Build context: deploy/layout. The model weights are downloaded here, at pinned revisions, and
# baked in: the running container never fetches anything (HF_HUB_OFFLINE=1).
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.10.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_SYSTEM_PYTHON=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Docling's PDF backend and torch need these shared libraries on a slim image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# torch first, from PyTorch's own index: the CPU build by default, so the Docling install below
# does not pull the CUDA one; `--build-arg TORCH_INDEX=cu130` makes the GPU image (`layout-gpu`
# in docker-compose.yml, the pdf-reader design, section 16): same versions, CUDA 13 wheels.
ARG TORCH_INDEX=cpu
RUN uv pip install --index-url https://download.pytorch.org/whl/${TORCH_INDEX}     torch==2.14.1 torchvision==0.29.1

WORKDIR /app
# Everything installs at the versions in uv.lock, so the same PDF gives the same output across
# builds. torch, torchvision and the CUDA packages they pull on Linux are left out of the export:
# the build above stays (torch is locked at the same version, which the build checks).
COPY pyproject.toml uv.lock ./
RUN uv export --frozen --extra docling --no-dev --no-hashes --no-emit-project -o /tmp/locked.txt \
    && grep -E '^(torch|torchvision)==' /tmp/locked.txt | sort > /tmp/locked-torch.txt \
    && printf 'torch==2.14.1\ntorchvision==0.29.1\n' | diff - /tmp/locked-torch.txt \
    && grep -v -E '^(torch|torchvision|triton|nvidia-[a-z0-9-]+)==' /tmp/locked.txt > /tmp/requirements.txt \
    && uv pip install -r /tmp/requirements.txt \
    && rm /tmp/locked.txt /tmp/locked-torch.txt /tmp/requirements.txt
COPY layout_service layout_service
RUN uv pip install --no-deps .

# The weights, at exact revisions. The layout model; and TableFormer (accurate mode only, which
# is the only mode the service uses) from the docling-models repository. The directory names are
# the ones Docling looks for under its artifacts path.
ENV MODELS_DIR=/models
RUN python - <<'PY'
from huggingface_hub import snapshot_download

snapshot_download(
    "docling-project/docling-layout-heron",
    revision="8f39ad3c0b4c58e9c2d2c84a38465abf757272d8",
    local_dir="/models/docling-project--docling-layout-heron",
)
snapshot_download(
    "docling-project/docling-models",
    revision="fc0f2d45e2218ea24bce5045f58a389aed16dc23",
    allow_patterns=["model_artifacts/tableformer/accurate/*", "*.md"],
    local_dir="/models/docling-project--docling-models",
)
PY
ENV HF_HUB_OFFLINE=1 \
    HF_HOME=/tmp/hf

RUN useradd --system --no-create-home layout
USER layout
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=12 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["uvicorn", "layout_service.app:main", "--factory", "--host", "0.0.0.0", "--port", "8000"]
