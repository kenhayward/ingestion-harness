from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined


def render_prompt(
    spec_dir: Path, template: str, sections: dict[str, str], section_ids: list[str]
) -> str:
    """Render a spec's Jinja2 prompt. Templates receive `sections` as [{id, text}, ...]."""
    env = Environment(
        loader=FileSystemLoader(spec_dir),
        undefined=StrictUndefined,
        autoescape=False,  # prompts, not HTML
        keep_trailing_newline=True,
    )
    return env.get_template(template).render(
        sections=[{"id": sid, "text": sections[sid]} for sid in section_ids],
    )
