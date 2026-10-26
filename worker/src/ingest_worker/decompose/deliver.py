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
from typing import Any, Literal

from ingest_worker.bridge.client import BridgeClient, BridgeRefused, BridgeUnavailable
from ingest_worker.bridge.models import (
    ActingUser,
    BridgeError,
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
#: document (no persistent id) does not. Nor does an `accepted` one: the target's state was
#: accepted, so its next run is an update against those versions, whatever its content, until
#: that update is delivered (spec §8).
_SETTLED_LOADED = ("delivered", "incomplete")

#: The mark in a refused entry's `last_error.details`: the bridge took nothing, so nothing under
#: the entry's key can have reached the target (see `deliver_decomposition`).
REFUSED_BEFORE_ACCEPTANCE = "refusedBeforeAcceptance"

_UNRESOLVED = (
    "an earlier delivery of this source may have created a document in the target; "
    "re-run the original file, or resolve it in the target"
)


#: What a source gone from the target says (the API's `GONE_DETAIL`, word for word): its
#: last update was refused with the sink's missing-document marker (deleted there, say).
GONE = (
    "The target no longer has this document (it may have been deleted). "
    "Load it as a new document to create it again."
)


#: The `details.reason` of a sink's refusal whose update names a document the target no longer
#: has (bridge contract `DOCUMENT_MISSING`).
DOCUMENT_MISSING = "document_missing"


def _gone(e: RegisterEntry) -> bool:
    """Gone from the target (owner's call, 2026-10-26): a failed entry whose last error is the
    sink's missing-document marker for its own document: `not_found` with details `reason:
    document_missing` and `persistentId` the entry's. Any other `not_found` (a delivery the
    bridge lost, no route, no sink job) says nothing about the document. No run updates a gone
    entry again, forced or not: only the API's reload (a detach, then a create) loads it."""
    error = e.last_error or {}
    details = error.get("details")
    return (
        e.persistent_id is not None
        and e.state == "failed"
        and error.get("code") == "not_found"
        and isinstance(details, dict)
        and details.get("reason") == DOCUMENT_MISSING
        and details.get("persistentId") == e.persistent_id
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
    by_key: RegisterEntry | None,
    by_hash: list[RegisterEntry],
    sha: str,
    force: bool,
    *,
    source_key: str | None = None,
) -> Decision:
    """Spec §8's two checks. A pending entry is in flight and a changed one refuses, force or
    not (force never bypasses the version check), and one gone from the target is unresolved,
    force or not (`GONE`: only a reload loads it again). The same content under the same key is
    already loaded (force: update); under another key, a duplicate (force: create, or update
    the source's own document when it has one); the same key counts only once it became a
    document, so a never-created entry whose content another key holds is a duplicate too. New
    content under a known key updates its document; a new key creates.

    An entry with no persistent id is created again under a new key only when the bridge
    refused its last delivery outright (nothing reached the target). Otherwise that delivery may
    have made a document: the same content is created again under the entry's stored key, which
    the sink answers with that document, if any; new content is `unresolved`, force or not.

    `source_key`: the source's own key. When `by_key` read no entry but the content check finds
    one under that key, another run registered the source in between (the content check waited
    on its lock): in flight, force or not, never a duplicate of itself."""
    if by_key is None and source_key is not None:
        racing = next((e for e in by_hash if e.source_key == source_key), None)
        if racing is not None:
            return Decision("in_flight", False, racing, "a delivery of this source is in flight")
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
        if _gone(by_key):
            return Decision("unresolved", False, by_key, GONE)
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
                "sent again with the same key as the earlier attempt, so the target can't "
                "create it twice",
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


_NO_VERSIONS = (
    "the target holds this document but its versions were never recorded; "
    "detach to create a new one, or resolve it in the target"
)


def _no_versions_error() -> dict[str, Any]:
    """The last error of an entry failed for `_NO_VERSIONS` (a bridge error's shape)."""
    error = BridgeError.model_validate(
        {"class": "needs_user", "code": "no_versions", "message": _NO_VERSIONS}
    )
    return error.model_dump(by_alias=True, mode="json")


def _force_token(batch_id: str | None) -> str:
    """A force-load's part of the idempotency key: new on every forced run, so it never shares
    a key with an unforced run, another forced run, or another source of the same batch."""
    token = uuid.uuid4().hex
    return f"{batch_id}:{token}" if batch_id else token


def _expected_digest(update: Update) -> str:
    """What an update expects, as a digest: the SHA-256 of its components' sorted
    `id@version` lines. Two updates of one document expecting different versions are
    different writes, even of the same file."""
    lines = sorted(f"{c.id}@{c.version}" for c in update.expected)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def _detached_by(tombstone: RegisterEntry | None, entry: RegisterEntry | None) -> str | None:
    """The detach a create must stay apart from: the tombstone's, or that of the entry that
    replaced it while it has no document (its first create was refused, say), so no create of
    the source shares a key with the detached document's."""
    if tombstone is not None:
        return tombstone.detach_action_id
    if entry is not None and entry.persistent_id is None:
        return entry.detach_action_id
    return None


def _run_token(
    batch_id: str | None, force: bool, detached_by: str | None, update: Update | None
) -> str | None:
    """The run's part of a derived idempotency key ("the same key means the same write"):
    - an update's: the digest of the versions it expects, so A, then B, then A again is a new
      write rather than a replay of A's first receipt, while a retry of the same update keeps
      its key; a forced update joins it to the force-load's token (`token:digest`);
    - a forced create's: the force-load's new token;
    - a create after a detach, until the source has a document again: the detach action's id,
      so the key differs from the detached document's and the target can't answer with it
      (spec §8);
    - any other create: none, so the same file gets the same key ("same file, same result")."""
    token = _force_token(batch_id) if force else None
    if update is not None:
        digest = _expected_digest(update)
        return f"{token}:{digest}" if token else digest
    return token or detached_by


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
        # A detached entry is a tombstone (the API's detach): absent from both checks, and the
        # next create replaces it, under a key its detach makes new.
        tombstone = by_key if by_key is not None and by_key.state == "detached" else None
        if tombstone is not None:
            by_key = None
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
            by_hash = [e for e in tx.by_hash(sink_id, instance_id, sha) if e.state != "detached"]
            decision = decide(by_key, by_hash, sha, force, source_key=source_key)
        if decision.outcome is not None:
            return _refused(decision)
        update: Update | None = None
        if not decision.create:
            assert decision.entry is not None and decision.entry.persistent_id is not None
            receipt = decision.entry.last_receipt
            expected = receipt.document.components if receipt and receipt.document else []
            if not expected:
                # Nothing to hold the target's copy to, so no update is sent: unresolved, and
                # detach applies (the API's detach takes an entry with a document and no
                # versions). A pending entry this batch's own earlier run left has sent none
                # either: nothing is on its way, so it is failed now, not by the reconcile.
                if own is not None:
                    tx.set_failed(own.id, _no_versions_error())
                return DeliveryOutcome("unresolved", None, decision.entry.id, _NO_VERSIONS)
            update = Update(persistent_id=decision.entry.persistent_id, expected=expected)
        key = decision.idempotency_key or decomposition_idempotency_key(
            sha,
            update.persistent_id if update else None,
            DECOMPOSER_VERSION,
            _run_token(batch_id, force, _detached_by(tombstone, decision.entry), update),
        )
        try:
            entry = tx.put_pending(
                replacing=decision.entry or tombstone,
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
