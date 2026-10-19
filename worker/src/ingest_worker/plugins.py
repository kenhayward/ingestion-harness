"""Recipe plugins (docs/design/recipe-plugins.md): capabilities a recipe's `plugin` step runs
instead of a model call.

A plugin is a node (ADR 0018) with settings: its `settings` model checks the step's `with`, and
`run` returns what an extract step's model would (`{field: {value, evidence, page}}`, or
`{rows: [...]}` for a table), which `normalise_step` then types. A plugin reads only what
`PluginContext` gives it, and reaches a model only through `JobModels` (none does yet).
Plugins run in the worker process with its privileges: only plugins installed in the worker image
run, and a third party's capability belongs behind A2A instead (ADR 0018).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import DocumentError
from .nodes import NodeSpec
from .pipeline import JobModels
from .queue import ClaimedJob
from .template import PluginStep, Template

#: A plugin step's reply: what an extract step's model returns.
StepData = dict[str, Any]


@dataclass(frozen=True)
class PluginContext:
    """Everything a plugin may read: the job, the recipe and its step, the text of the step's
    sections (page markers included), the step's `context` values as a prompt would show them,
    an advisory job event, and models through the data-policy gate (egress "model" only)."""

    job: ClaimedJob
    template: Template
    step: PluginStep
    #: Section id -> text, for the step's sections.
    sections: Mapping[str, str]
    #: `context_values`: `{name, path, text}` for each of the step's `context` entries.
    context: list[dict[str, str]]
    event: Callable[[str, dict[str, Any]], None]
    models: JobModels | None = None

    def text(self) -> str:
        """The step's sections in its own order, one after the other."""
        return "\n".join(self.sections.get(i, "") for i in self.step.sections)


@dataclass(frozen=True)
class Plugin:
    spec: NodeSpec
    #: The model of a step's `with` (extra keys refused); its JSON Schema is what the catalogue
    #: publishes (slice 3b).
    settings: type[BaseModel]
    #: Rules beyond the schema, against the recipe and the step (messages; empty: fine).
    check: Callable[[Template, PluginStep, Any], list[str]]
    run_settings: Callable[[PluginContext, Any], StepData]

    def settings_for(self, template: Template, step: PluginStep) -> Any:
        """The step's `with` as this plugin's settings; ValueError says what is wrong."""
        try:
            settings = self.settings.model_validate(step.with_)
        except ValidationError as exc:
            raise ValueError(
                "; ".join(
                    f"{'.'.join(map(str, e['loc'])) or 'with'}: {e['msg']}" for e in exc.errors()
                )
            ) from exc
        if errors := self.check(template, step, settings):
            raise ValueError("; ".join(errors))
        return settings

    def run(self, ctx: PluginContext, settings: Any) -> StepData:
        return self.run_settings(ctx, settings)


@dataclass(frozen=True)
class ResolvedPlugin:
    plugin: Plugin
    settings: Any


def resolve_plugins(template: Template) -> dict[str, ResolvedPlugin]:
    """Every plugin step's plugin and settings, by step id, before the job calls any model: a
    plugin this worker lacks or bad settings is a DocumentError (needs review)."""
    resolved: dict[str, ResolvedPlugin] = {}
    for step in template.plugin_steps():
        plugin = PLUGINS.get(step.uses)
        if plugin is None:
            raise DocumentError(f"step {step.id!r}: no plugin {step.uses} on this worker")
        try:
            resolved[step.id] = ResolvedPlugin(plugin, plugin.settings_for(template, step))
        except ValueError as exc:
            raise DocumentError(f"step {step.id!r}: {step.uses}: {exc}") from exc
    return resolved


# --- text.pattern@1 ----------------------------------------------------------------------------


class PatternSettings(BaseModel):
    """`text.pattern@1`: a field step names a pattern per field; a table step one `row` pattern
    whose named groups are column ids. The titles and descriptions are what the recipe editor
    shows (the catalogue publishes this model's JSON Schema)."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        title="Pattern settings",
        json_schema_extra={
            "description": "Fill a field step's fields, or a table step's rows, by matching "
            "regular expressions in the step's sections."
        },
    )

    patterns: dict[str, str] | None = Field(
        default=None,
        title="Patterns",
        description="For a field step: field id to regular expression. The value is the group "
        "named value, else group 1, else the whole match.",
    )
    row: str | None = Field(
        default=None,
        title="Row pattern",
        description="For a table step: one regular expression per row; its named groups are "
        "column ids.",
    )
    ignore_case: bool = Field(default=False, alias="ignoreCase", title="Ignore case")

    def flags(self) -> int:
        return re.MULTILINE | (re.IGNORECASE if self.ignore_case else 0)


def _compiles(label: str, pattern: str, flags: int) -> tuple[re.Pattern[str] | None, list[str]]:
    try:
        return re.compile(pattern, flags), []
    except re.error as exc:
        return None, [f"{label}: not a regular expression ({exc})"]


def _check_pattern(template: Template, step: PluginStep, s: PatternSettings) -> list[str]:
    errors: list[str] = []
    if step.fields:
        if s.row is not None:
            errors.append("a field step takes patterns, not row")
        if not s.patterns:
            return [*errors, "patterns: give a pattern for at least one field"]
        for name, pattern in s.patterns.items():
            if name not in step.fields:
                errors.append(f"{name!r} is not a field of this step")
            errors += _compiles(name, pattern, s.flags())[1]
        return errors
    if s.patterns:
        errors.append("a table step takes row, not patterns")
    if s.row is None:
        return [*errors, "a table step needs row"]
    compiled, problems = _compiles("row", s.row, s.flags())
    errors += problems
    if compiled is not None and step.table is not None:
        columns = {c.id for c in template.table(step.table).columns}
        errors += [
            f"{g!r} is not a column of {step.table}"
            for g in compiled.groupindex
            if g not in columns
        ]
    return errors


_PAGE = re.compile(r"^\[page (\d+)\]$", re.MULTILINE)


def _found(text: str, match: re.Match[str] | None) -> dict[str, Any]:
    if match is None:
        return {"value": None, "evidence": None, "page": None}
    if "value" in match.re.groupindex:
        value = match.group("value")
    elif match.re.groups:
        value = match.group(1)
    else:
        value = match.group(0)
    start = match.start()
    end = text.find("\n", start)
    line = text[text.rfind("\n", 0, start) + 1 : len(text) if end == -1 else end].strip()
    pages = [int(m.group(1)) for m in _PAGE.finditer(text, 0, start)]
    return {"value": value, "evidence": line, "page": pages[-1] if pages else None}


def _run_pattern(ctx: PluginContext, s: PatternSettings) -> StepData:
    text = ctx.text()
    if ctx.step.fields:
        patterns = s.patterns or {}
        return {
            f: _found(text, re.search(patterns[f], text, s.flags()) if f in patterns else None)
            for f in ctx.step.fields
        }
    rx = re.compile(s.row or "", s.flags())
    return {"rows": [{g: m.group(g) for g in rx.groupindex} for m in rx.finditer(text)]}


TEXT_PATTERN = Plugin(
    spec=NodeSpec(
        "text.pattern", 1, _run_pattern, StepData, "pure", "none", False,
        "Fill fields or a table from the step's sections with regular expressions; no model call.",
    ),
    settings=PatternSettings,
    check=_check_pattern,
    run_settings=_run_pattern,
)  # fmt: skip


def _registry(*plugins: Plugin) -> dict[str, Plugin]:
    return {f"{p.spec.id}@{p.spec.version}": p for p in plugins}


#: The plugins this worker can run, by `<id>@<major>` (a recipe step's `uses`).
PLUGINS: dict[str, Plugin] = _registry(TEXT_PATTERN)
