"""The build's calendar version (ADR 0014), set by worker.Dockerfile from the deploy's build args."""

from __future__ import annotations

import os


def app_version() -> str:
    """`APP_VERSION`, else `dev` (a build nobody versioned, e.g. on a developer's machine)."""
    return os.environ.get("APP_VERSION") or "dev"
