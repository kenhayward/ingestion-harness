"""The package of one document's publication, built from what the worker already renders, and
its delivery through the bridge. A file sink writes each file at its target's prefix + the file's
name, which is today's unprefixed key, so published object keys do not move."""

from __future__ import annotations

import base64
import re
from dataclasses import replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol

from ..errors import DocumentError
from ..outputs import RenderedOutput, content_type
from .models import (
    ActingUser,
    BridgePackage,
    CreateDeliveriesRequest,
    DataColumn,
    DataField,
    DataTable,
    PackageData,
    PackageFile,
    Producer,
    Provenance,
    idempotency_key,
)

if TYPE_CHECKING:
    from ..pipeline import PipelineDeps
    from ..publish_targets import Target
    from ..queue import ClaimedJob
    from ..template import Template

PRODUCER = "ct-studio"


class ActingUsers(Protocol):
    """Who reviewed a job, and who uploaded it (JobQueue)."""

    def reviewer(self, job_id: str) -> ActingUser | None: ...

    def uploader(self, job_id: str) -> ActingUser | None: ...


def _utc(value: str | None) -> str | None:
    """An ISO timestamp as the contract writes it: UTC, with `Z`."""
    if not value:
        return None
    at = datetime.fromisoformat(value)
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _data(template: Template, document: dict[str, Any]) -> PackageData:
    """The document's fields and tables in structured form, in the recipe's order."""
    fields: dict[str, Any] = document.get("fields") or {}
    tables: dict[str, Any] = document.get("tables") or {}
    return PackageData(
        fields=[
            DataField(
                id=f.id,
                title=f.name,
                type=f.type,
                value=(fields.get(f.id) or {}).get("value"),
                unit=None,
            )
            for f in template.outputs.fields
        ],
        tables=[
            DataTable(
                id=t.id,
                title=t.name,
                columns=[DataColumn(id=c.id, title=c.name, type=c.type) for c in t.columns],
                rows=list(tables.get(t.id) or []),
            )
            for t in template.outputs.tables
        ],
    )


def build_package(
    *,
    job: ClaimedJob,
    template: Template | None,
    document: dict[str, Any] | None,
    outputs: list[RenderedOutput],
    approver: ActingUser | None,
    deployment: str,
) -> BridgePackage:
    """The `document` package of a job's delivered outputs. A recipe's package carries its
    fields and tables as data too; a legacy spec's carries its files only."""
    doc = document or {}
    recipe_id = template.id if template else job.spec_id
    recipe_version = template.version if template else job.spec_version
    sha = job.source_sha256 or str(doc.get("source_sha256") or "")
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise DocumentError("the document's sha256 is not known: it cannot be delivered")
    return BridgePackage(
        kind="document",
        contract_version=1,
        producer=Producer(name=PRODUCER, deployment=deployment),
        idempotency_key=idempotency_key(sha, recipe_id, recipe_version),
        provenance=Provenance(
            source_sha256=sha,
            source_filename=job.filename,
            job_id=job.id,
            recipe_id=recipe_id,
            recipe_version=recipe_version,
            approver=approver,
            extracted_at=_utc(doc.get("extracted_at")),
            published_at=_utc(doc.get("published_at")) or _now(),
        ),
        naming={},
        files=[
            PackageFile(
                output=o.output_id,
                format=o.format,
                content_type=content_type(o.format),
                name=o.key,
                content=base64.b64encode(o.body).decode("ascii"),
            )
            for o in outputs
        ],
        data=_data(template, doc) if template is not None and document is not None else None,
        rdf=None,
        narrative=None,
        images=None,
    )


def acting_user_for(job: ClaimedJob, users: ActingUsers) -> ActingUser | None:
    """Who a delivery acts as: the reviewer of a reviewed job, else its uploader, else nobody."""
    return users.reviewer(job.id) or users.uploader(job.id)


def deliver_document(
    deps: PipelineDeps,
    job: ClaimedJob,
    *,
    template: Template | None,
    document: dict[str, Any] | None,
    outputs: list[RenderedOutput],
    target: Target,
    acting: ActingUser | None,
    approver: ActingUser | None,
) -> tuple[list[RenderedOutput], str]:
    """Build the job's package from `outputs` and deliver it to `target` (deliver_outputs)."""
    package = build_package(
        job=job,
        template=template,
        document=document,
        outputs=outputs,
        approver=approver,
        deployment=deps.deployment,
    )
    return deliver_outputs(deps, job, package, target, acting, outputs)


def deliver_outputs(
    deps: PipelineDeps,
    job: ClaimedJob,
    package: BridgePackage,
    target: Target,
    acting: ActingUser | None,
    outputs: list[RenderedOutput],
) -> tuple[list[RenderedOutput], str]:
    """Submit the package to `target` through the bridge. Returns the outputs keyed as the
    target writes them (its prefix + their key) and the delivery's id. A refusal for a person
    (BridgeRefused, a DocumentError) and an unreachable bridge (BridgeUnavailable, retried)
    propagate; nothing is recorded by this function."""
    if deps.bridge is None:
        raise RuntimeError("no delivery bridge is configured: nothing can be delivered")
    result = deps.bridge.deliver(
        CreateDeliveriesRequest(targets=[target.id], acting_user=acting, package=package)
    )
    delivery_id = next(d.delivery_id for d in result.deliveries if d.target_id == target.id)
    return [replace(o, key=f"{target.prefix}{o.key}") for o in outputs], delivery_id
