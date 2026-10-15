# Ontology Import from a Folder or Zip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import every ontology file of a selected folder, or of a `.zip`, in one go, either merged into one library ontology or as one library ontology per file (the user chooses each time). Multi-file ontologies such as IDMP-O (75 Turtle files that import one another) then import without one-by-one uploads.

**Architecture:**
- **One route,** `POST /api/ontologies/batch` (multipart). Its fields come first:
  - `mode`: `merge` or `separate`;
  - for `merge`: `id`, `label`, `description`;
  - for `separate`: `idPrefix`;
  - for both: `tags` and `localOnly`.

  The parts that follow are many RDF files, or one `.zip` that the API unpacks (keeping only files `ontologyFormat` recognises, and skipping hidden entries and `__MACOSX`).
- **Merge:** one `ontology_versions` row with `source_kind = 'files'`.
  - `source_files` (jsonb) lists each file: `fileName`, `sha256`, `bytes`, `mediaType`.
  - `sha256` is computed over the sorted file hashes, so importing the same folder again is caught as a duplicate.
  - The worker parses every file into one graph. An `owl:imports` of an IRI that one of the files declares is recorded with resolution `included`; it is not looked up.
- **Separate:** one version row per file, under ids from the shared `fileOntologyIds(paths, prefix)`, and **one** `ontology` job whose params list the members.
  - The worker parses every member, then resolves imports between members from memory before trying the library or the web. Dependency order therefore doesn't matter.
  - A member whose file cannot be read fails alone.
  - A member that duplicates an existing version is skipped and reported.
- **All `owl:Ontology` IRIs** of a version are stored in `ontology_versions.ontology_iris`, so `find_ready` matches any module of a merged version.

**Tech stack:** Postgres 17, Fastify, Zod, fflate, React, Python 3.13 (rdflib), Pydantic.

**Spec:** this plan (feature request of 2026-10-15). The ontology library is [ADR 0011](../../adr/0011-rdf-publishing-and-ontologies.md), with the design in `docs/design/rdf-publishing.md` (*Ontology library*).

## Global constraints
- **Limits:**
  - at most `ONTOLOGY_MAX_FILES` = 300 RDF files per batch;
  - the total upload stays within `maxUploadBytes` (the app's nginx allows 60 MB);
  - a zip's inflated bytes stay within `ONTOLOGY_MAX_BYTES` (`ontologyFetch.maxBytes`), with at most 10,000 entries;
  - the worker's `ONTOLOGY_MAX_TRIPLES` applies to each version with its imports.
- **Ids:** `fileOntologyIds` gives `prefix + slug(file stem)`, trimmed to satisfy `ONTOLOGY_ID_RE`, and adds `-2`, `-3`… on collisions. The web previews it and the API decides with the same function.
- **Existing ids:** a separate-mode id that already exists gets its next version; a new id takes the file stem as its name.
- **Admin only**, like the other ontology writes. Documented in OpenAPI, and covered by the access sweep.
- **Migrations are forward-only:** `0038_ontology_batches.sql`.

## Review focus
1. A folder with non-RDF files, hidden files and subfolders: only RDF files are taken, with paths kept as file names.
2. Two files with the same stem in different subfolders (separate mode): distinct ids.
3. Re-importing the same folder: merge gives a 409 duplicate; separate skips every member as a duplicate (nothing is queued when all are skipped).
4. A zip bomb or a zip with too many entries: a 400 before anything is stored.
5. One unreadable file in separate mode: only its version fails.

---

### Task 1: Contract and migration
- **Migration** `db/migrations/0038_ontology_batches.sql`:
  - `source_kind` CHECK adds `'files'`;
  - adds `source_files jsonb`;
  - adds `ontology_iris text[] NOT NULL DEFAULT '{}'`, backfilled from `ontology_iri`.
- **Shared** (`packages/shared/src/ontologies.ts`):
  - `ONTOLOGY_SOURCE_KINDS` adds `files`;
  - `OntologyImportSchema.resolution` adds `included`;
  - `OntologyVersionView.sourceFiles` (nullable list);
  - `ONTOLOGY_MAX_FILES`;
  - `fileOntologyIds`;
  - `OntologyBatchResultSchema` (`{ versions: OntologyVersionView[], skipped: { fileName, ontologyId, reason }[] }`).
- **Tests:** table tests for `fileOntologyIds` (prefix, slug, the 63-character trim, collisions, a stem too short).

### Task 2: Worker
- **`OntologyJobParams`:** exactly one of `sourceKey`, `sourceUrl`, `sources` (merge: `{sourceKey, fileName, mediaType}[]`) or `members` (separate: `{ontologyId, version, sourceKey, fileName, mediaType}[]`). With `members`, the top-level `ontologyId` and `version` are absent.
- **Merge:** parse each source into one graph, keeping the triple cap across files. `run_ontology_import` records `included` entries for imports declared inside the set and resolves the rest.
- **Separate:** `run_ontology_batch`:
  - parses every member (`store.start`, and `store.fail` for an unreadable one);
  - builds a header-IRI → member map;
  - resolves with `_ImportResolver(batch=…)`, which checks the batch before `find_ready`;
  - saves each member (its normalised file and terms), then calls `embed_after_import` for each.
- **`ParsedOntology.ontology_iris`:** every header. `PgOntologyStore.save` writes it, `find_ready` matches it, and `MemoryOntologyStore` matches it too.
- **Tests** (`worker/tests/test_ontology_job.py`):
  - merge: the imports between the files are `included`;
  - separate: imports between members resolve to members whatever the order, and one bad member fails alone;
  - `find_ready` matches a second header;
  - the params validation table.

### Task 3: API
- **Route** `POST /api/ontologies/batch` in `routes/ontologies.ts`:
  - read the fields, then the file parts (`req.parts()`, a file-count limit, a total-bytes cap);
  - a `.zip` part is unpacked in memory through fflate, under the caps;
  - store each source at `ontologySourceKey(id, sha, ext)` (merge: under the merged id; separate: under each member's id);
  - then `OntologyRepo.createBatch`.
- **`createBatch`** (Memory and Pg): one transaction, the ontology locks in sorted id order, duplicate checks, and one job (merge params `sources`, separate params `members`). It returns created versions and skipped members. When nothing is created, no job is queued, and the route removes the objects it stored.
- **Deleting a `files` version** removes all of its source objects. Downloading its source answers 404 `this version was imported from N files`.
- **Tests:**
  - `apps/api/test/ontologies.test.ts`: both modes, a zip, the caps, duplicates, admin only, OpenAPI conformance;
  - `apps/api/test/integration/ontology-pg.test.ts`: `createBatch`.

### Task 4: Web
- **Client:** `importOntologyBatch(files, fields)`. The fields go before the files; each file part's name is its relative path (`webkitRelativePath`).
- **`ImportOntologyDialog`:** a third source, **From a folder or .zip**.
  - A folder input (`webkitdirectory`) or a `.zip` input.
  - The folder is summarised: "n ontology files · k other files left out".
  - A mode `Segmented`: *One ontology* (Name, Id, Tags, Local only) or *One per file* (Id prefix, Tags, Local only, and a preview of the first ids, saying which already exist).
  - Import gives its disabled reason, as before.
  - The result says "n versions queued, k skipped".
- **Ontology page:** the imports panel shows `included` (inside this version). A `files` version lists its files.
- **Tests:** `OntologiesPage.test.tsx` and `OntologyPage.test.tsx`.

### Task 5: Docs and checks
- **CLAUDE.md:** the ontology-library contract row (batch, `source_files`, `ontology_iris`, `included`).
- **Design doc:** an as-built note.
- **`docs/openapi.json`:** regenerated.
- **Checks:** `npm run check`, the worker and Pg suites, then a final review and a PR.
