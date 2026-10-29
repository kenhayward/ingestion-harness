"""A PDF's decomposition held for review (spec §14.3), beside its source in the runs bucket.

`write_held` stores the decomposed document's images, a JPEG of every page and, last, the
manifest (`decompositions/{batchId}/{itemId}.held/manifest.json`): the document, the images'
keys and sha-256s, the page count and page map, the words the check could not prove, and what
approval delivers with (the source's sha-256, the decomposer version, who started the batch and
the register entry the hold was decided against). The item records the manifest's sha-256, so `read_held` gives back exactly
the bytes that were reviewed, or raises `HeldMismatch`. The API reads the manifest too (the
review page), so its camelCase shape is a contract.

A document waiting for a lane (lanes.py) is stored the same way, without page images
(`pages=False`, `reason: lane`), so the run that gets the lane delivers it without decomposing it
again.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any, Literal

from pydantic import Field

from ingest_worker.bridge.models import ActingUser, Wire
from ingest_worker.decompose import Decomposition
from ingest_worker.decompose.items import ConversionItem
from ingest_worker.decompose.model import DecomposedDocument
from ingest_worker.storage import (
    ObjectStore,
    decomposition_held_image_key,
    decomposition_held_manifest_key,
    decomposition_held_page_key,
)


class HeldMismatch(Exception):
    """The held files are not the ones the item recorded: approving them would deliver what
    nobody reviewed."""


class HeldEntry(Wire):
    """The register entry a hold was decided against."""

    id: str
    content_sha256: str


class HeldImage(Wire):
    id: str
    key: str
    sha256: str
    content_type: str


class HeldUnproven(Wire):
    """A word the check could not prove (`Unproven`), for the review page."""

    detail: str
    page: int
    at: str | None


#: Why a decomposition is held: for a person's review, or for a free lane of its tenant.
HoldReason = Literal["review", "lane"]


class HeldManifest(Wire):
    version: Literal[1] = 1
    #: Older manifests are all review holds.
    reason: HoldReason = "review"
    source_sha256: str
    decomposer_version: int
    #: Who started the batch: the approved delivery acts as them.
    started_by: ActingUser
    entry: HeldEntry | None
    document: DecomposedDocument
    images: list[HeldImage]
    page_count: int
    #: The 1-based pages each section and block came from, by id.
    page_map: dict[str, list[int]]
    #: The words the check could not prove, in check order (spec 14.2); not in `document`.
    unproven: list[HeldUnproven] = Field(default_factory=list)


def _sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _page_count(data: bytes) -> int:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    try:
        return len(doc)
    finally:
        doc.close()


def write_held(
    store: ObjectStore,
    bucket: str,
    item: ConversionItem,
    result: Decomposition,
    *,
    data: bytes,
    decomposer_version: int,
    started_by: ActingUser,
    entry: dict[str, Any] | None,
    render_preview: Callable[[bytes, int], bytes],
    pages: bool = True,
) -> str:
    """Hold `result`, the decomposition of `data`: its images, a JPEG of every page
    (`render_preview`, 0-based page) for a review hold, then the manifest. Without `pages` (a
    document waiting for a lane, Word or PDF) no page is rendered and the manifest's reason is
    `lane`. Returns the manifest's sha-256, of its exact bytes. A page that can't be rendered
    raises (the review needs every page), and what was written is deleted first."""
    written: list[str] = []

    def put(key: str, body: bytes, content_type: str) -> None:
        store.put(bucket, key, body, content_type)
        written.append(key)

    try:
        images: list[HeldImage] = []
        for index, image in enumerate(result.document.images):
            body = result.image_bytes[image.id]
            key = decomposition_held_image_key(item.batch_id, item.id, index)
            put(key, body, image.content_type)
            images.append(
                HeldImage(id=image.id, key=key, sha256=_sha(body), content_type=image.content_type)
            )
        page_count = _page_count(data) if pages else 0
        for index in range(page_count):
            key = decomposition_held_page_key(item.batch_id, item.id, index + 1)
            put(key, render_preview(data, index), "image/jpeg")
        manifest = HeldManifest(
            reason="review" if pages else "lane",
            source_sha256=_sha(data),
            decomposer_version=decomposer_version,
            started_by=started_by,
            entry=HeldEntry.model_validate(entry) if entry is not None else None,
            document=result.document,
            images=images,
            page_count=page_count,
            page_map=result.page_map,
            unproven=[HeldUnproven(detail=u.detail, page=u.page, at=u.at) for u in result.unproven],
        )
        raw = manifest.model_dump_json(by_alias=True).encode("utf-8")
        put(decomposition_held_manifest_key(item.batch_id, item.id), raw, "application/json")
    except BaseException:
        for key in written:
            store.delete(bucket, key)
        raise
    return _sha(raw)


def read_held(
    store: ObjectStore, bucket: str, item: ConversionItem
) -> tuple[HeldManifest, Decomposition]:
    """The item's held manifest and decomposition. Raises `HeldMismatch` when the manifest is
    not the one the item recorded (or the item holds nothing, or the manifest is gone), or an
    image is not the one the manifest names."""
    if item.held_sha256 is None:
        raise HeldMismatch(f"nothing of {item.source_key} is held for review")
    raw = store.get_optional(bucket, decomposition_held_manifest_key(item.batch_id, item.id))
    if raw is None or _sha(raw) != item.held_sha256:
        raise HeldMismatch(f"the held decomposition of {item.source_key} is not the reviewed one")
    manifest = HeldManifest.model_validate_json(raw)
    image_bytes: dict[str, bytes] = {}
    for image in manifest.images:
        body = store.get(bucket, image.key)
        if _sha(body) != image.sha256:
            raise HeldMismatch(f"held image {image.id} of {item.source_key} has changed")
        image_bytes[image.id] = body
    return manifest, Decomposition(
        document=manifest.document,
        image_bytes=image_bytes,
        originals={},
        page_map=manifest.page_map,
    )


def delete_held(store: ObjectStore, bucket: str, item: ConversionItem) -> None:
    """Delete the item's held files: what the manifest names, then the manifest. Missing ones
    (no manifest at all, even) are no error."""
    delete_stored(store, bucket, item.batch_id, item.id)


def delete_stored(store: ObjectStore, bucket: str, batch_id: str, item_id: str) -> None:
    """`delete_held` by the item's batch and id."""
    manifest_key = decomposition_held_manifest_key(batch_id, item_id)
    raw = store.get_optional(bucket, manifest_key)
    if raw is None:
        return
    manifest = HeldManifest.model_validate_json(raw)
    for image in manifest.images:
        store.delete(bucket, image.key)
    for page in range(1, manifest.page_count + 1):
        store.delete(bucket, decomposition_held_page_key(batch_id, item_id, page))
    store.delete(bucket, manifest_key)
