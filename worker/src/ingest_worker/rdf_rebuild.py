"""Operator commands for the triple store (ADR 0011 step 6).

    docker exec ingestion-worker-1 python -m ingest_worker.rdf_rebuild            # reload all
    docker exec ingestion-worker-1 python -m ingest_worker.rdf_rebuild --backfill TYPE
    docker exec ingestion-worker-1 python -m ingest_worker.rdf_rebuild --remint

- **rebuild** loads every ontology graph (its normalised N-Triples, runs bucket) and every
  current document graph (its versioned Turtle copy, read from the publishing target it was
  recorded with) into the store, for an empty or restored dataset. Nothing is re-rendered.
- **--backfill TYPE** publishes the graphs of TYPE's delivered documents that have none, from
  their reviewed documents, with TYPE's newest published recipe that maps to ontologies (the
  provenance records that version); each copy goes to the publishing target of the job's own
  recipe version.
- **--remint** re-renders every current graph not yet under the Linked data base, from its
  reviewed document and the recipe version it was rendered with, as the next version of its
  graph under the new base (its copy to the target of the job's own recipe version); the graph
  under the old base is dropped.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import psycopg
from pydantic import BaseModel, ConfigDict, ValidationError

from .bridge.client import BridgeUnavailable
from .bridge.package import build_graph_package, deliver_graph_package
from .pipeline import DocumentError, PipelineDeps, Target, primary_of
from .publish_targets import DEFAULT_TARGET_ID
from .queue import ClaimedJob, JobQueue
from .storage import (
    graph_version_key,
    ontology_normalized_key,
    output_key,
    reviewed_document_key,
)
from .template import Template
from .template_pipeline import build_graph, deliver_publication


@dataclass(frozen=True)
class DeliveredJob:
    """A succeeded, non-test publish of a document type, with its document."""

    job_id: str
    document_id: str
    template_id: str
    template_version: int
    sha256: str
    bucket: str
    object_key: str


class RebuildSource(Protocol):
    def delivered_jobs(self, template_id: str) -> list[DeliveredJob]:
        """Newest first."""
        ...

    def job(self, job_id: str) -> DeliveredJob | None: ...

    def published_templates(self, template_id: str) -> dict[int, dict[str, Any]]:
        """Version -> definition of each published version."""
        ...

    def withdrawn_jobs(self, template_id: str) -> list[DeliveredJob]:
        """Jobs of the type whose delivered outputs a retirement withdrew (ADR 0011 step 7)."""
        ...

    def object_live(self, target_id: str, bucket: str, key: str) -> bool:
        """A delivered, not withdrawn output has this object of this publishing target: a
        withdrawal spares it."""
        ...

    def is_retired(self, template_id: str) -> bool: ...


@dataclass
class MemoryRebuildSource:
    jobs: list[DeliveredJob] = field(default_factory=list)
    templates: dict[int, dict[str, Any]] = field(default_factory=dict)
    withdrawn: list[DeliveredJob] = field(default_factory=list)
    #: (target id, bucket, key) of live delivered outputs.
    live: set[tuple[str, str, str]] = field(default_factory=set)
    retired: set[str] = field(default_factory=set)

    def withdrawn_jobs(self, template_id: str) -> list[DeliveredJob]:
        return [j for j in self.withdrawn if j.template_id == template_id]

    def object_live(self, target_id: str, bucket: str, key: str) -> bool:
        return (target_id, bucket, key) in self.live

    def is_retired(self, template_id: str) -> bool:
        return template_id in self.retired

    def delivered_jobs(self, template_id: str) -> list[DeliveredJob]:
        return [j for j in self.jobs if j.template_id == template_id]

    def job(self, job_id: str) -> DeliveredJob | None:
        return next((j for j in self.jobs if j.job_id == job_id), None)

    def published_templates(self, template_id: str) -> dict[int, dict[str, Any]]:
        return {v: t for v, t in self.templates.items() if t.get("id") == template_id}


class PgRebuildSource:
    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    _JOBS = """SELECT j.id::text, j.document_id::text, d.spec_id, d.spec_version, d.sha256,
                      d.bucket, d.object_key
                 FROM jobs j JOIN documents d ON d.id = j.document_id
                WHERE j.status = 'succeeded' AND NOT j.test
                  AND EXISTS (SELECT 1 FROM job_outputs o
                               WHERE o.job_id = j.id AND o.stage = 'published')"""

    def delivered_jobs(self, template_id: str) -> list[DeliveredJob]:
        rows = self._conn.execute(
            self._JOBS + " AND d.spec_id = %s ORDER BY j.updated_at DESC", (template_id,)
        ).fetchall()
        return [DeliveredJob(*r) for r in rows]

    def job(self, job_id: str) -> DeliveredJob | None:
        row = self._conn.execute(self._JOBS + " AND j.id = %s", (job_id,)).fetchone()
        return DeliveredJob(*row) if row else None

    def object_live(self, target_id: str, bucket: str, key: str) -> bool:
        row = self._conn.execute(
            """SELECT 1 FROM job_outputs WHERE target_id = %s AND bucket = %s AND object_key = %s
                  AND stage = 'published' AND withdrawn_at IS NULL LIMIT 1""",
            (target_id, bucket, key),
        ).fetchone()
        return row is not None

    def is_retired(self, template_id: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM document_type_retirements WHERE type_id = %s", (template_id,)
        ).fetchone()
        return row is not None

    def withdrawn_jobs(self, template_id: str) -> list[DeliveredJob]:
        rows = self._conn.execute(
            """SELECT j.id::text, j.document_id::text, d.spec_id, d.spec_version, d.sha256,
                      d.bucket, d.object_key
                 FROM jobs j JOIN documents d ON d.id = j.document_id
                WHERE d.spec_id = %s AND NOT j.test AND j.status = 'succeeded'
                  AND EXISTS (SELECT 1 FROM job_outputs o
                               WHERE o.job_id = j.id AND o.withdrawn_at IS NOT NULL)
                ORDER BY j.updated_at""",
            (template_id,),
        ).fetchall()
        return [DeliveredJob(*r) for r in rows]

    def published_templates(self, template_id: str) -> dict[int, dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT version, definition FROM templates WHERE id = %s AND status = 'published'",
            (template_id,),
        ).fetchall()
        return {r[0]: r[1] for r in rows}


def claimed(job: DeliveredJob, version: int | None = None) -> ClaimedJob:
    """The delivered job as a publish run of its type at `version` (default: its own)."""
    return ClaimedJob(
        job.job_id,
        job.document_id,
        job.template_id,
        job.template_version if version is None else version,
        job.bucket,
        job.object_key,
        None,
        0,
        0,
        task="publish",
        source_sha256=job.sha256,
    )


def delivered_document(deps: PipelineDeps, job: DeliveredJob) -> dict[str, Any] | None:
    """The delivered document: the reviewed one, else (delivered without review) the draft."""
    raw = deps.store.get_optional(deps.buckets.runs, reviewed_document_key(job.job_id))
    if raw is None:
        draft = output_key(
            job.template_id, job.template_version, "document", job.document_id, "json"
        )
        raw = deps.store.get_optional(deps.buckets.outputs, draft)
    if raw is None:
        return None
    document: dict[str, Any] = json.loads(raw)
    document["source_sha256"] = job.sha256
    return document


def job_target(deps: PipelineDeps, source: RebuildSource, job: DeliveredJob) -> Target:
    """The primary publishing target of the job's own recipe version, which holds the graph's
    copy (a version not published as a recipe, a legacy spec: the default)."""
    if deps.targets is None:
        raise DocumentError("no publishing targets")
    definition = source.published_templates(job.template_id).get(job.template_version)
    if definition is None:
        return deps.targets.get(DEFAULT_TARGET_ID)
    try:
        template = Template.model_validate(definition)
    except ValidationError as exc:
        raise DocumentError(f"recipe {job.template_id} v{job.template_version} is invalid") from exc
    return primary_of([deps.targets.get(i) for i in template.publish_targets()])


def _publish(
    deps: PipelineDeps,
    queue: JobQueue,
    source: RebuildSource,
    job: DeliveredJob,
    template: Template,
    deliveries: list[tuple[str, str]] | None = None,
) -> int | None:
    """Render a delivered job's reviewed document with `template` and publish its graph: its
    next version, handed to the bridge with no outputs (the package carries the graph and its
    copy to the target of the job's own recipe version, and the triple store). The deliveries
    are added to `deliveries`; the version is returned."""
    document = delivered_document(deps, job)
    if document is None:
        return None
    target = job_target(deps, source, job)
    run = claimed(job, template.version)
    graph = build_graph(run, deps, queue, template, document)
    if graph is None:
        return None
    # A system re-delivery acts as whoever last delivered the job (spec, acting users).
    acting = queue.reviewer(job.job_id) or queue.uploader(job.job_id)
    delivered = deliver_publication(
        run,
        deps,
        queue,
        template=template,
        document=document,
        outputs=[],
        graph=graph,
        # A graph-only re-delivery (backfill, remint) goes to the copy's target only.
        targets=[target],
        acting=acting,
        approver=queue.reviewer(job.job_id),
    )
    if deliveries is not None:
        deliveries.extend(delivered.deliveries)
    current = deps.graph_registry.current(job.sha256, template.id) if deps.graph_registry else None
    return current.version if current is not None else None


def rebuild(deps: PipelineDeps, deliveries: list[tuple[str, str]] | None = None) -> list[str]:
    """Reload the triple store: every ontology graph loaded, and every current graph from its
    published copy (nothing re-rendered), each as a graph package to rdf-default. The deliveries
    are added to `deliveries`."""
    registry, targets, bridge = deps.graph_registry, deps.targets, deps.bridge
    triples = targets.rdf() if targets is not None else None
    if triples is None or registry is None or targets is None or bridge is None:
        return ["rebuild needs RDF_ENDPOINT, the database, the publishing targets and the bridge"]
    sent = deliveries if deliveries is not None else []

    def load(graph_iri: str, version: int, body: bytes) -> None:
        package = build_graph_package(
            graph_iri, version, body.decode("utf-8"), deployment=deps.deployment
        )
        sent.append((triples.id, deliver_graph_package(deps, package, triples, None)))

    lines: list[str] = []
    ontologies = graphs = missing = 0
    for ontology_id, version, _base, graph_iri in registry.all_ontologies():
        data = deps.store.get_optional(
            deps.buckets.runs, ontology_normalized_key(ontology_id, version)
        )
        if data is None:
            missing += 1
            lines.append(f"missing {ontology_id} v{version}: import it again in the library")
            continue
        load(graph_iri, version, data)
        ontologies += 1
        lines.append(f"loaded {graph_iri}")
    for g in registry.all_current():
        try:
            target = targets.get(g.target_id)  # where this version's copy was written
        except DocumentError as exc:
            missing += 1
            lines.append(f"missing {g.graph_iri} v{g.version}: {exc}")
            continue
        key = target.prefix + graph_version_key(g.sha256, g.template_id, g.version)
        body = bridge.read_object(target.id, target.bucket, key)
        if body is None:
            missing += 1
            lines.append(f"missing {key}")
            continue
        load(g.graph_iri, g.version, body)
        graphs += 1
        lines.append(f"loaded {g.graph_iri} v{g.version}")
    lines.append(
        f"rebuild: {ontologies} ontology graphs, {graphs} document graphs, {missing} missing"
    )
    return lines


def _mapped(definition: dict[str, Any]) -> Template | None:
    try:
        template = Template.model_validate(definition)
    except ValidationError:
        return None
    if template.semantics is None or "rdf" not in template.delivery_formats():
        return None
    return template


def backfill(
    deps: PipelineDeps,
    queue: JobQueue,
    source: RebuildSource,
    template_id: str,
    deliveries: list[tuple[str, str]] | None = None,
) -> list[str]:
    published = source.published_templates(template_id)
    mapped = [t for v in sorted(published, reverse=True) if (t := _mapped(published[v]))]
    if not mapped or deps.graph_registry is None:
        return [f"{template_id} has no published recipe with an ontology mapping that delivers rdf"]
    template = mapped[0]
    lines: list[str] = []
    done = skipped = 0
    seen: set[str] = set()
    for job in source.delivered_jobs(template_id):
        if job.sha256 in seen or deps.graph_registry.current(job.sha256, template_id):
            seen.add(job.sha256)
            skipped += 1
            continue
        seen.add(job.sha256)
        try:
            version = _publish(deps, queue, source, job, template, deliveries)
        except DocumentError as exc:
            version = None
            lines.append(f"skipped {job.job_id}: {exc}")
        if version is None:
            skipped += 1
            continue
        done += 1
        lines.append(f"published {job.sha256}/{template_id} v{version} from job {job.job_id}")
    lines.append(f"backfill {template_id} v{template.version}: {done} published, {skipped} skipped")
    return lines


def remint(
    deps: PipelineDeps,
    queue: JobQueue,
    source: RebuildSource,
    deliveries: list[tuple[str, str]] | None = None,
) -> list[str]:
    """The graph under the old base is dropped first (through the triple store target): a
    failure after that leaves the version under the old base, so the next run picks the graph up
    again (never two copies)."""
    registry, bridge = deps.graph_registry, deps.bridge
    triples = deps.targets.rdf() if deps.targets is not None else None
    base = deps.linked_data.effective_base() if deps.linked_data else None
    if registry is None or base is None:
        return ["remint needs the database and a Linked data base"]
    lines: list[str] = []
    moved = already = failed = 0
    for g in registry.all_current():
        if g.base_iri == base:
            already += 1
            continue
        job = source.job(g.job_id)
        definition = source.published_templates(g.template_id).get(g.template_version)
        template = _mapped(definition) if definition else None
        if job is None or template is None:
            failed += 1
            lines.append(f"skipped {g.graph_iri}: its job or recipe version is gone")
            continue
        try:
            job_target(deps, source, job)  # a missing target fails before the drop
            if triples is not None and bridge is not None:
                bridge.delete_objects(triples.id, [(triples.bucket, g.graph_iri)])
            version = _publish(deps, queue, source, job, template, deliveries)
        except (DocumentError, BridgeUnavailable) as exc:
            failed += 1
            lines.append(f"failed {g.graph_iri}: {exc} (run --remint again)")
            continue
        if version is None:
            failed += 1
            lines.append(f"skipped {g.graph_iri}: no delivered document")
            continue
        moved += 1
        lines.append(f"re-minted {g.graph_iri} as v{version}")
    lines.append(
        f"remint under {base}: {moved} re-minted, {already} already there, {failed} failed"
    )
    return lines


class RebuildParams(BaseModel):
    """A `rebuild` job's params. A restore queues them: a deployment restore from a backup
    without triples `rebuild`; a copy `remint`, or `rebuild-remint` when its backup had no
    triples (the store is reloaded from the published copies, then re-minted under this
    server's base, in one job so two worker replicas never interleave the two)."""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["remint", "rebuild", "rebuild-remint"]


#: Job event of a finished `rebuild` job (`{mode, summary}`: the command's last line).
REBUILT = "rebuilt"


def run_rebuild_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue
) -> tuple[list[str], list[tuple[str, str]]]:
    """The `rebuild` task: the operator command as a job, so a copy restore can re-mint the
    graphs under this server's base once an admin resumes the worker. Per-graph failures are
    lines of the summary, as for the command (run it again); nothing is output. Returns the
    lines and the bridge's deliveries, which finish the job."""
    try:
        params = RebuildParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid rebuild parameters: {exc}") from exc
    source = deps.delivered_jobs
    if params.mode != "rebuild" and source is None:
        raise DocumentError("re-minting needs the database")
    summary: list[str] = []
    lines: list[str] = []
    deliveries: list[tuple[str, str]] = []
    if params.mode in ("rebuild", "rebuild-remint"):
        reloaded = rebuild(deps, deliveries)
        lines += reloaded
        summary.append(reloaded[-1])
    if params.mode in ("remint", "rebuild-remint"):
        assert source is not None
        reminted = remint(deps, queue, source, deliveries)
        lines += reminted
        summary.append(reminted[-1])
    queue.event(job.id, "info", REBUILT, {"mode": params.mode, "summary": "; ".join(summary)})
    return lines, deliveries


def main(argv: list[str] = sys.argv[1:]) -> int:
    from .bridge.client import HttpBridgeClient
    from .config import Settings
    from .graph_registry import PgGraphRegistry
    from .linked_data import PgLinkedDataSettings
    from .llm.registry import ModelRegistry
    from .ontology import PgOntologyStore
    from .pdf import extract_pages
    from .pipeline import Buckets
    from .publish_targets import LiveTargets, PgPublishTargetStore
    from .queue import PgJobQueue
    from .specs import load_specs
    from .storage import S3ObjectStore

    parser = argparse.ArgumentParser(prog="python -m ingest_worker.rdf_rebuild")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--backfill", metavar="TYPE", help="publish TYPE's missing graphs")
    group.add_argument("--remint", action="store_true", help="re-mint under the current base")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    library = psycopg.connect(settings.database_url, autocommit=True)
    deps = PipelineDeps(
        store=S3ObjectStore(
            settings.s3_endpoint, settings.s3_region, settings.s3_access_key, settings.s3_secret_key
        ),
        specs=load_specs(settings.specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=extract_pages,
        buckets=Buckets(settings.bucket_inbox, settings.bucket_outputs, settings.bucket_runs),
        targets=LiveTargets(
            PgPublishTargetStore.connect(settings.database_url),
            rdf_expected=bool(os.environ.get("RDF_ENDPOINT")),
        ),
        bridge=HttpBridgeClient(settings.bridge_url, settings.bridge_client_key),
        ontologies=PgOntologyStore(library),
        linked_data=PgLinkedDataSettings(library),
        graph_registry=PgGraphRegistry(psycopg.connect(settings.database_url, autocommit=True)),
    )
    queue = PgJobQueue(settings.database_url)
    source = PgRebuildSource(library)
    if args.backfill:
        lines = backfill(deps, queue, source, args.backfill)
    elif args.remint:
        lines = remint(deps, queue, source)
    else:
        lines = rebuild(deps)
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
