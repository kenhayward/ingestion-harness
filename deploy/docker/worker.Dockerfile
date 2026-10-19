# Build context: repo root.
FROM python:3.14-slim
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
# Recipe plugins from packages (docs/plugins/writing-plugins.md): WORKER_PLUGINS is what
# `uv pip install` takes, space-separated (names from an index, git URLs, or packages kept under
# worker/plugins as plugins/<folder>); empty installs none. The worker's locked versions
# constrain them, so a plugin cannot move a dependency the worker was tested with.
COPY worker/plugins plugins
ARG WORKER_PLUGINS=
RUN if [ -n "$WORKER_PLUGINS" ]; then       uv export --frozen --no-dev --no-hashes --no-emit-project -o /tmp/worker-constraints.txt       && uv pip install --python /opt/venv/bin/python -c /tmp/worker-constraints.txt $WORKER_PLUGINS       && rm /tmp/worker-constraints.txt;     fi
COPY specs /app/specs
COPY config /app/config
ENV PATH=/opt/venv/bin:$PATH \
    SPECS_DIR=/app/specs \
    LLM_CONFIG=/app/config/llm-providers.yaml
RUN useradd --system --no-create-home worker
# The build's calendar version (ADR 0014). Last, so a new version reuses every layer above.
ARG APP_VERSION=dev
ARG APP_VERSION_PREVIOUS=
ARG APP_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION     APP_VERSION_PREVIOUS=$APP_VERSION_PREVIOUS     APP_COMMIT=$APP_COMMIT
USER worker
CMD ["ingest-worker"]
