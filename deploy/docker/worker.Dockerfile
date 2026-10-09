# Build context: repo root.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.10.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONUNBUFFERED=1
WORKDIR /app/worker
COPY worker/pyproject.toml worker/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY worker/src src
RUN uv sync --frozen --no-dev
COPY specs /app/specs
COPY config /app/config
ENV PATH=/opt/venv/bin:$PATH \
    SPECS_DIR=/app/specs \
    LLM_CONFIG=/app/config/llm-providers.yaml
RUN useradd --system --no-create-home worker
USER worker
CMD ["ingest-worker"]
