"""The worker's built-in nodes, described (docs/design/worker-nodes-refactor.md, part 5).

A node is a function a job runs as one step of its graph. Its NodeSpec says what it returns,
what it may write (`effects`) and whether it reaches a model (`egress`), which is what a graph
runtime needs to know to checkpoint, replay or fan out a node safely, and the shape plugins will
follow. Nothing reads NODES at run time yet; tests/test_nodes.py holds each entry to its function.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .extract import ExtractionResult
from .outcomes import apply_outcome
from .pipeline import (
    PageText,
    Selected,
    Source,
    load_source,
    read_pages,
    run_check_with_event,
    segment_pages,
    select_pages,
)
from .segment import Segmented
from .template_pipeline import (
    Finalised,
    GraphDelivery,
    StepOutcome,
    finalise,
    normalise_step,
    run_step,
    write_drafts,
)

#: pure: writes nothing but job events. cacheable: writes only content-keyed caches and the
#: job's audit trail, so running it again is safe. effectful: writes the job's results or
#: deliveries, so a replay must be idempotent.
Effects = Literal["pure", "cacheable", "effectful"]
#: none: no data leaves the worker. model: sends document text or images to a model resolved
#: through JobModels (the data-policy gate). remote: another agent (not yet).
Egress = Literal["none", "model", "remote"]


@dataclass(frozen=True)
class NodeSpec:
    id: str
    version: int
    fn: Callable[..., Any]
    #: What `fn` returns (its return annotation).
    output: Any
    effects: Effects
    egress: Egress
    #: The node stops at safe points of its own (between OCR pages, before each model call),
    #: besides the one run_nodes gives it before it starts.
    cancels_inside: bool
    summary: str


_NONE = type(None)

NODES: dict[str, NodeSpec] = {
    spec.id: spec
    for spec in [
        NodeSpec(
            "source.load", 1, load_source, Source, "cacheable", "none", False,
            "Read the uploaded file; convert a .docx to PDF (cached by file and converter).",
        ),
        NodeSpec(
            "read.pages", 1, read_pages, PageText, "cacheable", "model", True,
            "Text layer, page-count check, OCR of the pages with too little text (cached).",
        ),
        NodeSpec(
            "layout.select", 1, select_pages, Selected, "pure", "none", False,
            "Keep one copy, refuse a document without text, add page markers.",
        ),
        NodeSpec(
            "layout.segment", 1, segment_pages, Segmented, "pure", "none", False,
            "Cut the pages into the layout's sections and repeating occurrences.",
        ),
        NodeSpec(
            "extract.step", 1, run_step, ExtractionResult, "cacheable", "model", False,
            "One extract step: prompt, schema-checked model call with retries, step run record.",
        ),
        NodeSpec(
            "extract.normalise", 1, normalise_step, StepOutcome, "pure", "none", False,
            "Type a step's reply into values and list what could not be normalised.",
        ),
        NodeSpec(
            "check.rules", 1, run_check_with_event, dict[str, Any], "pure", "none", False,
            "Match a check step's values against its reference values.",
        ),
        NodeSpec(
            "document.finalise", 1, finalise, Finalised, "cacheable", "none", False,
            "Graph, shapes check (report kept) and rendered outputs of a document.",
        ),
        NodeSpec(
            "document.write_drafts", 1, write_drafts, _NONE, "effectful", "none", False,
            "Put a draft's outputs in the outputs bucket.",
        ),
        NodeSpec(
            "job.apply_outcome", 1, apply_outcome, _NONE, "effectful", "none", True,
            "Write the job's status; deliver an extraction that needs no review.",
        ),
        NodeSpec(
            "graph.deliver", 1, GraphDelivery.deliver, _NONE, "effectful", "none", False,
            "Publish a document's graph: its versioned copy to the target, then the store.",
        ),
    ]
}  # fmt: skip
