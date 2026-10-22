"""The naming inputs of a document's package (`package.naming`): what a sink's name patterns
resolve against (the bridge resolves them). Held in step with `namingInputs` in
packages/bridge-contract/src/naming.ts by the shared fixture `naming.json`."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def _text(value: Any) -> str | None:
    """A field value as a naming input: none for null, a blank, or a structured value."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value or None
    if isinstance(value, int | float):
        return _number(value)
    if isinstance(value, list):
        items = [t for t in (_text(v) for v in value) if t is not None]
        return ", ".join(items) if items else None
    return None


def _number(value: int | float) -> str:
    """As JavaScript's String(n) writes it: `42`, `0.5`, `3` for 3.0."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return repr(value)


def naming_inputs(
    *,
    fields: dict[str, Any],
    job_id: str,
    recipe_id: str,
    recipe_version: int,
    source_filename: str,
    source_sha256: str,
    published_at: datetime,
) -> dict[str, str]:
    """Each field's value as text (`field:<id>`), the source, the recipe, the job and the UTC
    publishing date."""
    out: dict[str, str] = {}
    for field_id, f in fields.items():
        text = _text(f.get("value") if isinstance(f, dict) else None)
        if text is not None:
            out[f"field:{field_id}"] = text
    dot = source_filename.rfind(".")
    out["source.filename"] = source_filename
    out["source.stem"] = source_filename[:dot] if dot > 0 else source_filename
    out["source.sha256"] = source_sha256
    out["recipe.id"] = recipe_id
    out["recipe.version"] = str(recipe_version)
    out["job.id"] = job_id
    out["date"] = published_at.astimezone(UTC).date().isoformat()
    return out
