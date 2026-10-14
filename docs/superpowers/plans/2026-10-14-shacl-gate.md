# SHACL Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipe can pin SHACL shapes. Every mapped document's graph is validated against them. Violations become review reasons at processing, and they stop a publish that delivers RDF: the job goes back to review instead of delivering. Violations show in the Review screen's Graph tab and in the Workbench graph previews.

**Architecture:**
- **Validation:** `rdf.validate(graph, shapes, ontologies)` runs pySHACL with `inference="none"`. The ontologies' graphs are passed as `ont_graph`, so `sh:class` checks see `rdfs:subClassOf`. The shapes and ontology graphs are the pinned versions' normalised N-Triples, already stored in the runs bucket at import (`ontology_normalized_key`).
- **The report:** stored as `{job}/shacl-report.json` in the runs bucket, readable through a new API route, and rendered in the Review screen's new Graph tab.

**Tech Stack:** Python (rdflib, pySHACL), TypeScript (Zod, Fastify, React).

**Spec:** `docs/design/rdf-publishing.md`: *Rendering and SHACL*, *Production: process, review and publish*, *Review in the Mapping tab*, *Rollout* step 5.

## Global Constraints

- **Shapes:** `semantics.shapes` pins library versions (ready). The API checks them like `semantics.ontologies`: unknown → `unknown ontology X vN`, not ready → `ontology X vN is not ready (status)`.
- **Validation:** runs only when the recipe has shapes and a graph was rendered. pySHACL runs with `inference="none"` and the pinned ontologies as `ont_graph`.
- **Processing:**
  - Each `sh:Violation` adds the review reason `SHACL: <shape> on <output>: <message>`. `<output>` is the field or `table.column` whose mapped property is the result path, else the path IRI.
  - Warnings and infos become issues with step `shacl`.
- **Report:** `{job}/shacl-report.json` holds `{ conforms, results: [{ severity, shape, focus, path, output, message, value }] }`.
- **Publishing:**
  - **When RDF is delivered:** the graph is rendered and validated before any write. Violations move the job back to `awaiting_review` with them as reasons and the event `publish refused: graph violates shapes`, and nothing is delivered.
  - **When RDF is not delivered:** violations are a warn event, never a refusal.
- **Job status contract:** the new transition is `publish → awaiting_review`. Approving again re-queues the publish.
- **Test runs** (`deliver=False`) validate too, and write the report to the runs bucket only.
- **Graph previews** return each sample's report.

## Review Focus

1. A shapes version that is not ready, or a normalised file that is missing, when a job runs: the job goes to review with a clear reason, never fails silently or crashes.
2. A recipe with shapes but no rendered graph (no base IRI): no validation, and no reason or refusal.
3. A publish refused by shapes, then approved after an edit fixes the value: it publishes.
4. A violation whose path is a property no output maps (provenance, `rdf:type`): the reason names the path IRI.
5. Large graphs: validation runs once per job and never per step.

---

### Task 1: `rdf.validate` and the shapes loader (worker)

- **Dependency:** add `pyshacl` with `uv add pyshacl`.
- **`rdf.py`:** `ShaclResult`, `ShaclReport` (`conforms`, `results`, `violations()`), `validate(graph, shapes, ontologies, outputs_by_property) -> ShaclReport`, and `report_json(report)`.
- **New `shacl.py`:** `load_graphs(deps, pins) -> Graph`. It reads `ontology_normalized_key(id, version)` from the runs bucket and raises `DocumentError` (`shapes acme v1 are not available: …`) when a file is missing. It also provides `outputs_by_property(template, prefixes) -> dict[iri, output]`.
- **Tests (`worker/tests/test_shacl.py`):**
  - conforming;
  - a `sh:minCount` violation mapped to its output;
  - a `sh:class` check passing through `rdfs:subClassOf` in the ontology graph;
  - a `sh:Warning` result;
  - a missing shapes file raising `DocumentError`.

### Task 2: Validation during processing and in previews (worker)

- **`template_pipeline.build_graph`:** returns the graph as well. A new `validate_graph(job, deps, queue, template, graph) -> ShaclReport | None` writes the report.
- **`process_template_job`:**
  - violations are added to `reasons`;
  - warnings and infos to `issues`.
- **`graph_preview`:** each sample carries `report`, and `GraphPreviewResultSchema` gains it (TS too).
- **Tests:**
  - a recipe with shapes and a violating value stops in review with the SHACL reason, and the report is stored;
  - with no base IRI, nothing is validated;
  - a preview carries its report.

### Task 3: The publish gate (worker)

- **`publish_template_job`:** when `rdf` is delivered and the shapes are violated, it raises `ShapesViolated(reasons)` before any write.
- **`main.py`:** catches it, records the event `publish refused: graph violates shapes`, and calls `queue.await_review(job, [], outputs, reasons)`.
- **When `rdf` is not delivered:** a warn event `graph violates shapes`, and the publish carries on.
- **Tests:**
  - **Refusal:** the job is refused and back in review, with nothing at the target;
  - **Not delivered:** RDF off means the publish succeeds with the event;
  - **Fixed value:** an edit fixes the value and the job publishes on re-approval.

### Task 4: API

- **`semanticsIssues`:** checks the `shapes` pins.
- **New route `GET /api/jobs/:id/shacl-report`** (any user; documented):
  - `200` with the report (`ShaclReportSchema` in `packages/shared/src/jobs.ts`);
  - `404` with `no SHACL report for this job`.
- **`GraphPreviewResultSchema`:** the samples' `report`.
- **Tests:** semantics issues for shapes pins; the report route (with and without a report); the OpenAPI conformance sweep.

### Task 5: Web

- **`MappingEditor`:** a Shapes section to pin shape versions (reusing `PinForm`).
- **Review screen:** a **Graph** tab, for jobs with a graph output. It shows the Turtle (fetched through the outputs route) and the SHACL report (`getShaclReport`), each violation linking to the field or column it names (the existing field focus).
- **Graph preview:** shows each sample's violations.
- **Tests:** `MappingEditor` shapes; the Review Graph tab; the preview violations.

### Task 6: Docs and contracts

- **CLAUDE.md:**
  - the job status contract (`publish → awaiting_review`);
  - the SHACL report (key, schema, route);
  - `GraphPreviewResult.report`.
- **Design doc:** step 5 notes.
- **Checks:** run `npm run check`, the worker suite and lint, and the Pg suites. Then the final review, the fix pass, and a PR with Auto-fix and auto-merge.
