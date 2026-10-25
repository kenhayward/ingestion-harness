"""The `decompose` task (phase 3): one conversion batch item, decomposed and delivered.

`run_decompose` reads the item's uploaded Word file from the runs bucket, decomposes it, writes
its report beside it (plan ruling R4) and hands it to `deliver_decomposition` (phase 2), which
decides through the register. The item records the outcome (R3):

- `delivering`, with its register entry, when the bridge took the document: the API settles it
  as `created`, `updated`, `changed_in_target`, `read_back_mismatch` or `failed` from the
  bridge's events (apps/api/src/bridge/register.ts), and the job waits in `delivering` for them;
- otherwise a final outcome at once (`already_loaded`, `duplicate`, `in_flight`,
  `changed_in_target`, `unresolved`, `failed`), and the job succeeds: an outcome was decided.
  Its last event names the outcome. Params that don't validate fail the item they name.

Errors with no outcome (the upload is gone, the converter is down) raise, so the job is retried;
on its last attempt the item is failed with the error, so it never stays `decomposing`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ingest_worker.bridge.models import ActingUser
from ingest_worker.decompose import (
    Decomposition,
    DecompositionFailed,
    DecompositionRejected,
    decompose_docx,
)
from ingest_worker.decompose.deliver import DeliverDeps, DeliveryOutcome, deliver_decomposition
from ingest_worker.decompose.items import UNDECIDED, ConversionItem, ItemOutcome, ItemStore
from ingest_worker.decompose.register import RegisterStore
from ingest_worker.decompose.render import ConverterRenderer, Renderer, RenderFragment
from ingest_worker.errors import DocumentError
from ingest_worker.outcomes import Complete, Delivering, Outcome
from ingest_worker.pipeline import JobCancelled, PipelineDeps, check_cancelled
from ingest_worker.publish_targets import TargetMissing, TargetNotSynced
from ingest_worker.queue import ClaimedJob, JobQueue
from ingest_worker.storage import ObjectStore, decomposition_report_key

#: Who a batch's documents are delivered as when no user queued it (no access control).
NO_USER = ActingUser(id="ct-studio", name="CT Studio", email=None)


class DecomposeParams(BaseModel):
    """jobs.params of a `decompose` job (TS DecomposeParamsSchema)."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    batch_id: str = Field(alias="batchId", min_length=1)
    item_id: str = Field(alias="itemId", min_length=1)
    target_id: str = Field(alias="targetId", min_length=1)
    source_key: str = Field(alias="sourceKey", min_length=1)
    force: bool


@dataclass(frozen=True)
class DecompositionStores:
    """What a worker keeps for `decompose` jobs (PipelineDeps.decomposition)."""

    register: RegisterStore
    items: ItemStore


@dataclass(frozen=True)
class DecomposeDeps:
    store: ObjectStore
    runs_bucket: str
    items: ItemStore
    #: The job's events (the live view) and its cancellation.
    queue: JobQueue
    deliver: DeliverDeps


class NoConverter:
    """A renderer for a worker without CONVERTER_URL: any rendering need fails the document."""

    def render(self, fragment: RenderFragment) -> bytes | None:
        raise DecompositionFailed("rendering needs the document converter (CONVERTER_URL)")


def decompose_deps(deps: PipelineDeps, queue: JobQueue) -> DecomposeDeps:
    """A `decompose` job's dependencies from the worker's."""
    stores, targets, bridge = deps.decomposition, deps.targets, deps.bridge
    if stores is None or targets is None or bridge is None:
        raise DocumentError("this worker has no decomposition register, targets or bridge")

    def target_lookup(target_id: str) -> tuple[str, str | None]:
        target = targets.get(target_id)
        return target.sink_id, target.instance_id

    renderer: Renderer = (
        ConverterRenderer(deps.converter) if deps.converter is not None else NoConverter()
    )
    return DecomposeDeps(
        store=deps.store,
        runs_bucket=deps.buckets.runs,
        items=stores.items,
        queue=queue,
        deliver=DeliverDeps(
            renderer=renderer,
            register=stores.register,
            bridge=bridge,
            target_lookup=target_lookup,
            deployment=deps.deployment,
        ),
    )


def run_decompose(job: ClaimedJob, deps: DecomposeDeps) -> Outcome:
    """Decompose and deliver the job's item, recording its outcome (see the module's doc)."""
    raw = job.params or {}
    try:
        params = DecomposeParams.model_validate(raw)
    except ValidationError as exc:
        reason = f"invalid decompose parameters: {exc}"
        item_id = raw.get("itemId")
        found = deps.items.start(item_id) if isinstance(item_id, str) and item_id else None
        if found is None:
            raise DocumentError(reason) from exc  # no item to tell: a person looks at the job
        return _decided(job, deps, found, DeliveryOutcome("failed", None, None, reason))
    item = deps.items.start(params.item_id)
    if item is None or item.batch_id != params.batch_id:
        raise DocumentError(f"no conversion item {params.item_id} in batch {params.batch_id}")
    if item.outcome not in RUNNABLE:
        # A retry of a run that got as far as a final outcome: there is nothing left to do.
        return Complete(note=f"item {item.id} is already {item.outcome}")
    if params.source_key != item.source_key:
        detail = f"the job's source key {params.source_key} is not the item's ({item.source_key})"
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, detail))
    deps.queue.event(
        job.id, "info", "decomposing", {"itemId": item.id, "sourceKey": item.source_key}
    )
    try:
        return _convert(job, deps, params, item)
    except JobCancelled:
        deps.items.decide(item.id, "failed", "the job was cancelled", None)
        raise
    except TargetNotSynced:
        raise  # the job waits for the target without spending an attempt: nothing is decided
    except Exception as exc:
        if job.attempts >= job.max_attempts:
            deps.items.decide(item.id, "failed", f"{type(exc).__name__}: {exc}", None)
        raise


#: The outcomes a run carries on from: nothing decided yet, or a delivery that may need resuming
#: (the worker stopped after recording it, before the job was handed over).
RUNNABLE: tuple[ItemOutcome, ...] = (*UNDECIDED, "delivering")

#: How an outcome reads in the job's events.
OUTCOME_LABELS: dict[ItemOutcome, str] = {
    "queued": "queued",
    "decomposing": "decomposing",
    "delivering": "delivering",
    "created": "created",
    "updated": "updated",
    "already_loaded": "already loaded",
    "duplicate": "duplicate",
    "in_flight": "in flight",
    "changed_in_target": "changed in target",
    "read_back_mismatch": "read-back mismatch",
    "unresolved": "unresolved",
    "failed": "failed",
}


def _convert(
    job: ClaimedJob, deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem
) -> Outcome:
    data = deps.store.get(deps.runs_bucket, item.object_key)
    try:
        result = decompose_docx(data, renderer=deps.deliver.renderer)
    except DecompositionRejected as exc:
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, f"rejected: {exc}"))
    except DecompositionFailed as exc:
        detail = f"decomposition failed at {exc.at or 'the document'}: {exc.detail}"
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, detail))
    doc = result.document
    deps.queue.event(
        job.id,
        "info",
        "decomposed",
        {"sections": len(doc.sections), "images": len(doc.images), "flags": len(doc.report)},
    )
    report_key = _write_report(deps, item, result)
    deps.queue.event(
        job.id, "info", "report written", {"reportKey": report_key, "flags": len(doc.report)}
    )
    check_cancelled(job, deps.queue)  # nothing is delivered for a cancelled job
    try:
        out = deliver_decomposition(
            deps.deliver,
            data=data,
            source_key=item.source_key,
            target_id=params.target_id,
            started_by=deps.queue.uploader(job.id) or NO_USER,
            batch_id=params.batch_id,
            force=params.force,
            decomposed=result,
        )
    except TargetMissing as exc:
        out = DeliveryOutcome("failed", None, None, str(exc))
    if out.delivery_id is None:
        return _decided(job, deps, item, out)
    recorded = deps.items.decide(item.id, "delivering", out.detail, out.entry_id)
    if not recorded and item.outcome != "delivering":
        # The bridge's event settled the item first: nothing is left to wait for.
        return Complete(note=f"{item.source_key}: settled before it was recorded delivering")
    deps.queue.event(
        job.id,
        "info",
        "delivering",
        {"deliveryId": out.delivery_id, "entryId": out.entry_id, "as": out.outcome},
    )
    return Delivering(
        [],
        [(params.target_id, out.delivery_id)],
        note=f"handed {item.source_key} to the bridge",
    )


def _write_report(deps: DecomposeDeps, item: ConversionItem, result: Decomposition) -> str:
    """The report's flags as JSON beside the source (R4); the item records the key."""
    key = decomposition_report_key(item.batch_id, item.id)
    flags = [flag.model_dump(mode="json", by_alias=True) for flag in result.document.report]
    body = json.dumps({"flags": flags}, ensure_ascii=False).encode("utf-8")
    deps.store.put(deps.runs_bucket, key, body, "application/json")
    deps.items.set_report(item.id, key)
    return key


def _decided(
    job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem, out: DeliveryOutcome
) -> Outcome:
    """A final outcome without a delivery; the job's last event names it. A duplicate's entry is
    another source's, so the item is not linked to it; its detail names that document."""
    entry_id = None if out.outcome == "duplicate" else out.entry_id
    deps.items.decide(item.id, out.outcome, out.detail, entry_id)
    deps.queue.event(
        job.id,
        "warn",
        f"{OUTCOME_LABELS[out.outcome]}: {out.detail}",
        {"outcome": out.outcome, "detail": out.detail},
    )
    return Complete(note=f"{item.source_key}: {out.outcome}")
