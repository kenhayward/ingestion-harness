"""The `decompose` task (phase 3): one conversion batch item, decomposed and delivered.

`run_decompose` reads the item's uploaded Word file or PDF from the runs bucket, decomposes it,
writes its report beside it (plan ruling R4) and hands a Word file to `deliver_decomposition`
(phase 2), which decides through the register. A PDF is held for review instead (`hold.py`,
spec §14.2): `awaiting_review` with its held files, the job succeeding with "held for review",
unless the register would send nothing, when that outcome is recorded at once, or its batch
has Auto Approve on (`autoApprove` params), when it is delivered as a Word file is. An approved
hold (`approved` params, spec §14.4) is delivered as it was reviewed, without reading the PDF
again, unless the held files or the source are not the reviewed ones, or the register's entry
for the source has changed since the hold; its held files are deleted once it has an outcome.

Before a document is handed to the bridge it takes a lane of its target's tenant (lanes.py,
watched folders plan 2). With none free, its decomposition is stored like a hold, without page
images, and the item waits (`waiting_to_deliver`, the job succeeding with "waiting to deliver");
an approved PDF waits keeping its reviewed files. The dispatcher gives it a lane and queues a
`waited` run, which delivers the stored copy without decomposing again: the register decides
again then (an approved PDF's hold check is not repeated), and the stored copy is deleted once
the item has an outcome. A document holds its lane until its outcome is final.

The item records the outcome (R3):

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

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ingest_worker.bridge.models import ActingUser
from ingest_worker.decompose import (
    Decomposition,
    DecompositionFailed,
    DecompositionRejected,
    Unproven,
    decomposer_version,
    source_kind,
)
from ingest_worker.decompose import (
    decompose_source as decompose_any,
)
from ingest_worker.decompose.deliver import (
    DeliverDeps,
    DeliveryOutcome,
    deliver_decomposition,
    preview_decision,
    refused,
    source_entry,
)
from ingest_worker.decompose.hold import (
    HeldManifest,
    HeldMismatch,
    delete_held,
    read_held,
    write_held,
)
from ingest_worker.decompose.items import UNDECIDED, ConversionItem, ItemOutcome, ItemStore
from ingest_worker.decompose.lanes import LaneStore, lanes_for
from ingest_worker.decompose.pdf.layout import LayoutAnalyser, LayoutUnavailable
from ingest_worker.decompose.pdf.transcript import PageTranscriber, TranscriptionFailed
from ingest_worker.decompose.register import RegisterStore
from ingest_worker.decompose.render import ConverterRenderer, Renderer, RenderFragment
from ingest_worker.errors import DocumentError
from ingest_worker.ocr import render_preview_jpeg
from ingest_worker.outcomes import Complete, Delivering, Outcome
from ingest_worker.pipeline import JobCancelled, JobTranscriber, PipelineDeps, check_cancelled
from ingest_worker.publish_targets import TargetMissing, TargetNotSynced
from ingest_worker.queue import ClaimedJob, JobQueue
from ingest_worker.storage import (
    ObjectStore,
    decomposition_held_manifest_key,
    decomposition_report_key,
)

#: Who a batch's documents are delivered as when no user queued it (no access control).
NO_USER = ActingUser(id="ct-studio", name="CT Studio", email=None)

#: An approved hold whose register entry changed after the hold (spec §14.4a).
STALE_HOLD = "the target's document changed after this was reviewed; run it again"


class DecomposeParams(BaseModel):
    """jobs.params of a `decompose` job (TS DecomposeParamsSchema)."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    batch_id: str = Field(alias="batchId", min_length=1)
    item_id: str = Field(alias="itemId", min_length=1)
    target_id: str = Field(alias="targetId", min_length=1)
    source_key: str = Field(alias="sourceKey", min_length=1)
    force: bool
    #: The reviewer approved the item's held PDF: deliver the held decomposition.
    approved: bool = False
    #: The batch's Auto Approve: a PDF is delivered at once, never held for review.
    auto_approve: bool = Field(False, alias="autoApprove")
    #: The document waited for a lane, which the dispatcher claimed for this run.
    waited: bool = False


@dataclass(frozen=True)
class DecompositionStores:
    """What a worker keeps for `decompose` jobs (PipelineDeps.decomposition)."""

    register: RegisterStore
    items: ItemStore
    lanes: LaneStore


@dataclass(frozen=True)
class DecomposeDeps:
    store: ObjectStore
    runs_bucket: str
    items: ItemStore
    #: The job's events (the live view) and its cancellation.
    queue: JobQueue
    deliver: DeliverDeps
    #: The lane gate of the targets' tenants.
    lanes: LaneStore
    #: How many documents a target's tenant takes at once, by target id.
    target_lanes: Callable[[str], int]
    #: Reads a PDF's layout (None: a PDF fails its item).
    layout: LayoutAnalyser | None = None
    #: The OCR model reading a job's PDF, for its scanned pages (None: a PDF with a scanned
    #: page fails its item; spec 15.1).
    transcriber: Callable[[ClaimedJob, bytes], PageTranscriber] | None = None
    #: The longest side, in pixels, of the page images the OCR model is sent.
    ocr_longest_dim: int = 1288
    #: (pdf, 0-based page) -> JPEG preview for the review screen.
    render_preview: Callable[[bytes, int], bytes] = field(default=render_preview_jpeg)


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

    def target_lanes(target_id: str) -> int:
        return lanes_for(targets.get(target_id))

    renderer: Renderer = (
        ConverterRenderer(deps.converter) if deps.converter is not None else NoConverter()
    )
    transcriber: Callable[[ClaimedJob, bytes], PageTranscriber] | None = None
    if deps.ocr is not None:

        def transcriber(job: ClaimedJob, data: bytes) -> PageTranscriber:
            return JobTranscriber(
                job,
                deps,
                queue,
                data,
                sha256=hashlib.sha256(data).hexdigest(),
                failure=lambda message, page: TranscriptionFailed(message, at=f"page {page}"),
            )

    return DecomposeDeps(
        store=deps.store,
        runs_bucket=deps.buckets.runs,
        items=stores.items,
        queue=queue,
        layout=deps.layout,
        transcriber=transcriber,
        ocr_longest_dim=deps.ocr.longest_dim if deps.ocr is not None else 1288,
        render_preview=deps.render_preview,
        deliver=DeliverDeps(
            renderer=renderer,
            register=stores.register,
            bridge=bridge,
            target_lookup=target_lookup,
            deployment=deps.deployment,
            layout=deps.layout,
        ),
        lanes=stores.lanes,
        target_lanes=target_lanes,
    )


def decompose_source(deps: DecomposeDeps, data: bytes, job: ClaimedJob) -> Decomposition:
    """`data` decomposed as the Word file or PDF it is, a PDF's scanned pages read by the OCR
    model for `job`."""
    return decompose_any(
        data,
        renderer=deps.deliver.renderer,
        layout=deps.layout,
        transcriber=deps.transcriber(job, data) if deps.transcriber is not None else None,
        ocr_longest_dim=deps.ocr_longest_dim,
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
    if params.waited:
        return _from_wait(job, deps, params, item)
    if item.outcome == "waiting_to_deliver":
        # A retry of a run that left its item waiting: the dispatcher's run delivers it.
        return Complete(note=f"item {item.id} is waiting for a lane")
    if params.approved:
        return _approved(job, deps, params, item)
    deps.queue.event(
        job.id, "info", "decomposing", {"itemId": item.id, "sourceKey": item.source_key}
    )
    return _failing_on_error(job, deps, item, lambda: _convert(job, deps, params, item))


def _failing_on_error(
    job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem, run: Callable[[], Outcome]
) -> Outcome:
    """`run()`, failing the item when the job is cancelled or an error ends its last attempt."""
    try:
        return run()
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
RUNNABLE: tuple[ItemOutcome, ...] = (*UNDECIDED, "delivering", "waiting_to_deliver")

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
    "awaiting_review": "awaiting review",
    "rejected": "rejected",
    "waiting_to_deliver": "waiting to deliver",
}


def _convert(
    job: ClaimedJob, deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem
) -> Outcome:
    data = deps.store.get(deps.runs_bucket, item.object_key)
    try:
        result = decompose_source(deps, data, job)
    except LayoutUnavailable as exc:
        if job.attempts < job.max_attempts:
            raise  # the layout service may be back: the job is retried
        detail = f"the layout service could not be reached: {exc}"
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, detail))
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
    if source_kind(data) == "pdf":
        if result.unproven:
            # Words the check could not prove need a person, Auto Approve or not (spec 14.2).
            deps.queue.event(
                job.id,
                "warn",
                f"{_words(len(result.unproven))} not proven: held for review",
                {"unproven": [u.detail for u in result.unproven]},
            )
            return _hold(job, deps, params, item, data, result)
        if not params.auto_approve:
            return _hold(job, deps, params, item, data, result)
        deps.queue.event(job.id, "info", "auto-approved", {"itemId": item.id})
    try:
        claimed = _claim_lane(deps, params, item)
    except TargetMissing as exc:
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, str(exc)))
    if not claimed:
        return _wait(job, deps, item, data, result)
    return _deliver(
        job,
        deps,
        params,
        item,
        data,
        result,
        started_by=deps.queue.uploader(job.id) or NO_USER,
        version=decomposer_version(source_kind(data)),
    )


def _deliver(
    job: ClaimedJob,
    deps: DecomposeDeps,
    params: DecomposeParams,
    item: ConversionItem,
    data: bytes,
    result: Decomposition,
    *,
    started_by: ActingUser,
    version: int,
) -> Outcome:
    """`result`, the decomposition of `data`, delivered through the register as `started_by`;
    the item records the outcome."""
    try:
        out = deliver_decomposition(
            deps.deliver,
            data=data,
            source_key=item.source_key,
            target_id=params.target_id,
            started_by=started_by,
            batch_id=params.batch_id,
            force=params.force,
            decomposed=result,
            decomposer_version=version,
        )
    except TargetMissing as exc:
        out = DeliveryOutcome("failed", None, None, str(exc))
    if out.delivery_id is None:
        return _decided(job, deps, item, out)
    if not deps.items.decide(item.id, "delivering", out.detail, out.entry_id):
        # The bridge's event settled the item first (also on a retry resuming its delivery,
        # which records `delivering` again): nothing is left to wait for.
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


def _claim_lane(deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem) -> bool:
    """Whether the item has a lane of its target's tenant, taking one when it is free. An item
    already `delivering` (a retry resuming its hand-off) carries on whatever the gate says."""
    tenant = deps.deliver.target_lookup(params.target_id)
    claimed = deps.lanes.try_claim(item.id, tenant, deps.target_lanes(params.target_id))
    return claimed or item.outcome == "delivering"


#: A run whose document waits for a lane.
WAITING = Complete(note="waiting to deliver")


def _wait(
    job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem, data: bytes, result: Decomposition
) -> Outcome:
    """No lane is free: the decomposition is stored (no page images) and the item waits for the
    dispatcher, which queues a `waited` run once it has a lane."""
    held_sha256 = write_held(
        deps.store,
        deps.runs_bucket,
        item,
        result,
        data=data,
        decomposer_version=decomposer_version(source_kind(data)),
        started_by=deps.queue.uploader(job.id) or NO_USER,
        entry=None,
        render_preview=deps.render_preview,
        pages=False,
    )
    if not deps.items.wait(item.id, held_sha256, None):
        delete_held(deps.store, deps.runs_bucket, item)
        return _wait_not_recorded(job, deps, item)
    deps.queue.event(job.id, "info", "waiting for a lane", {"heldSha256": held_sha256})
    return WAITING


def _wait_not_recorded(job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem) -> Outcome:
    deps.queue.event(
        job.id,
        "info",
        "not recorded, the item had moved on: waiting to deliver",
        {"outcome": "waiting_to_deliver", "recorded": False},
    )
    return Complete(note=f"{item.source_key}: had moved on; waiting to deliver not recorded")


def _from_wait(
    job: ClaimedJob, deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem
) -> Outcome:
    """The dispatcher's run of a waiting item, whose lane it claimed: the stored decomposition
    delivered as who started the batch, the register deciding again; the stored copy deleted
    once the item has an outcome. A retry that finds the item `delivering` and the copy gone was
    handed over already."""
    manifest_key = decomposition_held_manifest_key(item.batch_id, item.id)
    if (
        item.outcome == "delivering"
        and deps.store.get_optional(deps.runs_bucket, manifest_key) is None
    ):
        return Complete(note="delivery already handed over")
    deps.items.resume(item.id)  # the wait for a lane is over: its time is not working time
    deps.queue.event(job.id, "info", "lane free: delivering", {"itemId": item.id})

    def deliver() -> Outcome:
        try:
            manifest, held, data = _read_stored(deps, item)
        except HeldMismatch as exc:
            return _decided(job, deps, item, DeliveryOutcome("failed", None, None, str(exc)))
        check_cancelled(job, deps.queue)  # nothing is delivered for a cancelled job
        return _deliver(
            job,
            deps,
            params,
            item,
            data,
            held,
            started_by=manifest.started_by,
            version=manifest.decomposer_version,
        )

    return _deleting_held(job, deps, item, deliver)


def _deleting_held(
    job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem, run: Callable[[], Outcome]
) -> Outcome:
    """`run()` (failing the item on a cancel or the last attempt's error), the item's held files
    deleted once it has an outcome: unless it waits for a lane, or nothing was decided."""
    try:
        outcome = _failing_on_error(job, deps, item, run)
    except TargetNotSynced:
        raise  # nothing is decided: the held files wait with the job
    except Exception as exc:
        if isinstance(exc, JobCancelled) or job.attempts >= job.max_attempts:
            delete_held(deps.store, deps.runs_bucket, item)  # the item was failed
        raise
    if outcome != WAITING:
        delete_held(deps.store, deps.runs_bucket, item)
    return outcome


def _read_stored(
    deps: DecomposeDeps, item: ConversionItem
) -> tuple[HeldManifest, Decomposition, bytes]:
    """The item's held manifest, decomposition and source; `HeldMismatch` when the held files or
    the source are not the recorded ones."""
    manifest, held = read_held(deps.store, deps.runs_bucket, item)
    data = deps.store.get(deps.runs_bucket, item.object_key)
    if hashlib.sha256(data).hexdigest() != manifest.source_sha256:
        raise HeldMismatch(f"the source of {item.source_key} is not the reviewed one")
    return manifest, held, data


def _hold(
    job: ClaimedJob,
    deps: DecomposeDeps,
    params: DecomposeParams,
    item: ConversionItem,
    data: bytes,
    result: Decomposition,
) -> Outcome:
    """A PDF is held for review when its delivery would send something (spec §14.2): the
    register is asked without recording anything, and any other answer is the item's outcome at
    once. The hold records the entry the register decided against, and who started the batch,
    for the approved delivery."""
    try:
        decision = preview_decision(
            deps.deliver,
            data=data,
            source_key=item.source_key,
            target_id=params.target_id,
            force=params.force,
        )
    except TargetMissing as exc:
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, str(exc)))
    if decision.outcome is not None:
        return _decided(job, deps, item, refused(decision))
    entry = (
        {"id": decision.entry.id, "contentSha256": decision.entry.content_sha256}
        if decision.entry is not None
        else None
    )
    held_sha256 = write_held(
        deps.store,
        deps.runs_bucket,
        item,
        result,
        data=data,
        decomposer_version=decomposer_version("pdf"),
        started_by=deps.queue.uploader(job.id) or NO_USER,
        entry=entry,
        render_preview=deps.render_preview,
    )
    if not deps.items.hold(item.id, held_sha256, entry, _unproven_detail(result.unproven)):
        delete_held(deps.store, deps.runs_bucket, item)
        deps.queue.event(
            job.id,
            "info",
            "not recorded, the item had moved on: held for review",
            {"outcome": "awaiting_review", "recorded": False},
        )
        return Complete(note=f"{item.source_key}: had moved on; held for review not recorded")
    deps.queue.event(
        job.id,
        "info",
        "held for review",
        {"heldSha256": held_sha256, "entryId": entry["id"] if entry is not None else None},
    )
    return Complete(note="held for review")


def _approved(
    job: ClaimedJob, deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem
) -> Outcome:
    """The reviewed hold delivered (spec §14.4), and its held files deleted once the item has an
    outcome, `delivering` included: an approved run never returns to `awaiting_review`. A retry
    that finds the item `delivering` and the hold gone was handed over already: the bridge's
    events settle it."""
    if item.held_sha256 is None:
        detail = f"approved, but nothing of {item.source_key} is held for review"
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, detail))
    manifest_key = decomposition_held_manifest_key(item.batch_id, item.id)
    if (
        item.outcome == "delivering"
        and deps.store.get_optional(deps.runs_bucket, manifest_key) is None
    ):
        return Complete(note="delivery already handed over")
    deps.queue.event(
        job.id, "info", "approved", {"itemId": item.id, "heldSha256": item.held_sha256}
    )

    def deliver() -> Outcome:
        try:
            claimed = _claim_lane(deps, params, item)
        except TargetMissing as exc:
            return _decided(job, deps, item, DeliveryOutcome("failed", None, None, str(exc)))
        if not claimed:
            return _wait_approved(job, deps, item)
        return _deliver_held(job, deps, params, item)

    return _deleting_held(job, deps, item, deliver)


def _wait_approved(job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem) -> Outcome:
    """An approved PDF with no free lane waits keeping its reviewed files, which the `waited`
    run delivers."""
    assert item.held_sha256 is not None  # checked by _approved
    if not deps.items.wait(item.id, item.held_sha256, item.held_entry):
        return _wait_not_recorded(job, deps, item)
    deps.queue.event(job.id, "info", "waiting for a lane", {"heldSha256": item.held_sha256})
    return WAITING


def _deliver_held(
    job: ClaimedJob, deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem
) -> Outcome:
    """The held decomposition delivered with the version it was read with, as who started the
    batch; the source is read only for its sha-256, the register's content key. Held files or
    a source that are not the reviewed ones fail the item, and so does a hold whose register
    entry has changed since (spec §14.4a)."""
    try:
        manifest, held, data = _read_stored(deps, item)
    except HeldMismatch as exc:
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, str(exc)))
    try:
        current = _hold_is_current(deps, params, item, manifest)
    except TargetMissing as exc:
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, str(exc)))
    if not current:
        return _decided(job, deps, item, DeliveryOutcome("failed", None, None, STALE_HOLD))
    check_cancelled(job, deps.queue)  # nothing is delivered for a cancelled job
    return _deliver(
        job,
        deps,
        params,
        item,
        data,
        held,
        started_by=manifest.started_by,
        version=manifest.decomposer_version,
    )


def _hold_is_current(
    deps: DecomposeDeps, params: DecomposeParams, item: ConversionItem, manifest: HeldManifest
) -> bool:
    """Whether the source's register entry is still the one the hold was decided against: the
    same id and content, or none for none. This approved run's own pending entry (a retry after
    it wrote one) is current too: its delivery is resumed."""
    entry = source_entry(deps.deliver, source_key=item.source_key, target_id=params.target_id)
    held = manifest.entry
    if (
        entry is not None
        and entry.state == "pending"
        and entry.batch_id == params.batch_id
        and entry.content_sha256 == manifest.source_sha256
    ):
        return True  # this run's own
    if entry is None or held is None:
        return entry is None and held is None
    return (entry.id, entry.content_sha256) == (held.id, held.content_sha256)


#: The report's code for a word the PDF check could not prove (spec 14.2); not a contract flag.
UNPROVEN_FLAG = "fidelity_unproven"


def _words(n: int) -> str:
    return f"{n} word" if n == 1 else f"{n} words"


def _unproven_detail(unproven: list[Unproven]) -> str | None:
    """A held item's detail: how many words were not proven, and the first."""
    if not unproven:
        return None
    more = f" (and {len(unproven) - 1} more)" if len(unproven) > 1 else ""
    return f"The check could not prove {_words(len(unproven))}: {unproven[0].detail}{more}"


def _write_report(deps: DecomposeDeps, item: ConversionItem, result: Decomposition) -> str:
    """The report's flags as JSON beside the source (R4); the item records the key."""
    key = decomposition_report_key(item.batch_id, item.id)
    flags = [flag.model_dump(mode="json", by_alias=True) for flag in result.document.report]
    # Kept out of the document, whose flag codes are the bridge contract's (spec 14.2).
    flags += [
        {"code": UNPROVEN_FLAG, "severity": "warning", "at": u.at, "message": u.detail}
        for u in result.unproven
    ]
    body = json.dumps({"flags": flags}, ensure_ascii=False).encode("utf-8")
    deps.store.put(deps.runs_bucket, key, body, "application/json")
    deps.items.set_report(item.id, key, len(flags))
    return key


def _decided(
    job: ClaimedJob, deps: DecomposeDeps, item: ConversionItem, out: DeliveryOutcome
) -> Outcome:
    """A final outcome without a delivery; the job's last event names it. A duplicate's entry is
    another source's, so the item is not linked to it; its detail names that document. When the
    item had moved on (a retry of one already delivering), it is left as it is, and the event
    says the outcome was not recorded."""
    entry_id = None if out.outcome == "duplicate" else out.entry_id
    if not deps.items.decide(item.id, out.outcome, out.detail, entry_id):
        deps.queue.event(
            job.id,
            "info",
            f"not recorded, the item had moved on: {OUTCOME_LABELS[out.outcome]}: {out.detail}",
            {"outcome": out.outcome, "detail": out.detail, "recorded": False},
        )
        return Complete(note=f"{item.source_key}: had moved on; {out.outcome} not recorded")
    deps.queue.event(
        job.id,
        "warn",
        f"{OUTCOME_LABELS[out.outcome]}: {out.detail}",
        {"outcome": out.outcome, "detail": out.detail},
    )
    return Complete(note=f"{item.source_key}: {out.outcome}")
