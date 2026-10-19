"""`example.label_value@1`: the example recipe plugin of docs/plugins/writing-plugins.md.

It fills a field step's fields from labelled lines such as `Invoice number: INV-4021`: each field
names the label its value follows. It calls no model, so it runs on any project, and the
Workbench can preview it on the dev samples.

The package declares the plugin in `pyproject.toml`:

    [project.entry-points."ct_studio.plugins"]
    label_value = "ct_plugin_example:LABEL_VALUE"
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ingest_worker.nodes import NodeSpec
from ingest_worker.plugins import Plugin, PluginContext, StepData
from ingest_worker.template import PluginStep, Template


class LabelSettings(BaseModel):
    """A step's `with`. `extra="forbid"` is required: a mistyped setting is refused when the
    recipe is published instead of being ignored. The titles and descriptions are what the recipe
    editor shows beside each setting."""

    model_config = ConfigDict(extra="forbid", title="Label settings")

    labels: dict[str, str] = Field(
        title="Labels",
        description="Field id to the label its value follows, at the start of a line.",
    )
    separator: str = Field(
        default=":",
        title="Separator",
        description="What may stand between the label and the value (left out if absent).",
    )


def check(template: Template, step: PluginStep, settings: LabelSettings) -> list[str]:
    """Rules the schema cannot say, against the recipe and the step: each message is shown to
    the recipe's author (at run time, and in the preview)."""
    if step.table is not None:
        return ["fills fields only, not a table"]
    errors = [f"{f!r} is not a field of this step" for f in settings.labels if f not in step.fields]
    errors += [
        f"{f}: the label is empty" for f, label in settings.labels.items() if not label.strip()
    ]
    return errors


_PAGE = re.compile(r"^\[page (\d+)\]$", re.MULTILINE)


def run(ctx: PluginContext, settings: LabelSettings) -> StepData:
    """What an extract step's model would answer: `{field: {value, evidence, page}}`, a missing
    value as None. The worker types the values against the outputs afterwards."""
    text = ctx.text()
    out: dict[str, Any] = {}
    for field in ctx.step.fields:
        label = settings.labels.get(field)
        match = (
            re.search(
                rf"^[ \t]*{re.escape(label)}[ \t]*(?:{re.escape(settings.separator)})?[ \t]*(\S.*)$",
                text,
                re.MULTILINE | re.IGNORECASE,
            )
            if label
            else None
        )
        if match is None:
            out[field] = {"value": None, "evidence": None, "page": None}
            continue
        pages = [int(p.group(1)) for p in _PAGE.finditer(text, 0, match.start())]
        out[field] = {
            "value": match.group(1).strip(),
            "evidence": match.group(0).strip(),
            "page": pages[-1] if pages else None,
        }
    return out


LABEL_VALUE = Plugin(
    spec=NodeSpec(
        id="example.label_value",
        version=1,  # the major: a recipe runs `example.label_value@1`
        fn=run,
        output=StepData,
        effects="pure",
        egress="none",
        cancels_inside=False,
        summary="Fill fields from labelled lines (Label: value); no model call.",
    ),
    settings=LabelSettings,
    check=check,
    run_settings=run,
)
