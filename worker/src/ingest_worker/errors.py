"""Errors shared across the worker's modules (kept apart so they import without cycles)."""

from __future__ import annotations


class DocumentError(Exception):
    """The document (or spec) can't be processed as-is. Not retried; job goes to needs_review."""
