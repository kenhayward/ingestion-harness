"""The built-in extraction prompt stays byte-identical for recipes without repeating sections, so
their step-cache keys stay valid (spec 2026-10-16, repeating sections)."""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest_worker.prompts import render_prompt
from ingest_worker.template import Template, compile_step

from .test_template_pipeline import TEMPLATE

GOLDEN = Path(__file__).parent / "fixtures" / "prompts"


@pytest.mark.parametrize("step_id", ["header", "data"])
def test_builtin_prompt_unchanged_without_occurrence(step_id: str) -> None:
    t = Template.model_validate(TEMPLATE)
    ex = compile_step(t, next(s for s in t.extract_steps() if s.id == step_id))
    context = {**(ex.prompt_context or {}), "source_file": "doc.pdf"}
    sections = {"head": "[page 1]\nProduct: X", "body": "[page 2]\nBODY\nG1 1"}
    chunk = {"index": 1, "count": 2} if step_id == "data" else None
    prompt = render_prompt(None, ex.prompt, sections, ex.sections, chunk, context)
    path = GOLDEN / f"{step_id}.md"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(prompt, encoding="utf-8", newline="")
        pytest.fail(f"golden written to {path}; re-run")
    assert prompt == path.read_text(encoding="utf-8", newline="")
