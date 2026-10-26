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

# CPU-only torch first, so the Docling install below does not pull the CUDA build.
RUN uv pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.1 torchvision==0.29.1

WORKDIR /app
COPY pyproject.toml ./
COPY layout_service layout_service
RUN uv pip install ".[docling]"

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
