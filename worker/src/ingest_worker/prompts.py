from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import ChoiceLoader, Environment, FileSystemLoader, PrefixLoader, StrictUndefined

#: Built-in prompts, addressed as "builtin/<name>" from any spec or template.
BUILTIN_DIR = Path(__file__).parent / "prompt_templates"


def render_prompt(
    spec_dir: Path | None,
    template: str,
    sections: dict[str, str],
    section_ids: list[str],
    chunk: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
    occurrence: dict[str, Any] | None = None,
) -> str:
    """Render a Jinja2 prompt. Templates receive `sections` as [{id, text}, ...], `chunk`
    ({index, count} for chunked extractions, else None), `occurrence` ({index, count, key,
    section} for a step reading a repeating section, else None) and any extra `context`
    variables."""
    env = Environment(
        loader=ChoiceLoader(
            [
                *([FileSystemLoader(spec_dir)] if spec_dir is not None else []),
                PrefixLoader({"builtin": FileSystemLoader(BUILTIN_DIR)}),
            ]
        ),
        undefined=StrictUndefined,
        autoescape=False,  # prompts, not HTML
        keep_trailing_newline=True,
    )
    return env.get_template(template).render(
        **(context or {}),
        sections=[{"id": sid, "text": sections[sid]} for sid in section_ids],
        chunk=chunk,
        occurrence=occurrence,
    )
