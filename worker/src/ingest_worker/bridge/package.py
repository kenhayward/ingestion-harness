"""The package of one document's publication, built from what the worker already renders, and
its delivery through the bridge. A file sink writes each file at its target's prefix + the file's
name, which is today's unprefixed key, so published object keys do not move."""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast

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
    PackageRdf,
    Producer,
    Provenance,
    graph_idempotency_key,
    idempotency_key,
    package_archive_keys,
)
from .naming import naming_inputs

if TYPE_CHECKING:
    from ..pipeline import PipelineDeps
    from ..publish_targets import Target
    from ..queue import ClaimedJob, JobQueue
    from ..template import Template

PRODUCER = "ct-studio"

#: The output id of a graph's versioned Turtle copy in a package's files.
GRAPH_VERSION_OUTPUT = "graph-version"


@dataclass(frozen=True)
class GraphVersion:
    """A published graph at its version, ready to deliver: the bytes loaded into the triple store
    and copied (at `copy_key`, today's unprefixed `graph_version_key`) to the files target."""

    graph_name: str
    version: int
    turtle: bytes
    copy_key: str


@dataclass(frozen=True)
class Delivered:
    """What one package's hand-off gave: the primary target's outputs, keyed as it writes them
    (its prefix + their key; never the graph's copy), that target's delivery, and every delivery
    in target order. `outputs_by_target` holds what each S3 target records: a files-layout
    target's outputs at its keys, an archive's every key (package_archive_keys)."""

    outputs: list[RenderedOutput]
    s3: tuple[str, str]
    deliveries: list[tuple[str, str]]
    outputs_by_target: dict[str, list[RenderedOutput]] = field(default_factory=dict)
    primary: str = ""


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
    graph: GraphVersion | None = None,
) -> BridgePackage:
    """The `document` package of a job's delivered outputs. A recipe's package carries its
    fields and tables as data too; a legacy spec's carries its files only. With `graph`, it
    carries the graph (`rdf`) and its versioned copy (the file `graph-version`)."""
    doc = document or {}
    recipe_id = template.id if template else job.spec_id
    recipe_version = template.version if template else job.spec_version
    sha = job.source_sha256 or str(doc.get("source_sha256") or "")
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise DocumentError("the document's sha256 is not known: it cannot be delivered")
    published_at = _utc(doc.get("published_at")) or _now()
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
            published_at=published_at,
        ),
        naming=naming_inputs(
            fields=doc.get("fields") or {},
            job_id=job.id,
            recipe_id=recipe_id,
            recipe_version=recipe_version,
            source_filename=job.filename,
            source_sha256=sha,
            published_at=datetime.fromisoformat(published_at.replace("Z", "+00:00")),
        ),
        files=[
            PackageFile(
                output=o.output_id,
                format=o.format,
                content_type=content_type(o.format),
                name=o.key,
                content=base64.b64encode(o.body).decode("ascii"),
            )
            for o in outputs
        ]
        + (
            [
                PackageFile(
                    output=GRAPH_VERSION_OUTPUT,
                    format="ttl",
                    content_type="text/turtle",
                    name=graph.copy_key,
                    content=base64.b64encode(graph.turtle).decode("ascii"),
                )
            ]
            if graph is not None
            else []
        ),
        data=_data(template, doc) if template is not None and document is not None else None,
        rdf=(
            PackageRdf(
                graph_name=graph.graph_name, version=graph.version, turtle=graph.turtle.decode()
            )
            if graph is not None
            else None
        ),
        narrative=None,
        images=None,
    )


def acting_user_for(job: ClaimedJob, users: ActingUsers) -> ActingUser | None:
    """Who a delivery acts as: the reviewer of a reviewed job, else its uploader, else nobody."""
    return users.reviewer(job.id) or users.uploader(job.id)


def build_graph_package(
    graph_name: str, version: int, turtle: str, *, deployment: str
) -> BridgePackage:
    """A `graph` package: one graph and no document (an ontology version, a rebuilt or reminted
    graph), keyed by its name and version."""
    return BridgePackage(
        kind="graph",
        contract_version=1,
        producer=Producer(name=PRODUCER, deployment=deployment),
        idempotency_key=graph_idempotency_key(graph_name, version),
        provenance=None,
        naming={},
        files=[],
        data=None,
        rdf=PackageRdf(graph_name=graph_name, version=version, turtle=turtle),
        narrative=None,
        images=None,
    )


def deliver_document(
    deps: PipelineDeps,
    job: ClaimedJob,
    *,
    template: Template | None,
    document: dict[str, Any] | None,
    outputs: list[RenderedOutput],
    targets: list[Target],
    acting: ActingUser | None,
    approver: ActingUser | None,
    graph: GraphVersion | None = None,
    primary: Target | None = None,
    overrides: dict[str, dict[str, str]] | None = None,
) -> Delivered:
    """Build the job's package from `outputs` (and `graph`) and deliver it to every target
    (deliver_outputs; `primary`: the target read back from, else the first), with the recipe's
    name patterns and the reviewer's `overrides` for the targets it names."""
    package = build_package(
        job=job,
        template=template,
        document=document,
        outputs=outputs,
        approver=approver,
        deployment=deps.deployment,
        graph=graph,
    )
    # The recipe's name patterns, for the targets this hand-off names (the bridge resolves them).
    named = {t.id for t in targets}
    settings = template.delivery_settings() if template else {}
    patterns = {t: fields for t, fields in settings.items() if t in named}
    return deliver_outputs(
        deps,
        job,
        package,
        targets,
        acting,
        outputs,
        primary,
        patterns=patterns,
        overrides={t: f for t, f in (overrides or {}).items() if t in named},
    )


def deliver_outputs(
    deps: PipelineDeps,
    job: ClaimedJob,
    package: BridgePackage,
    targets: list[Target],
    acting: ActingUser | None,
    outputs: list[RenderedOutput],
    primary: Target | None = None,
    *,
    patterns: dict[str, dict[str, str]] | None = None,
    overrides: dict[str, dict[str, str]] | None = None,
) -> Delivered:
    """Submit the package to `targets` through the bridge, in one request, with the recipe's
    name `patterns` and the reviewer's `overrides` per target. Returns the outputs
    keyed as the primary target (default: the first) writes them (its prefix + their key), what
    each S3 target records, and the deliveries. A refusal for a person (BridgeRefused, a
    DocumentError) and an unreachable bridge (BridgeUnavailable, retried) propagate; nothing is
    recorded by this function."""
    if deps.bridge is None:
        raise RuntimeError("no delivery bridge is configured: nothing can be delivered")
    result = deps.bridge.deliver(
        CreateDeliveriesRequest(
            targets=[t.id for t in targets],
            acting_user=acting,
            overrides=overrides or {},
            patterns=patterns or {},
            package=package,
        )
    )
    by_target = {d.target_id: d.delivery_id for d in result.deliveries}
    deliveries = [(t.id, by_target[t.id]) for t in targets]
    files = primary or targets[0]
    keyed = {
        t.id: archive_outputs(t, package, outputs)
        if t.layout == "package"
        else [replace(o, key=f"{t.prefix}{o.key}") for o in outputs]
        # The primary's graph copy is a graph version; another files target's is an output row,
        # so withdrawing the job deletes it there too.
        + ([] if t.id == files.id else graph_copy_outputs(t, package))
        for t in targets
        # Another sink's target records no outputs here: what it holds is its own, and the job
        # shows its delivery.
        if t.layout != "sink"
    }
    return Delivered(
        outputs=keyed[files.id],
        s3=(files.id, by_target[files.id]),
        deliveries=deliveries,
        outputs_by_target=keyed,
        primary=files.id,
    )


_ARCHIVE_FORMATS: dict[str, Literal["csv", "json", "rdf"]] = {
    "package:data": "json",
    "package:graph": "rdf",
    "package:manifest": "json",
}


def archive_outputs(
    target: Target, package: BridgePackage, outputs: list[RenderedOutput]
) -> list[RenderedOutput]:
    """What an archive (layout `package`) target records: every key it writes, under the
    contract's output ids, so withdrawing the job deletes the whole archive. No bytes: the rows
    are records only."""
    rendered = {o.output_id: o for o in outputs}
    formats = {f.output: f.format for f in package.files}
    rows = []
    for contract_id, key in package_archive_keys(target.prefix, package):
        output_id = graph_copy_id(package) if contract_id == GRAPH_VERSION_OUTPUT else contract_id
        source = rendered.get(contract_id)
        fmt = _ARCHIVE_FORMATS.get(contract_id) or (
            "rdf" if formats.get(contract_id) == "ttl" else formats.get(contract_id, "json")
        )
        rows.append(
            RenderedOutput(
                output_id=output_id,
                format=cast(Literal["csv", "json", "rdf"], fmt),
                key=key,
                body=b"",
                row_count=source.row_count if source is not None else None,
            )
        )
    return rows


def graph_copy_id(package: BridgePackage) -> str:
    """The output id a graph copy is recorded under off the primary target: one per graph
    version, since each version is its own object (a re-delivery publishes the next one)."""
    return f"{GRAPH_VERSION_OUTPUT}:v{package.rdf.version}" if package.rdf else GRAPH_VERSION_OUTPUT


def graph_copy_outputs(target: Target, package: BridgePackage) -> list[RenderedOutput]:
    """A files-layout target's record of the graph's versioned copy the package carries (none
    without a graph)."""
    return [
        RenderedOutput(
            output_id=graph_copy_id(package),
            format="rdf",
            key=f"{target.prefix}{f.name}",
            body=b"",
            row_count=None,
        )
        for f in package.files
        if f.output == GRAPH_VERSION_OUTPUT
    ]


def record_delivered(
    queue: JobQueue, job: ClaimedJob, delivered: Delivered, targets: list[Target]
) -> None:
    """Record what each of the recipe's `targets` was handed (record_published), marking the
    primary target's rows: they serve Results, the zip and read keys."""
    delivery_of = dict(delivered.deliveries)
    for t in targets:
        outputs = delivered.outputs_by_target.get(t.id)
        if outputs is None:
            continue
        queue.record_published(
            job, outputs, t, delivery_of.get(t.id), primary=t.id == delivered.primary
        )


def deliver_graph_package(
    deps: PipelineDeps, package: BridgePackage, target: Target, acting: ActingUser | None
) -> str:
    """Submit a `graph` package to the triple store target; returns its delivery's id."""
    if deps.bridge is None:
        raise RuntimeError("no delivery bridge is configured: nothing can be delivered")
    result = deps.bridge.deliver(
        CreateDeliveriesRequest(targets=[target.id], acting_user=acting, package=package)
    )
    return next(d.delivery_id for d in result.deliveries if d.target_id == target.id)
