"""Delivering one decomposed document to one target (spec §8; plan ruling R8: the entry point
phase 3's batch jobs call).

`deliver_decomposition` decomposes the source, checks the register (`decide`, spec §8's two
checks), writes the entry `pending` and hands a contract version 2 package to the bridge. The
entry's final state arrives later, from the bridge's events, through the API.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from ingest_worker.bridge.client import BridgeClient, BridgeRefused, BridgeUnavailable
from ingest_worker.bridge.models import (
    ActingUser,
    BridgePackage,
    CreateDeliveriesRequest,
    DecompositionProvenance,
    PackageImage,
    Producer,
    Update,
    decomposition_idempotency_key,
)
from ingest_worker.bridge.package import PRODUCER
from ingest_worker.decompose import (
    DECOMPOSER_VERSION,
    Decomposition,
    DecompositionFailed,
    DecompositionRejected,
    decompose_docx,
)
from ingest_worker.decompose.register import RegisterEntry, RegisterRaced, RegisterStore
from ingest_worker.decompose.render import Renderer

Outcome = Literal[
    "created",
    "updated",
    "already_loaded",
    "duplicate",
    "in_flight",
    "changed_in_target",
    "unresolved",
    "failed",
]

#: States whose content counts as on the tenant: an entry that failed without ever becoming a
#: document (no persistent id) does not.
_SETTLED_LOADED = ("delivered", "incomplete")

#: The mark in a refused entry's `last_error.details`: the bridge took nothing, so nothing under
#: the entry's key can have reached the target (see `deliver_decomposition`).
REFUSED_BEFORE_ACCEPTANCE = "refusedBeforeAcceptance"

_UNRESOLVED = (
    "an earlier delivery of this source may have created a document in the target; "
    "re-run the original file, or resolve it in the target"
)


@dataclass(frozen=True)
class Decision:
    """What the register says to do. `outcome` None: deliver, creating a document (`create`) or
    updating `entry`'s; `entry` is the entry the decision is about (the one to reset, or the
    one that refuses)."""

    outcome: Outcome | None
    create: bool
    entry: RegisterEntry | None
    reason: str
    #: The key to deliver under when it must be the entry's stored one (an earlier delivery may
    #: have created a document under it); None: derived from the content.
    idempotency_key: str | None = None


def _seen(e: RegisterEntry) -> bool:
    return e.persistent_id is not None or e.state != "failed"


def _refused_before_acceptance(e: RegisterEntry) -> bool:
    details = (e.last_error or {}).get("details")
    return isinstance(details, dict) and details.get(REFUSED_BEFORE_ACCEPTANCE) is True


def decide(
    by_key: RegisterEntry | None, by_hash: list[RegisterEntry], sha: str, force: bool
) -> Decision:
    """Spec §8's two checks. A pending entry is in flight and a changed one refuses, force or
    not (force never bypasses the version check). The same content under the same key is
    already loaded (force: update); under another key, a duplicate (force: create, or update
    the source's own document when it has one); the same key counts only once it became a
    document, so a never-created entry whose content another key holds is a duplicate too. New
    content under a known key updates its document; a new key creates.

    An entry with no persistent id is created again under a new key only when the bridge
    refused its last delivery outright (nothing reached the target). Otherwise that delivery may
    have made a document: the same content is created again under the entry's stored key, which
    the sink answers with that document, if any; new content is `unresolved`, force or not."""
    if by_key is not None:
        if by_key.state == "pending":
            return Decision("in_flight", False, by_key, "a delivery of this source is in flight")
        if by_key.state == "changed":
            return Decision(
                "changed_in_target",
                False,
                by_key,
                f"document {by_key.persistent_id} has changed in the target since it was delivered",
            )
    if by_key is not None and by_key.content_sha256 == sha and _seen(by_key):
        if by_key.state in _SETTLED_LOADED and by_key.persistent_id is not None and not force:
            return Decision(
                "already_loaded", False, by_key, f"already loaded as {by_key.persistent_id}"
            )
    elif not force and (
        others := [e for e in by_hash if _seen(e) and (by_key is None or e.id != by_key.id)]
    ):
        first = others[0]
        return Decision(
            "duplicate",
            False,
            first,
            f"the same file is already document {first.persistent_id or '(pending)'}, "
            f"from {first.source_key}",
        )
    if by_key is None:
        return Decision(None, True, None, "a new source")
    if by_key.persistent_id is None:
        if _refused_before_acceptance(by_key):
            return Decision(None, True, by_key, "created again: the bridge refused the last one")
        if by_key.content_sha256 == sha:
            return Decision(
                None,
                True,
                by_key,
                "created again under the last delivery's key: it may have made the document",
                by_key.idempotency_key,
            )
        return Decision("unresolved", False, by_key, _UNRESOLVED)
    return Decision(None, False, by_key, f"an update of {by_key.persistent_id}")


@dataclass(frozen=True)
class DeliveryOutcome:
    outcome: Outcome
    delivery_id: str | None
    entry_id: str | None
    detail: str


@dataclass(frozen=True)
class DeliverDeps:
    renderer: Renderer
    register: RegisterStore
    bridge: BridgeClient
    #: A target's tenant: its sink id and instance id (None: a sink without instances).
    target_lookup: Callable[[str], tuple[str, str | None]]
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    #: This deployment's id, as packages name their producer.
    deployment: str = "default"


def _iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _naming(filename: str, source_key: str, sha: str, at: datetime) -> dict[str, str]:
    """What a destination's name patterns resolve against: the source (as an extraction
    package names it) and its key."""
    dot = filename.rfind(".")
    return {
        "source.filename": filename,
        "source.stem": filename[:dot] if dot > 0 else filename,
        "source.sha256": sha,
        "source.key": source_key,
        "date": at.astimezone(UTC).date().isoformat(),
    }


def build_decomposition_package(
    result: Decomposition,
    *,
    sha: str,
    source_key: str,
    idempotency_key: str,
    batch_id: str | None,
    started_by: ActingUser,
    decomposed_at: datetime,
    published_at: datetime,
    deployment: str,
) -> BridgePackage:
    """The version 2 package of a decomposed document: the document, one image per document
    image (its bytes, base64; converted images' originals are not sent) and its provenance."""
    filename = source_key.rsplit("/", 1)[-1]
    return BridgePackage(
        kind="document",
        contract_version=2,
        producer=Producer(name=PRODUCER, deployment=deployment),
        idempotency_key=idempotency_key,
        provenance=DecompositionProvenance(
            kind="decomposition",
            source_sha256=sha,
            source_filename=filename,
            source_key=source_key,
            batch_id=batch_id,
            decomposer_version=DECOMPOSER_VERSION,
            started_by=started_by,
            decomposed_at=_iso(decomposed_at),
            published_at=_iso(published_at),
        ),
        naming=_naming(filename, source_key, sha, published_at),
        files=[],
        data=None,
        rdf=None,
        narrative=None,
        images=[
            PackageImage(
                id=image.id,
                content_type=image.content_type,
                content=base64.b64encode(result.image_bytes[image.id]).decode("ascii"),
            )
            for image in result.document.images
        ],
        document=result.document,
    )


_NO_VERSIONS = "no component versions are recorded for this document; resolve it in the target"


def _force_token(batch_id: str | None) -> str:
    """A force-load's part of the idempotency key: new on every forced run, so it never shares
    a key with an unforced run, another forced run, or another source of the same batch."""
    token = uuid.uuid4().hex
    return f"{batch_id}:{token}" if batch_id else token


_RESUMED = "resumed: an earlier run of this batch handed it to the bridge"


def _own_pending(
    by_key: RegisterEntry | None, batch_id: str | None, sha: str
) -> RegisterEntry | None:
    """The source's pending entry when this batch's own earlier run wrote it (the same item: a
    source key is unique in a batch), for the same content: never in flight against itself."""
    if (
        by_key is None
        or batch_id is None
        or by_key.state != "pending"
        or by_key.batch_id != batch_id
        or by_key.content_sha256 != sha
    ):
        return None
    return by_key


def _refused(decision: Decision) -> DeliveryOutcome:
    assert decision.outcome is not None
    entry_id = decision.entry.id if decision.entry is not None else None
    return DeliveryOutcome(decision.outcome, None, entry_id, decision.reason)


def deliver_decomposition(
    deps: DeliverDeps,
    *,
    data: bytes,
    source_key: str,
    target_id: str,
    started_by: ActingUser,
    batch_id: str | None = None,
    force: bool = False,
    decomposed: Decomposition | None = None,
) -> DeliveryOutcome:
    """Decompose `data` and deliver it to `target_id` as the register decides.

    A decomposition that fails or is rejected touches nothing. Otherwise the entry is written
    `pending` (committed) before the bridge is called; the hand-off then runs under the entry's
    row lock, which serialises workers. It does not hold off the API: an event that arrives
    before `set_delivery` commits matches no entry and is answered 409, and the bridge's resend
    or the API's reconcile settles it. When the bridge may have taken it (BridgeUnavailable:
    unreachable, a timeout), the entry stays `pending`, so a retry is in flight rather than a
    second create; a definite refusal (BridgeRefused) marks it `failed` with the error, the one
    state the worker settles (a narrow exception to ruling R6). The error is marked refused
    before acceptance unless the delivery reused a key an earlier one may have created under:
    only then may a later run create under a new key. Either way the outcome is `failed`. Every
    forced run gets a new idempotency key, except one that must reuse the entry's stored key.

    A pending entry this batch's own earlier run wrote (the worker stopped mid-way) is resumed,
    never reported in flight: its recorded delivery is returned, or, when none was recorded, the
    document is handed over again under the entry's stored key.

    `decomposed`: `data`'s decomposition when the caller made it already (the `decompose` job,
    which writes its report first), so nothing is rendered twice.
    """
    try:
        result = (
            decomposed if decomposed is not None else decompose_docx(data, renderer=deps.renderer)
        )
    except DecompositionRejected as exc:
        return DeliveryOutcome("failed", None, None, f"rejected: {exc}")
    except DecompositionFailed as exc:
        return DeliveryOutcome("failed", None, None, f"decomposition failed: {exc}")
    decomposed_at = deps.clock()
    sha = hashlib.sha256(data).hexdigest()
    sink_id, instance_id = deps.target_lookup(target_id)

    with deps.register.transaction() as tx:
        by_key = tx.by_key(sink_id, instance_id, source_key)
        own = _own_pending(by_key, batch_id, sha)
        if own is not None and own.delivery_id is not None:
            # This batch's own earlier run handed it over (the worker stopped before recording
            # it): wait for that delivery.
            outcome: Outcome = "updated" if own.persistent_id else "created"
            return DeliveryOutcome(outcome, own.delivery_id, own.id, _RESUMED)
        if own is not None:
            # The bridge may have taken it before `set_delivery` committed: hand it over again
            # under the stored key, which the sink answers with the same document.
            decision = Decision(None, own.persistent_id is None, own, _RESUMED, own.idempotency_key)
        else:
            decision = decide(by_key, tx.by_hash(sink_id, instance_id, sha), sha, force)
        if decision.outcome is not None:
            return _refused(decision)
        update: Update | None = None
        if not decision.create:
            assert decision.entry is not None and decision.entry.persistent_id is not None
            receipt = decision.entry.last_receipt
            expected = receipt.document.components if receipt and receipt.document else []
            if not expected:
                # Nothing to hold the target's copy to: phase 3's detach or accept resolves it.
                return DeliveryOutcome("changed_in_target", None, decision.entry.id, _NO_VERSIONS)
            update = Update(persistent_id=decision.entry.persistent_id, expected=expected)
        key = decision.idempotency_key or decomposition_idempotency_key(
            sha,
            update.persistent_id if update else None,
            DECOMPOSER_VERSION,
            _force_token(batch_id) if force else None,
        )
        try:
            entry = tx.put_pending(
                replacing=decision.entry,
                sink_id=sink_id,
                instance_id=instance_id,
                source_key=source_key,
                content_sha256=sha,
                idempotency_key=key,
                batch_id=batch_id,
            )
        except RegisterRaced:
            return DeliveryOutcome(
                "in_flight", None, None, "a delivery of this source is in flight"
            )

    package = build_decomposition_package(
        result,
        sha=sha,
        source_key=source_key,
        idempotency_key=key,
        batch_id=batch_id,
        started_by=started_by,
        decomposed_at=decomposed_at,
        published_at=deps.clock(),
        deployment=deps.deployment,
    )
    request = CreateDeliveriesRequest(
        targets=[target_id], acting_user=started_by, package=package, update=update
    )
    try:
        with deps.register.transaction() as tx:
            tx.by_key(sink_id, instance_id, source_key)  # hold the entry while it is handed off
            delivered = deps.bridge.deliver(request)
            delivery_id = next(
                (d.delivery_id for d in delivered.deliveries if d.target_id == target_id), None
            )
            if delivery_id is not None:
                tx.set_delivery(entry.id, delivery_id)
    except BridgeRefused as exc:
        # A definite refusal: nothing was accepted, so nothing but this settles the entry.
        error = exc.error.model_dump(by_alias=True, mode="json")
        if decision.idempotency_key is None:
            error["details"] = {**(error.get("details") or {}), REFUSED_BEFORE_ACCEPTANCE: True}
        with deps.register.transaction() as tx:
            tx.set_failed(entry.id, error)
        return DeliveryOutcome("failed", None, entry.id, f"the bridge refused it: {exc}")
    except BridgeUnavailable as exc:
        # It may have been accepted: the entry stays pending (the API's reconcile expires it).
        return DeliveryOutcome("failed", None, entry.id, f"the bridge did not take it: {exc}")
    if delivery_id is None:
        return DeliveryOutcome(
            "failed", None, entry.id, f"the bridge accepted it without a delivery to {target_id}"
        )
    return DeliveryOutcome(
        "updated" if update else "created", delivery_id, entry.id, decision.reason
    )
