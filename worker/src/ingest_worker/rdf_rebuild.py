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
import sys
from dataclasses import dataclass, field
from typing import Any, Protocol

import psycopg
from pydantic import ValidationError

from .graph_store import GraphStoreUnavailable
from .pipeline import DocumentError, PipelineDeps, Target
from .publish_targets import DEFAULT_TARGET_ID
from .queue import ClaimedJob, JobQueue
from .storage import (
    graph_version_key,
    ontology_normalized_key,
    output_key,
    reviewed_document_key,
)
from .template import Template
from .template_pipeline import build_graph, publish_graph


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
                WHERE d.spec_id = %s AND NOT j.test
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
    """The publishing target of the job's own recipe version (a version not published as a
    recipe, a legacy spec: the default)."""
    if deps.targets is None:
        raise DocumentError("no publishing targets")
    definition = source.published_templates(job.template_id).get(job.template_version)
    if definition is None:
        return deps.targets.get(DEFAULT_TARGET_ID)
    try:
        template = Template.model_validate(definition)
    except ValidationError as exc:
        raise DocumentError(f"recipe {job.template_id} v{job.template_version} is invalid") from exc
    return deps.targets.get(template.publish_to())


def _publish(
    deps: PipelineDeps,
    queue: JobQueue,
    source: RebuildSource,
    job: DeliveredJob,
    template: Template,
) -> int | None:
    """Render a delivered job's reviewed document with `template` and publish its graph, its
    copy to the target of the job's own recipe version."""
    document = delivered_document(deps, job)
    if document is None:
        return None
    target = job_target(deps, source, job)
    run = claimed(job, template.version)
    graph = build_graph(run, deps, queue, template, document)
    if graph is None:
        return None
    return publish_graph(run, deps, queue, template, document, graph, target)


def rebuild(deps: PipelineDeps) -> list[str]:
    store, registry, targets = deps.graph_store, deps.graph_registry, deps.targets
    if store is None or registry is None or targets is None:
        return ["rebuild needs RDF_ENDPOINT, the database and the publishing targets"]
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
        store.put(graph_iri, data, "application/n-triples")
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
        body = target.store.get_optional(target.bucket, key)
        if body is None:
            missing += 1
            lines.append(f"missing {key}")
            continue
        store.put(g.graph_iri, body, "text/turtle")
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
    deps: PipelineDeps, queue: JobQueue, source: RebuildSource, template_id: str
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
            version = _publish(deps, queue, source, job, template)
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


def remint(deps: PipelineDeps, queue: JobQueue, source: RebuildSource) -> list[str]:
    """The graph under the old base is dropped first: a failure after that leaves the version
    under the old base, so the next run picks the graph up again (never two copies)."""
    registry, store = deps.graph_registry, deps.graph_store
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
            if store is not None:
                store.delete(g.graph_iri)
            version = _publish(deps, queue, source, job, template)
        except (DocumentError, GraphStoreUnavailable) as exc:
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


def main(argv: list[str] = sys.argv[1:]) -> int:
    from .config import Settings
    from .graph_registry import PgGraphRegistry
    from .graph_store import graph_store_from_env
    from .linked_data import PgLinkedDataSettings
    from .llm.registry import ModelRegistry
    from .ontology import PgOntologyStore
    from .pdf import extract_pages
    from .pipeline import Buckets
    from .publish_targets import LiveTargets, PgPublishTargetStore, S3Settings
    from .queue import PgJobQueue
    from .specs import load_specs
    from .storage import S3ObjectStore

    parser = argparse.ArgumentParser(prog="python -m ingest_worker.rdf_rebuild")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--backfill", metavar="TYPE", help="publish TYPE's missing graphs")
    group.add_argument("--remint", action="store_true", help="re-mint under the current base")
    args = parser.parse_args(argv)

    import os

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
            S3Settings(
                settings.s3_endpoint,
                settings.s3_region,
                settings.s3_access_key,
                settings.s3_secret_key,
            ),
        ),
        ontologies=PgOntologyStore(library),
        linked_data=PgLinkedDataSettings(library),
        graph_registry=PgGraphRegistry(psycopg.connect(settings.database_url, autocommit=True)),
        graph_store=graph_store_from_env(os.environ),
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
