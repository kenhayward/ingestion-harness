# Ontology Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins import OWL/RDFS, SKOS and SHACL files as immutable ontology versions. The
worker parses each version and indexes its terms. Everyone can browse the library as a tree
with a term detail pane. This is rollout step 1 of ADR 0011.

**Architecture:**
- **API:** stores the uploaded file in the runs bucket (content-addressed), then in one
  transaction creates the ontology, the version row and a document-less `ontology` job.
- **Worker:** claims the job, parses the file with rdflib (pure `parse_ontology`), writes
  canonical N-Triples to the runs bucket, and indexes the terms into `ontology_terms` through
  an `OntologyStore` port.
- **Browsing:** the API serves term search, tree children and term detail from Postgres
  (`pg_trgm` for search). The web adds an Ontologies page and an ontology view with a lazy tree.

**Tech Stack:** Postgres 17 (`pg_trgm`), Python 3.13 worker (rdflib, psycopg 3,
pydantic), Fastify/TypeScript API (Zod, `pg`), React web (Testing Library, vitest).

**Spec:** `docs/design/rdf-publishing.md` (section *Ontology library*) and
`docs/adr/0011-rdf-publishing-and-ontologies.md`.

## Global Constraints

- **Scope (rollout step 1):** file upload only. Not in this plan: URL import, resolving
  `owl:imports`, the neighbourhood graph view, embeddings, loading into Fuseki.
- **Imports are listed, not resolved.** `owl:imports` IRIs are recorded as
  `{ iri, resolution: 'unresolved' }`.
- **Ids:** an ontology id matches `^[a-z0-9][a-z0-9-]{1,62}$`.
- **Immutability:** a `ready` version is immutable, enforced by a DB trigger. Importing
  identical bytes again under the same id is a 409 that names the existing version.
- **Size limits:** `ONTOLOGY_MAX_TRIPLES` defaults to 2,000,000. The upload limit is the
  existing `maxUploadBytes`.
- **Safe parsing:**
  - RDF/XML declaring an external entity (`<!ENTITY … SYSTEM|PUBLIC`) is refused.
    Internal entities (Protégé style) are allowed.
  - JSON-LD naming a remote `@context` or `@import` (a string) is refused.
- **Job:** `ontology` is a document-less job with `priority = -10` and `max_attempts = 3`.
  Its `created_by` is the token label.
- **Access:** any signed-in user can read. Writes are admin-only, enforced by a preHandler
  that replies `403 { error: 'admins only' }` before any other check (the OpenAPI x-admin
  sweep depends on it).
- **Docs and tests:** every new route has an OpenAPI `schema` (tag `Ontologies`) and lists
  every status code it can send.
- **UI copy:** "Ontologies", "Import ontology", "Local only". Use plain words.
- **TDD (CLAUDE.md):** red first, never weaken a test, `npm run check` and
  `npm run worker:lint` green at the end.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Wrong extension:** a file whose extension says Turtle but contains RDF/XML or garbage
   must end in a `failed` version with a readable message, never stuck in `parsing`.
   Covered in Task 2 (garbage) and Task 3 (status `failed`).
2. **Anonymous classes:** blank-node superclasses (`owl:Restriction`) must not appear as terms
   or parents. Parents outside the file make a term a root rather than hiding it. Covered in
   Task 2.
3. **Subclass cycles:** `A ⊂ B ⊂ A` must stay reachable in the tree (both become roots), and
   the UI must not expand a node inside its own ancestry forever. Covered in Task 2 (roots)
   and Task 8 (`visibleRows` cycle).
4. **Labels:** a term with only non-English labels uses one of them; a term with no label uses
   its IRI's local name. Covered in Task 2.
5. **Deleting during import:** deleting a version that is still `queued` or `parsing` is a 409,
   and deleting the last version removes the ontology. Covered in Tasks 4 and 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `db/migrations/0032_ontologies.sql` | Tables `ontologies`, `ontology_versions`, `ontology_terms`; `pg_trgm`; immutability trigger; `jobs_task_check` gains `ontology` |
| `packages/shared/src/ontologies.ts` | Zod schemas and types shared by API and web; formats by extension; term groups |
| `packages/shared/src/storage-keys.ts` | `ontologySourceKey`, `ontologyNormalizedKey` |
| `packages/shared/src/jobs.ts` | task enum gains `ontology` |
| `worker/src/ingest_worker/ontology.py` | `parse_ontology` (pure), `OntologyStore` protocol, `PgOntologyStore`, `run_ontology_import` |
| `worker/src/ingest_worker/storage.py` | `ontology_normalized_key` |
| `worker/src/ingest_worker/pipeline.py` | `PipelineDeps.ontologies`, `ontology_max_triples` |
| `worker/src/ingest_worker/main.py`, `config.py` | dispatch `ontology` jobs; wire `PgOntologyStore`; `ONTOLOGY_MAX_TRIPLES` |
| `worker/tests/test_ontology.py`, `test_ontology_job.py`, `fakes.py` | parser table tests; job tests; `MemoryOntologyStore` |
| `apps/api/src/ontologies/repo.ts` | `OntologyRepo` interface, `MemoryOntologyRepo`, `PgOntologyRepo` |
| `apps/api/src/routes/ontologies.ts` | 8 routes |
| `apps/api/src/app.ts`, `server.ts`, `openapi/document.ts`, `openapi/zod.ts` | wiring, tag, multipart file description |
| `apps/api/test/ontologies.test.ts`, `test/integration/ontology-pg.test.ts` | route tests; Pg repo test |
| `apps/web/src/api/client.ts`, `test/fake-api.ts` | 7 Api methods + `ontologySourceUrl`; fakes and fixtures |
| `apps/web/src/router.ts`, `shell/derive.ts`, `shell/AppShell.tsx`, `App.tsx`, `ui/Icon.tsx` | routes `#/ontologies`, `#/ontologies/<id>`; nav; `graph` icon |
| `apps/web/src/ontologies/derive.ts` | pure helpers: status text, stats line, slugify, tree rows |
| `apps/web/src/ontologies/OntologiesPage.tsx`, `ImportOntologyDialog.tsx` | library list, import |
| `apps/web/src/ontologies/OntologyPage.tsx`, `EditOntologyDialog.tsx`, `TermBrowser.tsx`, `TermTree.tsx`, `TermDetailPanel.tsx` | ontology view |
| `apps/web/src/styles.css` | "Ontologies" section |
| `CLAUDE.md`, `docs/design/rdf-publishing.md`, `docs/openapi.json` | contracts table, keys, regenerated API document |

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0032_ontologies.sql`
- Create: `packages/shared/src/ontologies.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/storage-keys.ts`, `packages/shared/src/jobs.ts:55-62`
- Test: `packages/shared/test/ontologies.test.ts`

**Interfaces:**
- Produces: the Zod schemas and types `OntologySummary`, `OntologyDetail`,
  `OntologyVersionView`, `OntologyStats`, `OntologyPatch`, `OntologyTerm`, `TermRef`,
  `TermPage`, `TermDetail`, `TermGroup`, `OntologyTermKind`. Also `TERM_GROUPS`,
  `ONTOLOGY_ID_RE`, `TAG_RE`, `ONTOLOGY_ACCEPT`, `ontologyFormat(fileName)`,
  `ONTOLOGY_INDEXED_EVENT`, `ontologySourceKey(id, sha256, ext)` and
  `ontologyNormalizedKey(id, version)`.

- [ ] **Step 1: Write the failing test** `packages/shared/test/ontologies.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  ONTOLOGY_ID_RE,
  OntologyPatchSchema,
  TERM_GROUPS,
  ontologyFormat,
  ontologyNormalizedKey,
  ontologySourceKey,
} from '../src/index.js';

describe('ontologyFormat', () => {
  it.each([
    ['idmp.ttl', { ext: 'ttl', mediaType: 'text/turtle' }],
    ['IDMP.OWL', { ext: 'owl', mediaType: 'application/rdf+xml' }],
    ['x.rdf', { ext: 'rdf', mediaType: 'application/rdf+xml' }],
    ['ctx.jsonld', { ext: 'jsonld', mediaType: 'application/ld+json' }],
    ['dump.nt', { ext: 'nt', mediaType: 'application/n-triples' }],
    ['old.n3', { ext: 'n3', mediaType: 'text/n3' }],
    ['notes.pdf', null],
    ['noext', null],
  ])('%s', (name, expected) => {
    expect(ontologyFormat(name)).toEqual(expected);
  });
});

describe('ontology ids', () => {
  it.each([
    ['idmp-o', true],
    ['a1', true],
    ['x', false],
    ['-idmp', false],
    ['IDMP', false],
    ['idmp_o', false],
  ])('%s → %s', (id, ok) => {
    expect(ONTOLOGY_ID_RE.test(id)).toBe(ok);
  });
});

describe('OntologyPatchSchema', () => {
  it('accepts known fields and refuses others', () => {
    expect(OntologyPatchSchema.safeParse({ label: 'IDMP-O', retired: true }).success).toBe(true);
    expect(OntologyPatchSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(OntologyPatchSchema.safeParse({ tags: ['Industry Pharma'] }).success).toBe(false);
  });
});

describe('ontology keys and groups', () => {
  it('names sources by their bytes and normalized files by version', () => {
    expect(ontologySourceKey('idmp-o', 'ab12', 'ttl')).toBe('ontologies/idmp-o/sources/ab12.ttl');
    expect(ontologyNormalizedKey('idmp-o', 3)).toBe('ontologies/idmp-o/v3/normalized.nt');
  });

  it('puts every kind in exactly one group', () => {
    const kinds = Object.values(TERM_GROUPS).flat();
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/shared/test/ontologies.test.ts`
Expected: FAIL. The imports are not exported (`ontologyFormat is not a function` or a TS
import error).

- [ ] **Step 3: Write `packages/shared/src/ontologies.ts`**

```ts
import { z } from 'zod';

/** Ontology library (ADR 0011, docs/design/rdf-publishing.md). */

/** Library ids: what briefs and recipes will pin as `{ id, version }`. */
export const ONTOLOGY_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Tags such as `industry:pharma` or `customer:acme`. */
export const TAG_RE = /^[a-z0-9][a-z0-9:._-]{0,62}$/;

export const ONTOLOGY_TERM_KINDS = [
  'class',
  'object_property',
  'datatype_property',
  'annotation_property',
  'concept',
  'scheme',
  'shape',
] as const;
export const OntologyTermKindSchema = z.enum(ONTOLOGY_TERM_KINDS);
export type OntologyTermKind = z.infer<typeof OntologyTermKindSchema>;

/** The browser's tabs. A top concept's parent is its scheme, so concepts and schemes share one tree. */
export const TERM_GROUPS = {
  classes: ['class'],
  properties: ['object_property', 'datatype_property', 'annotation_property'],
  concepts: ['scheme', 'concept'],
  shapes: ['shape'],
} as const satisfies Record<string, readonly OntologyTermKind[]>;
export const TermGroupSchema = z.enum(['classes', 'properties', 'concepts', 'shapes']);
export type TermGroup = z.infer<typeof TermGroupSchema>;

/** Upload formats by extension: browsers send unreliable content types for RDF files. */
const FORMATS: Record<string, string> = {
  ttl: 'text/turtle',
  owl: 'application/rdf+xml',
  rdf: 'application/rdf+xml',
  jsonld: 'application/ld+json',
  nt: 'application/n-triples',
  n3: 'text/n3',
};
export const ONTOLOGY_ACCEPT = Object.keys(FORMATS)
  .map((ext) => `.${ext}`)
  .join(',');

export function ontologyFormat(fileName: string): { ext: string; mediaType: string } | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const mediaType = ext === undefined ? undefined : FORMATS[ext];
  return ext !== undefined && mediaType !== undefined ? { ext, mediaType } : null;
}

export const ONTOLOGY_STATUSES = ['queued', 'parsing', 'ready', 'failed'] as const;
export type OntologyStatus = (typeof ONTOLOGY_STATUSES)[number];

export const OntologyStatsSchema = z.object({
  triples: z.number().int(),
  classes: z.number().int(),
  properties: z.number().int(),
  concepts: z.number().int(),
  schemes: z.number().int(),
  shapes: z.number().int(),
});
export type OntologyStats = z.infer<typeof OntologyStatsSchema>;

export const OntologyVersionViewSchema = z.object({
  ontologyId: z.string(),
  version: z.number().int(),
  status: z.enum(ONTOLOGY_STATUSES),
  fileName: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
  ontologyIri: z.string().nullable(),
  versionIri: z.string().nullable(),
  license: z.string().nullable(),
  kinds: z.array(z.enum(['owl', 'skos', 'shacl'])),
  stats: OntologyStatsSchema.nullable(),
  /** `owl:imports` of the file; resolving them against the library is rollout step 2. */
  imports: z.array(z.object({ iri: z.string(), resolution: z.literal('unresolved') })),
  error: z.string().nullable(),
  importedBy: z.string().nullable(),
  importedAt: z.string(),
});
export type OntologyVersionView = z.infer<typeof OntologyVersionViewSchema>;

export const OntologySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  localOnly: z.boolean(),
  retiredAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** The newest version, whatever its status. */
  latest: OntologyVersionViewSchema.nullable(),
  versionCount: z.number().int(),
});
export type OntologySummary = z.infer<typeof OntologySummarySchema>;

export const OntologyDetailSchema = OntologySummarySchema.extend({
  /** Newest first. */
  versions: z.array(OntologyVersionViewSchema),
});
export type OntologyDetail = z.infer<typeof OntologyDetailSchema>;

export const OntologyPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().regex(TAG_RE)).max(20).optional(),
    localOnly: z.boolean().optional(),
    retired: z.boolean().optional(),
  })
  .strict();
export type OntologyPatch = z.infer<typeof OntologyPatchSchema>;

export const OntologyTermSchema = z.object({
  iri: z.string(),
  kind: OntologyTermKindSchema,
  label: z.string(),
  altLabels: z.array(z.string()),
  definition: z.string(),
  /** Superclasses, superproperties, broader concepts; a top concept's scheme. */
  parents: z.array(z.string()),
  /** Property domains; a shape's target classes. */
  domain: z.array(z.string()),
  range: z.array(z.string()),
  scheme: z.string().nullable(),
  deprecated: z.boolean(),
  childCount: z.number().int(),
});
export type OntologyTerm = z.infer<typeof OntologyTermSchema>;

export const TermRefSchema = z.object({
  iri: z.string(),
  kind: OntologyTermKindSchema,
  label: z.string(),
});
export type TermRef = z.infer<typeof TermRefSchema>;

export const TermPageSchema = z.object({
  items: z.array(OntologyTermSchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});
export type TermPage = z.infer<typeof TermPageSchema>;

export const TermDetailSchema = OntologyTermSchema.extend({
  /** Only terms of this version; `parents` keeps every IRI. */
  parentTerms: z.array(TermRefSchema),
  children: z.array(TermRefSchema),
  domainTerms: z.array(TermRefSchema),
  rangeTerms: z.array(TermRefSchema),
  schemeTerm: TermRefSchema.nullable(),
  /** Properties whose domain or range is this class. */
  asDomain: z.array(TermRefSchema),
  asRange: z.array(TermRefSchema),
  /** A scheme's concepts. */
  concepts: z.array(TermRefSchema),
  /** Shapes targeting this class. */
  shapes: z.array(TermRefSchema),
});
export type TermDetail = z.infer<typeof TermDetailSchema>;

export const TermQuerySchema = z.object({
  group: TermGroupSchema.optional(),
  q: z.string().trim().max(200).optional(),
  parent: z.string().max(2000).optional(),
  root: z.enum(['1', 'true']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Job event when a version is indexed; mirrors `ontology.ONTOLOGY_INDEXED` in the worker. */
export const ONTOLOGY_INDEXED_EVENT = 'ontology indexed';
```

Add `export * from './ontologies.js';` to `packages/shared/src/index.ts`.

In `packages/shared/src/storage-keys.ts`, add two lines to the header comment:

```ts
 *   runs bucket:    ontologies/{ontologyId}/sources/{sha256}.{ext}   (imported ontology files)
 *   runs bucket:    ontologies/{ontologyId}/v{version}/normalized.nt   (ontology task)
```

Then append:

```ts
/** An imported ontology file, named by its bytes (runs bucket; ADR 0011). */
export function ontologySourceKey(ontologyId: string, sha256: string, ext: string): string {
  return `ontologies/${ontologyId}/sources/${sha256}.${ext}`;
}

/** A version's canonical N-Triples (runs bucket, ontology task). */
export function ontologyNormalizedKey(ontologyId: string, version: number): string {
  return `ontologies/${ontologyId}/v${version}/normalized.nt`;
}
```

In `packages/shared/src/jobs.ts`, change the task enum to
`z.enum(['process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export', 'ontology'])`.
Add a line to its doc comment: ``* `ontology`: parse and index an imported ontology version (document-less; never a JobSummary).``

- [ ] **Step 4: Write the migration** `db/migrations/0032_ontologies.sql`

```sql
-- Ontology library (ADR 0011, docs/design/rdf-publishing.md): admin-imported OWL/RDFS, SKOS and
-- SHACL files, one immutable row per imported version, and the terms the worker indexed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE ontologies (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  label       text NOT NULL CHECK (length(trim(label)) > 0),
  description text NOT NULL DEFAULT '',
  tags        text[] NOT NULL DEFAULT '{}',
  local_only  boolean NOT NULL DEFAULT false,
  retired_at  timestamptz,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ontology_versions (
  ontology_id  text NOT NULL REFERENCES ontologies (id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'parsing', 'ready', 'failed')),
  file_name    text NOT NULL,
  media_type   text NOT NULL,
  sha256       text NOT NULL,
  bytes        bigint NOT NULL,
  ontology_iri text,
  version_iri  text,
  license      text,
  kinds        text[] NOT NULL DEFAULT '{}',
  stats        jsonb,
  imports      jsonb NOT NULL DEFAULT '[]',
  error        text,
  job_id       uuid REFERENCES jobs (id) ON DELETE SET NULL,
  imported_by  text,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, version),
  UNIQUE (ontology_id, sha256)
);

CREATE TABLE ontology_terms (
  ontology_id text NOT NULL,
  version     integer NOT NULL,
  iri         text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('class', 'object_property', 'datatype_property',
                'annotation_property', 'concept', 'scheme', 'shape')),
  label       text NOT NULL,
  alt_labels  text[] NOT NULL DEFAULT '{}',
  definition  text NOT NULL DEFAULT '',
  parents     text[] NOT NULL DEFAULT '{}',
  domains     text[] NOT NULL DEFAULT '{}',
  ranges      text[] NOT NULL DEFAULT '{}',
  scheme      text,
  deprecated  boolean NOT NULL DEFAULT false,
  -- Computed by the worker: no parent in its group, or unreachable from one (cycles).
  root        boolean NOT NULL DEFAULT false,
  child_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ontology_id, version, kind, iri),
  FOREIGN KEY (ontology_id, version)
    REFERENCES ontology_versions (ontology_id, version) ON DELETE CASCADE
);
CREATE INDEX ontology_terms_label_trgm ON ontology_terms USING gin (lower(label) gin_trgm_ops);
CREATE INDEX ontology_terms_parents ON ontology_terms USING gin (parents);
CREATE INDEX ontology_terms_iri ON ontology_terms (ontology_id, version, iri);

-- A ready version is immutable: its terms were indexed from exactly these bytes.
CREATE FUNCTION ontology_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'ontology % version % is ready and cannot change', OLD.ontology_id, OLD.version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ontology_versions_immutable BEFORE UPDATE ON ontology_versions
  FOR EACH ROW EXECUTE FUNCTION ontology_versions_immutable();

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology'));
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run packages/shared/test/ontologies.test.ts && npm run build -w @ih/shared`
Expected: PASS and a clean build. The build is needed because the API and web import the
built `@ih/shared`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0032_ontologies.sql packages/shared
git commit -m "Ontology library: migration 0032 and shared contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker parser (`parse_ontology`)

**Files:**
- Modify: `worker/pyproject.toml` (add `"rdflib>=7.1"` to dependencies), then `cd worker && uv sync`
- Create: `worker/src/ingest_worker/ontology.py` (parser part)
- Modify: `worker/src/ingest_worker/storage.py` (add `ontology_normalized_key`)
- Test: `worker/tests/test_ontology.py`

**Interfaces:**
- Produces:
  - `parse_ontology(data: bytes, media_type: str, file_name: str, *, max_triples: int = DEFAULT_MAX_TRIPLES) -> ParsedOntology`
  - `rdf_format(media_type, file_name, data) -> str`
  - `local_name(iri) -> str`
  - dataclasses `Term` and `ParsedOntology`, where `ParsedOntology` has `.stats() -> dict[str, int]`
  - `DEFAULT_MAX_TRIPLES = 2_000_000`
  - `storage.ontology_normalized_key(ontology_id: str, version: int) -> str`
- Raises `DocumentError` (from `pipeline.py`) for every file it refuses.

- [ ] **Step 1: Write the failing tests** `worker/tests/test_ontology.py`

```python
from __future__ import annotations

import json

import pytest

from ingest_worker.ontology import (
    ParsedOntology,
    Term,
    local_name,
    parse_ontology,
    rdf_format,
)
from ingest_worker.pipeline import DocumentError
from ingest_worker.storage import ontology_normalized_key

PREFIXES = """
@prefix ex: <https://example.org/pv#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
"""

OWL_TTL = PREFIXES + """
<https://example.org/pv> a owl:Ontology ;
    owl:versionIRI <https://example.org/pv/2.0> ;
    dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
    owl:imports <https://example.org/base> .
ex:Document a owl:Class ; rdfs:label "Document"@en , "Dokument"@de ;
    skos:definition "Anything written down."@en .
ex:Protocol a owl:Class ; rdfs:subClassOf ex:Document ;
    rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasBatch ; owl:minCardinality 1 ] ;
    rdfs:label "Protocol"@en ; skos:altLabel "Validation protocol"@en .
ex:Batch a owl:Class ; rdfs:subClassOf <https://example.org/base#Thing> .
ex:Legacy a owl:Class ; owl:deprecated true .
ex:hasBatch a owl:ObjectProperty ; rdfs:domain ex:Protocol ;
    rdfs:range [ owl:unionOf ( ex:Batch ex:Document ) ] .
ex:batchNumber a owl:DatatypeProperty ; rdfs:domain ex:Batch ; rdfs:range xsd:string ;
    rdfs:subPropertyOf ex:identifier .
ex:identifier a rdf:Property ; rdfs:range rdfs:Literal .
ex:related a rdf:Property ; rdfs:range ex:Document .
"""


def term(parsed: ParsedOntology, iri: str) -> Term:
    [found] = [t for t in parsed.terms if t.iri == iri]
    return found


def owl() -> ParsedOntology:
    return parse_ontology(OWL_TTL.encode(), "text/turtle", "pv.ttl")


def test_reads_the_ontology_header() -> None:
    parsed = owl()
    assert parsed.ontology_iri == "https://example.org/pv"
    assert parsed.version_iri == "https://example.org/pv/2.0"
    assert parsed.license == "https://creativecommons.org/licenses/by/4.0/"
    assert parsed.imports == ["https://example.org/base"]
    assert parsed.kinds == ["owl"]


def test_indexes_classes_with_english_labels_definitions_and_parents() -> None:
    parsed = owl()
    doc = term(parsed, "https://example.org/pv#Document")
    assert (doc.kind, doc.label, doc.alt_labels) == ("class", "Document", ["Dokument"])
    assert doc.definition == "Anything written down."
    protocol = term(parsed, "https://example.org/pv#Protocol")
    # The restriction is a blank node: neither a term nor a parent.
    assert protocol.parents == ["https://example.org/pv#Document"]
    assert protocol.alt_labels == ["Validation protocol"]
    assert all(not t.iri.startswith("_:") and "://" in t.iri for t in parsed.terms)


def test_roots_and_child_counts() -> None:
    parsed = owl()
    assert term(parsed, "https://example.org/pv#Document").root
    assert term(parsed, "https://example.org/pv#Document").child_count == 1
    # Its parent is outside the file, so it is a root rather than hidden.
    assert term(parsed, "https://example.org/pv#Batch").root
    assert not term(parsed, "https://example.org/pv#Protocol").root


def test_properties_domains_ranges_and_rdf_property_kinds() -> None:
    parsed = owl()
    has_batch = term(parsed, "https://example.org/pv#hasBatch")
    assert has_batch.kind == "object_property"
    assert has_batch.domain == ["https://example.org/pv#Protocol"]
    assert has_batch.range == ["https://example.org/pv#Batch", "https://example.org/pv#Document"]
    number = term(parsed, "https://example.org/pv#batchNumber")
    assert (number.kind, number.parents) == ("datatype_property", ["https://example.org/pv#identifier"])
    assert term(parsed, "https://example.org/pv#identifier").kind == "datatype_property"
    assert term(parsed, "https://example.org/pv#related").kind == "object_property"


def test_deprecated_and_local_name_labels() -> None:
    legacy = term(owl(), "https://example.org/pv#Legacy")
    assert legacy.deprecated
    assert legacy.label == "Legacy"


def test_subclass_cycles_stay_reachable() -> None:
    ttl = PREFIXES + """
    ex:A a owl:Class ; rdfs:subClassOf ex:B .
    ex:B a owl:Class ; rdfs:subClassOf ex:A .
    """
    parsed = parse_ontology(ttl.encode(), "text/turtle", "cycle.ttl")
    assert {t.iri: t.root for t in parsed.terms} == {
        "https://example.org/pv#A": True,
        "https://example.org/pv#B": True,
    }


SKOS_TTL = PREFIXES + """
ex:Stages a skos:ConceptScheme ; skos:prefLabel "Process stages"@en .
ex:Granulation a skos:Concept ; skos:inScheme ex:Stages ; skos:prefLabel "Granulation"@en ;
    skos:altLabel "Wet granulation"@en ; skos:narrower ex:Drying .
ex:Drying a skos:Concept ; skos:inScheme ex:Stages ; skos:prefLabel "Séchage"@fr .
ex:Blending a skos:Concept ; skos:inScheme ex:Stages ; skos:broader ex:Granulation .
"""


def test_skos_top_concepts_hang_under_their_scheme() -> None:
    parsed = parse_ontology(SKOS_TTL.encode(), "text/turtle", "stages.ttl")
    assert parsed.kinds == ["skos"]
    scheme = term(parsed, "https://example.org/pv#Stages")
    assert (scheme.kind, scheme.root, scheme.child_count) == ("scheme", True, 1)
    granulation = term(parsed, "https://example.org/pv#Granulation")
    assert granulation.parents == ["https://example.org/pv#Stages"]
    assert granulation.scheme == "https://example.org/pv#Stages"
    assert granulation.child_count == 2
    # narrower on the parent counts like broader on the child.
    assert term(parsed, "https://example.org/pv#Drying").parents == ["https://example.org/pv#Granulation"]
    # Only a French label: it is used rather than the local name.
    assert term(parsed, "https://example.org/pv#Drying").label == "Séchage"


def test_shacl_shapes_record_their_target_classes() -> None:
    ttl = PREFIXES + """
    ex:Batch a owl:Class .
    ex:BatchShape a sh:NodeShape ; sh:targetClass ex:Batch ; rdfs:label "Batch shape" .
    """
    parsed = parse_ontology(ttl.encode(), "text/turtle", "shapes.ttl")
    assert parsed.kinds == ["owl", "shacl"]
    shape = term(parsed, "https://example.org/pv#BatchShape")
    assert (shape.kind, shape.domain) == ("shape", ["https://example.org/pv#Batch"])
    assert parsed.stats() == {
        "triples": 4, "classes": 1, "properties": 0, "concepts": 0, "schemes": 0, "shapes": 1,
    }


RDF_XML_INTERNAL = b"""<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY ex "https://example.org/pv#"> ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
         xmlns:owl="http://www.w3.org/2002/07/owl#">
  <owl:Class rdf:about="&ex;Batch"><rdfs:label>Batch</rdfs:label></owl:Class>
</rdf:RDF>"""

RDF_XML_EXTERNAL = b"""<?xml version="1.0"?>
<!DOCTYPE rdf:RDF [ <!ENTITY secret SYSTEM "file:///etc/passwd"> ]>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
  <rdf:Description rdf:about="https://example.org/x"><rdfs:label>&secret;</rdfs:label></rdf:Description>
</rdf:RDF>"""


def test_rdf_xml_with_internal_entities_parses() -> None:
    parsed = parse_ontology(RDF_XML_INTERNAL, "application/rdf+xml", "pv.owl")
    assert [t.label for t in parsed.terms] == ["Batch"]


def test_rdf_xml_with_external_entities_is_refused() -> None:
    with pytest.raises(DocumentError, match="external entities"):
        parse_ontology(RDF_XML_EXTERNAL, "application/rdf+xml", "evil.owl")


def test_json_ld_with_an_inline_context_parses() -> None:
    doc = {
        "@context": {"owl": "http://www.w3.org/2002/07/owl#", "rdfs": "http://www.w3.org/2000/01/rdf-schema#"},
        "@id": "https://example.org/pv#Batch",
        "@type": "owl:Class",
        "rdfs:label": "Batch",
    }
    parsed = parse_ontology(json.dumps(doc).encode(), "application/ld+json", "pv.jsonld")
    assert [t.iri for t in parsed.terms] == ["https://example.org/pv#Batch"]


@pytest.mark.parametrize(
    "context",
    ["https://schema.org/", ["https://example.org/ctx.jsonld"], {"@import": "https://x.org/c"}],
)
def test_json_ld_remote_contexts_are_refused(context: object) -> None:
    doc = {"@context": context, "@id": "https://example.org/x"}
    with pytest.raises(DocumentError, match="remote JSON-LD contexts"):
        parse_ontology(json.dumps(doc).encode(), "application/ld+json", "x.jsonld")


def test_unreadable_files_name_the_file_and_format() -> None:
    with pytest.raises(DocumentError, match=r"cannot read broken\.ttl as Turtle"):
        parse_ontology(b"this is { not turtle", "text/turtle", "broken.ttl")


def test_too_many_triples_is_refused() -> None:
    with pytest.raises(DocumentError, match=r"too large \(8 triples, limit 5\)"):
        parse_ontology(SKOS_TTL.encode(), "text/turtle", "stages.ttl", max_triples=5)


def test_n_triples_and_a_canonical_normalized_form() -> None:
    nt = (
        b'<https://example.org/b> <http://www.w3.org/2000/01/rdf-schema#label> "B" .\n'
        b"<https://example.org/b> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> "
        b"<http://www.w3.org/2002/07/owl#Class> .\n"
    )
    parsed = parse_ontology(nt, "application/n-triples", "b.nt")
    lines = parsed.normalized.decode().splitlines()
    assert lines == sorted(lines) and len(lines) == 2
    assert parse_ontology(nt, "application/n-triples", "b.nt").normalized == parsed.normalized


@pytest.mark.parametrize(
    ("media_type", "name", "head", "expected"),
    [
        ("text/turtle", "x.bin", b"", "turtle"),
        ("application/octet-stream", "x.owl", b"", "xml"),
        ("application/octet-stream", "x", b"  <?xml", "xml"),
        ("application/octet-stream", "x", b'{"@id": 1}', "json-ld"),
        ("application/octet-stream", "x", b"@prefix", "turtle"),
    ],
)
def test_rdf_format(media_type: str, name: str, head: bytes, expected: str) -> None:
    assert rdf_format(media_type, name, head) == expected


@pytest.mark.parametrize(
    ("iri", "name"),
    [
        ("https://example.org/pv#Batch", "Batch"),
        ("https://example.org/pv/Batch", "Batch"),
        ("https://example.org/pv/Batch/", "Batch"),
        ("urn:isbn:123", "123"),
    ],
)
def test_local_name(iri: str, name: str) -> None:
    assert local_name(iri) == name


def test_normalized_key() -> None:
    assert ontology_normalized_key("idmp-o", 3) == "ontologies/idmp-o/v3/normalized.nt"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd worker && uv run pytest tests/test_ontology.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'ingest_worker.ontology'`. If rdflib
is missing, add it to `pyproject.toml` and run `uv sync` first.

- [ ] **Step 3: Implement the parser** in `worker/src/ingest_worker/ontology.py`

```python
"""Ontology library (ADR 0011): parse an imported OWL/RDFS, SKOS or SHACL file, index its terms.

`parse_ontology` is pure: bytes in, terms out. `run_ontology_import` (below) is the `ontology`
job task; the API creates the job, the version row and the source object."""

from __future__ import annotations

import json
import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal

from rdflib import BNode, Graph, URIRef
from rdflib import Literal as RdfLiteral
from rdflib.collection import Collection
from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SH, SKOS, XSD

from .pipeline import DocumentError

TermKind = Literal[
    "class",
    "object_property",
    "datatype_property",
    "annotation_property",
    "concept",
    "scheme",
    "shape",
]

DEFAULT_MAX_TRIPLES = 2_000_000
MAX_ALT_LABELS = 20

FORMATS = {
    "text/turtle": "turtle",
    "application/rdf+xml": "xml",
    "application/ld+json": "json-ld",
    "application/n-triples": "nt",
    "text/n3": "n3",
}
EXTENSIONS = {"ttl": "turtle", "owl": "xml", "rdf": "xml", "jsonld": "json-ld", "nt": "nt", "n3": "n3"}
FORMAT_NAMES = {"turtle": "Turtle", "xml": "RDF/XML", "json-ld": "JSON-LD", "nt": "N-Triples", "n3": "N3"}

IAO_DEFINITION = URIRef("http://purl.obolibrary.org/obo/IAO_0000115")
CC_LICENSE = URIRef("http://creativecommons.org/ns#license")

#: Group of each kind: roots and child counts are computed within a group (one browser tab).
GROUP: dict[str, str] = {
    "class": "classes",
    "object_property": "properties",
    "datatype_property": "properties",
    "annotation_property": "properties",
    "scheme": "concepts",
    "concept": "concepts",
    "shape": "shapes",
}

_TYPED: list[tuple[URIRef, TermKind]] = [
    (OWL.Class, "class"),
    (RDFS.Class, "class"),
    (OWL.ObjectProperty, "object_property"),
    (OWL.DatatypeProperty, "datatype_property"),
    (OWL.AnnotationProperty, "annotation_property"),
    (SKOS.ConceptScheme, "scheme"),
    (SKOS.Concept, "concept"),
    (SH.NodeShape, "shape"),
    (SH.PropertyShape, "shape"),
]

#: RDF/XML declaring an external entity: refused before parsing (internal entities are fine).
_EXTERNAL_ENTITY = re.compile(rb"<!ENTITY\s+(?:%\s*)?[^\s>]+\s+(?:SYSTEM|PUBLIC)\b", re.IGNORECASE)


@dataclass
class Term:
    iri: str
    kind: TermKind
    label: str
    alt_labels: list[str]
    definition: str
    parents: list[str]
    domain: list[str]
    range: list[str]
    scheme: str | None
    deprecated: bool
    root: bool = False
    child_count: int = 0


@dataclass
class ParsedOntology:
    triples: int
    ontology_iri: str | None
    version_iri: str | None
    license: str | None
    kinds: list[str]
    imports: list[str]
    terms: list[Term] = field(default_factory=list)
    normalized: bytes = b""

    def stats(self) -> dict[str, int]:
        count = lambda *kinds: sum(1 for t in self.terms if t.kind in kinds)  # noqa: E731
        return {
            "triples": self.triples,
            "classes": count("class"),
            "properties": count("object_property", "datatype_property", "annotation_property"),
            "concepts": count("concept"),
            "schemes": count("scheme"),
            "shapes": count("shape"),
        }


def rdf_format(media_type: str, file_name: str, data: bytes) -> str:
    """rdflib's format name: the content type the API recorded, the extension, then a sniff."""
    if media_type in FORMATS:
        return FORMATS[media_type]
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if ext in EXTENSIONS:
        return EXTENSIONS[ext]
    head = data[:512].lstrip()
    if head.startswith(b"<"):
        return "xml"
    if head[:1] in (b"{", b"["):
        return "json-ld"
    return "turtle"


def local_name(iri: str) -> str:
    """The last segment of an IRI: a label for terms that have none."""
    tail = re.split(r"[#/:]", iri.rstrip("/#"))[-1]
    return tail or iri


def _remote_contexts(node: Any) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("@context", "@import"):
                for item in value if isinstance(value, list) else [value]:
                    found += [item] if isinstance(item, str) else _remote_contexts(item)
            else:
                found += _remote_contexts(value)
    elif isinstance(node, list):
        for item in node:
            found += _remote_contexts(item)
    return found


def _refuse_unsafe(fmt: str, data: bytes) -> None:
    if fmt == "xml" and _EXTERNAL_ENTITY.search(data):
        raise DocumentError("RDF/XML declaring external entities (<!ENTITY … SYSTEM>) is not accepted")
    if fmt == "json-ld":
        try:
            doc = json.loads(data)
        except ValueError as exc:
            raise DocumentError(f"cannot read the file as JSON-LD: {exc}") from exc
        remote = _remote_contexts(doc)
        if remote:
            raise DocumentError(
                f"remote JSON-LD contexts are not fetched ({remote[0]}): inline the context"
            )


def _literals(graph: Graph, subject: URIRef, predicate: URIRef) -> list[RdfLiteral]:
    return [o for o in graph.objects(subject, predicate) if isinstance(o, RdfLiteral)]


def _pick(values: list[RdfLiteral]) -> RdfLiteral | None:
    """English first, then untagged, then any (sorted, so the choice is stable)."""
    for keep in (
        lambda v: (v.language or "").lower().startswith("en"),
        lambda v: v.language is None,
        lambda v: True,
    ):
        chosen = sorted((v for v in values if keep(v)), key=str)
        if chosen:
            return chosen[0]
    return None


def _iris(graph: Graph, values: Any) -> list[str]:
    """IRIs among the values, expanding `owl:unionOf` lists; blank nodes are dropped."""
    out: set[str] = set()
    for value in values:
        if isinstance(value, URIRef):
            out.add(str(value))
        elif isinstance(value, BNode):
            for members in graph.objects(value, OWL.unionOf):
                out.update(str(m) for m in Collection(graph, members) if isinstance(m, URIRef))
    return sorted(out)


def _kinds_of(graph: Graph) -> dict[URIRef, TermKind]:
    kinds: dict[URIRef, TermKind] = {}
    for rdf_type, kind in _TYPED:
        for subject in graph.subjects(RDF.type, rdf_type):
            if isinstance(subject, URIRef):
                kinds.setdefault(subject, kind)
    for subject in graph.subjects(RDF.type, RDF.Property):
        if isinstance(subject, URIRef) and subject not in kinds:
            ranges = list(graph.objects(subject, RDFS.range))
            literal = any(r == RDFS.Literal or str(r).startswith(str(XSD)) for r in ranges)
            kinds[subject] = "datatype_property" if literal else "object_property"
    return kinds


def _term(graph: Graph, iri: URIRef, kind: TermKind) -> Term:
    labels = _literals(graph, iri, SKOS.prefLabel) or _literals(graph, iri, RDFS.label)
    chosen = _pick(labels)
    label = str(chosen) if chosen is not None else local_name(str(iri))
    names = {
        str(v)
        for p in (SKOS.prefLabel, RDFS.label, SKOS.altLabel)
        for v in _literals(graph, iri, p)
    }
    alt = sorted(names - {label})[:MAX_ALT_LABELS]
    definition = next(
        (
            str(d)
            for p in (SKOS.definition, IAO_DEFINITION, RDFS.comment)
            if (d := _pick(_literals(graph, iri, p))) is not None
        ),
        "",
    )
    parents: list[str] = []
    domain: list[str] = []
    range_: list[str] = []
    scheme: str | None = None
    if kind == "class":
        parents = _iris(graph, graph.objects(iri, RDFS.subClassOf))
    elif kind in ("object_property", "datatype_property", "annotation_property"):
        parents = _iris(graph, graph.objects(iri, RDFS.subPropertyOf))
        domain = _iris(graph, graph.objects(iri, RDFS.domain))
        range_ = _iris(graph, graph.objects(iri, RDFS.range))
    elif kind == "concept":
        schemes = _iris(graph, graph.objects(iri, SKOS.inScheme)) or _iris(
            graph, graph.objects(iri, SKOS.topConceptOf)
        )
        scheme = schemes[0] if schemes else None
        broader = set(_iris(graph, graph.objects(iri, SKOS.broader)))
        broader.update(_iris(graph, graph.subjects(SKOS.narrower, iri)))
        # A top concept hangs under its scheme, so concepts share the scheme's tree.
        parents = sorted(broader) or ([scheme] if scheme else [])
    elif kind == "shape":
        domain = _iris(graph, graph.objects(iri, SH.targetClass))
    deprecated = any(
        isinstance(o, RdfLiteral) and o.toPython() is True for o in graph.objects(iri, OWL.deprecated)
    )
    return Term(str(iri), kind, label, alt, definition, parents, domain, range_, scheme, deprecated)


def _mark_roots(terms: list[Term]) -> None:
    """Roots have no parent in their group; anything unreachable from a root (a cycle) is a root
    too, so every term can be found in the tree. Child counts are per group."""
    by_group: dict[str, list[Term]] = {}
    for t in terms:
        by_group.setdefault(GROUP[t.kind], []).append(t)
    for group in by_group.values():
        iris = {t.iri for t in group}
        children: dict[str, list[Term]] = {}
        for t in group:
            for p in t.parents:
                if p in iris and p != t.iri:
                    children.setdefault(p, []).append(t)
        for t in group:
            t.child_count = len({c.iri for c in children.get(t.iri, [])})
            t.root = not any(p in iris and p != t.iri for p in t.parents)
        reached: set[str] = set()
        queue = deque(t.iri for t in group if t.root)
        while queue:
            iri = queue.popleft()
            if iri in reached:
                continue
            reached.add(iri)
            queue.extend(c.iri for c in children.get(iri, []))
        for t in group:
            if t.iri not in reached:
                t.root = True


def parse_ontology(
    data: bytes, media_type: str, file_name: str, *, max_triples: int = DEFAULT_MAX_TRIPLES
) -> ParsedOntology:
    """Parse one ontology file and index its terms. Every refusal is a DocumentError."""
    fmt = rdf_format(media_type, file_name, data)
    _refuse_unsafe(fmt, data)
    graph = Graph()
    try:
        graph.parse(data=data, format=fmt)
    except Exception as exc:  # rdflib raises a different type per parser
        raise DocumentError(f"cannot read {file_name} as {FORMAT_NAMES[fmt]}: {exc}") from exc
    triples = len(graph)
    if triples > max_triples:
        raise DocumentError(f"ontology too large ({triples} triples, limit {max_triples})")

    headers = sorted(s for s in graph.subjects(RDF.type, OWL.Ontology) if isinstance(s, URIRef))
    ontology = headers[0] if headers else None
    version_iri = next(iter(_iris(graph, graph.objects(ontology, OWL.versionIRI))), None) if ontology else None
    license_ = None
    if ontology is not None:
        for p in (DCTERMS.license, DC.rights, CC_LICENSE):
            value = next(iter(sorted(graph.objects(ontology, p), key=str)), None)
            if value is not None:
                license_ = str(value)
                break
    imports = sorted({str(o) for h in headers for o in graph.objects(h, OWL.imports)})

    terms = [_term(graph, iri, kind) for iri, kind in _kinds_of(graph).items()]
    terms.sort(key=lambda t: (t.kind, t.iri))
    _mark_roots(terms)
    present = {t.kind for t in terms}
    kinds = [
        name
        for name, has in (
            ("owl", ontology is not None or bool(present & {"class", "object_property", "datatype_property", "annotation_property"})),
            ("skos", bool(present & {"concept", "scheme"})),
            ("shacl", "shape" in present),
        )
        if has
    ]
    lines = sorted(line for line in graph.serialize(format="nt").splitlines() if line.strip())
    return ParsedOntology(
        triples=triples,
        ontology_iri=str(ontology) if ontology is not None else None,
        version_iri=version_iri,
        license=license_,
        kinds=kinds,
        imports=imports,
        terms=terms,
        normalized=("\n".join(lines) + "\n").encode("utf-8"),
    )
```

Note: `DC.rights` is not a licence IRI, but it is the usual field when `dcterms:license` is
absent; keep it third. In `worker/src/ingest_worker/storage.py`, next to `export_key`, add:

```python
def ontology_normalized_key(ontology_id: str, version: int) -> str:
    """A version's canonical N-Triples (runs bucket, ontology task)."""
    return f"ontologies/{ontology_id}/v{version}/normalized.nt"
```

- [ ] **Step 4: Run the tests to see them pass, then lint**

Run: `cd worker && uv run pytest tests/test_ontology.py -q && uv run ruff check src tests && uv run ruff format src tests && uv run mypy`
Expected: all PASS, and no ruff or mypy errors. If rdflib's typing trips `mypy --strict`, add
`[[tool.mypy.overrides]] module = ["rdflib.*"] ignore_missing_imports = true`, as is already
done for pypdfium2. Fix real type errors rather than ignoring them. If the SHACL stats test
counts a different number of triples, count the triples in the fixture by hand and correct
the expected number. The test pins rdflib's count, which must be exactly the triples written.

- [ ] **Step 5: Commit**

```bash
git add worker/pyproject.toml worker/uv.lock worker/src/ingest_worker/ontology.py worker/src/ingest_worker/storage.py worker/tests/test_ontology.py
git commit -m "Worker: parse and index ontology files (rdflib)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker `ontology` job and store

**Files:**
- Modify: `worker/src/ingest_worker/ontology.py` (append the store and job)
- Modify: `worker/src/ingest_worker/pipeline.py` (`PipelineDeps`), `main.py` (dispatch + wiring), `config.py` (`ontology_max_triples`)
- Modify: `worker/tests/fakes.py` (`MemoryOntologyStore`)
- Test: `worker/tests/test_ontology_job.py`

**Interfaces:**
- Consumes: `parse_ontology`, `ParsedOntology`, `ontology_normalized_key` (Task 2); the API
  writes job params `{ontologyId, version, sourceKey, fileName, mediaType}` (Task 5).
- Produces:
  - `OntologyStore` Protocol with `start(ontology_id, version)`,
    `save(ontology_id, version, parsed)` and `fail(ontology_id, version, error)`
  - `PgOntologyStore(conn)`
  - `run_ontology_import(job, deps, queue) -> ParsedOntology`
  - `ONTOLOGY_INDEXED = "ontology indexed"`
  - `PipelineDeps.ontologies: OntologyStore | None = None`
  - `PipelineDeps.ontology_max_triples: int = 2_000_000`

- [ ] **Step 1: Write the failing tests** `worker/tests/test_ontology_job.py`

```python
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.ontology import ONTOLOGY_INDEXED, PgOntologyStore, parse_ontology
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key

from .fakes import FakeQueue, MemoryOntologyStore

TTL = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://example.org/pv#Batch> a owl:Class .
"""
SOURCE = "ontologies/pv/sources/abc.ttl"


def ontology_job(attempts: int = 1, **params: Any) -> ClaimedJob:
    base = {
        "ontologyId": "pv",
        "version": 1,
        "sourceKey": SOURCE,
        "fileName": "pv.ttl",
        "mediaType": "text/turtle",
    }
    return ClaimedJob(
        id="job-o", document_id="", spec_id="", spec_version=0, bucket="", object_key="",
        model_override=None, attempts=attempts, max_attempts=3, task="ontology",
        params={**base, **params},
    )


def make(fixture_specs_dir: Path, source: bytes | None = TTL) -> tuple[PipelineDeps, MemoryOntologyStore]:
    store = MemoryObjectStore()
    if source is not None:
        store.put("runs", SOURCE, source, "text/turtle")
    ontologies = MemoryOntologyStore()
    deps = PipelineDeps(
        store=store, specs=load_specs(fixture_specs_dir), models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [], buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=ontologies,
    )
    return deps, ontologies


def test_indexes_a_version_and_writes_its_normalized_triples(fixture_specs_dir: Path) -> None:
    deps, ontologies = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job()])
    assert run_once(queue, deps, "w1")
    assert [job_id for job_id, _ in queue.completed] == ["job-o"]
    assert ontologies.status[("pv", 1)] == "ready"
    assert [t.iri for t in ontologies.saved[("pv", 1)].terms] == ["https://example.org/pv#Batch"]
    body, ctype = deps.store.objects[("runs", ontology_normalized_key("pv", 1))]  # type: ignore[attr-defined]
    assert ctype == "application/n-triples" and b"owl#Class" in body
    assert ("job-o", "info", ONTOLOGY_INDEXED) in queue.events


def test_an_unreadable_file_fails_the_version_and_goes_to_review(fixture_specs_dir: Path) -> None:
    deps, ontologies = make(fixture_specs_dir, source=b"not { turtle")
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    [(job_id, reason)] = queue.reviewed
    assert job_id == "job-o" and "cannot read pv.ttl as Turtle" in reason
    assert ontologies.status[("pv", 1)] == "failed"
    assert "cannot read" in ontologies.errors[("pv", 1)]


def test_a_missing_source_is_a_review_not_a_retry(fixture_specs_dir: Path) -> None:
    deps, ontologies = make(fixture_specs_dir, source=None)
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    assert "uploaded file is missing" in queue.reviewed[0][1]
    assert ontologies.status[("pv", 1)] == "failed"


def test_bad_params_and_no_store_go_to_review(fixture_specs_dir: Path) -> None:
    deps, _ = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job(version="one")])
    run_once(queue, deps, "w1")
    assert "invalid ontology import parameters" in queue.reviewed[0][1]
    deps.ontologies = None
    queue = FakeQueue(jobs=[ontology_job()])
    run_once(queue, deps, "w1")
    assert "no ontology store" in queue.reviewed[0][1]


class Broken(MemoryOntologyStore):
    def save(self, ontology_id: str, version: int, parsed: Any) -> None:
        raise ConnectionError("database went away")


@pytest.mark.parametrize(("attempts", "status"), [(1, "parsing"), (3, "failed")])
def test_transient_errors_retry_and_fail_the_version_on_the_last_attempt(
    fixture_specs_dir: Path, attempts: int, status: str
) -> None:
    deps, _ = make(fixture_specs_dir)
    broken = Broken()
    deps.ontologies = broken
    queue = FakeQueue(jobs=[ontology_job(attempts=attempts)])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.reviewed
    assert broken.status[("pv", 1)] == status


@pytest.mark.integration
def test_pg_store_saves_terms_and_ready_is_immutable() -> None:
    """Needs IH_TEST_DATABASE_URL on a throwaway database that already has db/migrations applied
    (run the API's ontology-pg integration test first: it applies them)."""
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'pv-worker-test'")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('pv-worker-test', 'PV')")
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes)
           VALUES ('pv-worker-test', 1, 'pv.ttl', 'text/turtle', 'abc', 10)"""
    )
    store = PgOntologyStore(conn)
    store.start("pv-worker-test", 1)
    store.save("pv-worker-test", 1, parse_ontology(TTL, "text/turtle", "pv.ttl"))
    row = conn.execute(
        "SELECT status, kinds, stats->>'classes' FROM ontology_versions WHERE ontology_id = 'pv-worker-test'"
    ).fetchone()
    assert row == ("ready", ["owl"], "1")
    terms = conn.execute(
        "SELECT iri, kind, root FROM ontology_terms WHERE ontology_id = 'pv-worker-test'"
    ).fetchall()
    assert terms == [("https://example.org/pv#Batch", "class", True)]
    with pytest.raises(psycopg.errors.RaiseException, match="ready and cannot change"):
        conn.execute("UPDATE ontology_versions SET error = 'x' WHERE ontology_id = 'pv-worker-test'")
    conn.execute("DELETE FROM ontologies WHERE id = 'pv-worker-test'")
    conn.close()
```

Add to `worker/tests/fakes.py`:

```python
@dataclass
class MemoryOntologyStore:
    """OntologyStore over dicts: what the job wrote, for assertions."""

    status: dict[tuple[str, int], str] = field(default_factory=dict)
    errors: dict[tuple[str, int], str] = field(default_factory=dict)
    saved: dict[tuple[str, int], ParsedOntology] = field(default_factory=dict)

    def start(self, ontology_id: str, version: int) -> None:
        self.status[(ontology_id, version)] = "parsing"

    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None:
        self.saved[(ontology_id, version)] = parsed
        self.status[(ontology_id, version)] = "ready"

    def fail(self, ontology_id: str, version: int, error: str) -> None:
        self.status[(ontology_id, version)] = "failed"
        self.errors[(ontology_id, version)] = error
```

Add `from ingest_worker.ontology import ParsedOntology` to the imports in `fakes.py`, and
`field` to its `dataclasses` import if it is missing. Check whether `ClaimedJob` accepts
`params=` as a keyword (it does: the fields are in `queue.py:24-48`). Check whether
`MemoryObjectStore` keys its objects `(bucket, key)` (it does, per `storage.py:86-104`). If
the attribute is not called `objects`, use the name it has.

- [ ] **Step 2: Run them to see them fail**

Run: `cd worker && uv run pytest tests/test_ontology_job.py -q`
Expected: FAIL. The import of `ONTOLOGY_INDEXED`, `PgOntologyStore` or
`MemoryOntologyStore` fails, and `PipelineDeps` has no `ontologies`.

- [ ] **Step 3: Implement the store and the job**

In `worker/src/ingest_worker/pipeline.py`, add `from .ontology import OntologyStore` under
the existing `if TYPE_CHECKING:` block (create the block if there is none, with
`from typing import TYPE_CHECKING`). Then add these fields at the end of `PipelineDeps`:

```python
    #: The ontology library's tables (None: ontology jobs go to review).
    ontologies: OntologyStore | None = None
    #: Imports over this many triples are refused (ONTOLOGY_MAX_TRIPLES).
    ontology_max_triples: int = 2_000_000
```

Append to `worker/src/ingest_worker/ontology.py`:

```python
# --- The `ontology` job ---------------------------------------------------------------------

from typing import TYPE_CHECKING, Protocol  # noqa: E402

from pydantic import BaseModel, ConfigDict, Field, ValidationError  # noqa: E402

from .pipeline import JobCancelled, check_cancelled  # noqa: E402
from .storage import ontology_normalized_key  # noqa: E402

if TYPE_CHECKING:
    import psycopg

    from .pipeline import PipelineDeps
    from .queue import ClaimedJob, JobQueue

#: Job event when a version is indexed; mirrors ONTOLOGY_INDEXED_EVENT in packages/shared.
ONTOLOGY_INDEXED = "ontology indexed"


class OntologyStore(Protocol):
    """The ontology tables the job writes (the API reads them)."""

    def start(self, ontology_id: str, version: int) -> None: ...
    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None: ...
    def fail(self, ontology_id: str, version: int, error: str) -> None: ...


class OntologyJobParams(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    ontology_id: str = Field(alias="ontologyId", min_length=2)
    version: int = Field(gt=0)
    source_key: str = Field(alias="sourceKey", min_length=1)
    file_name: str = Field(alias="fileName", min_length=1)
    media_type: str = Field(alias="mediaType", min_length=1)


_TERM_COLUMNS = (
    "ontology_id, version, iri, kind, label, alt_labels, definition, parents, domains, ranges,"
    " scheme, deprecated, root, child_count"
)


class PgOntologyStore:
    """OntologyStore on Postgres (migration 0032). A ready version is immutable (trigger)."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def start(self, ontology_id: str, version: int) -> None:
        self._conn.execute(
            """UPDATE ontology_versions SET status = 'parsing', error = NULL
                WHERE ontology_id = %s AND version = %s AND status IN ('queued', 'parsing')""",
            (ontology_id, version),
        )

    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None:
        from psycopg.types.json import Jsonb

        with self._conn.transaction():
            self._conn.execute(
                "DELETE FROM ontology_terms WHERE ontology_id = %s AND version = %s",
                (ontology_id, version),
            )
            with self._conn.cursor() as cur, cur.copy(
                f"COPY ontology_terms ({_TERM_COLUMNS}) FROM STDIN"
            ) as copy:
                copy.set_types(
                    ["text", "int4", "text", "text", "text", "text[]", "text", "text[]",
                     "text[]", "text[]", "text", "bool", "bool", "int4"]
                )
                for t in parsed.terms:
                    copy.write_row(
                        (ontology_id, version, t.iri, t.kind, t.label, t.alt_labels,
                         t.definition, t.parents, t.domain, t.range, t.scheme, t.deprecated,
                         t.root, t.child_count)
                    )
            self._conn.execute(
                """UPDATE ontology_versions
                      SET status = 'ready', error = NULL, ontology_iri = %s, version_iri = %s,
                          license = %s, kinds = %s, stats = %s, imports = %s
                    WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
                (
                    parsed.ontology_iri, parsed.version_iri, parsed.license, parsed.kinds,
                    Jsonb(parsed.stats()),
                    Jsonb([{"iri": i, "resolution": "unresolved"} for i in parsed.imports]),
                    ontology_id, version,
                ),
            )

    def fail(self, ontology_id: str, version: int, error: str) -> None:
        self._conn.execute(
            """UPDATE ontology_versions SET status = 'failed', error = %s
                WHERE ontology_id = %s AND version = %s AND status <> 'ready'""",
            (error, ontology_id, version),
        )


def run_ontology_import(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> ParsedOntology:
    """Parse the uploaded file, keep its canonical N-Triples, index its terms. A file that cannot
    be read fails the version (and the job goes to review); other errors retry, failing the
    version on the last attempt so it never stays 'parsing'."""
    try:
        params = OntologyJobParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid ontology import parameters: {exc}") from exc
    store = deps.ontologies
    if store is None:
        raise DocumentError("this worker has no ontology store")
    oid, version = params.ontology_id, params.version
    store.start(oid, version)
    try:
        data = deps.store.get_optional(deps.buckets.runs, params.source_key)
        if data is None:
            raise DocumentError(f"the uploaded file is missing ({params.source_key})")
        parsed = parse_ontology(
            data, params.media_type, params.file_name, max_triples=deps.ontology_max_triples
        )
        check_cancelled(job, queue)
        deps.store.put(
            deps.buckets.runs,
            ontology_normalized_key(oid, version),
            parsed.normalized,
            "application/n-triples",
        )
        store.save(oid, version, parsed)
    except DocumentError as exc:
        store.fail(oid, version, str(exc))
        raise
    except JobCancelled:
        store.fail(oid, version, "the import was cancelled")
        raise
    except Exception as exc:
        if job.attempts >= job.max_attempts:
            store.fail(oid, version, f"{type(exc).__name__}: {exc}")
        raise
    queue.event(
        job.id, "info", ONTOLOGY_INDEXED, {"terms": len(parsed.terms), "triples": parsed.triples}
    )
    return parsed
```

Move the imports to the top of the module rather than keeping them mid-file with `noqa`. If
importing `pipeline` there creates a cycle, keep `pipeline.py`'s import of `OntologyStore`
under `TYPE_CHECKING` only, as described above. Then `ontology.py` → `pipeline.py` is the
only runtime direction.

In `worker/src/ingest_worker/main.py`:
- Import `PgOntologyStore` and `run_ontology_import` from `.ontology`.
- Add `ontology` to the `run_once` docstring's task list.
- Add this branch before `result = process_job(...)`:

```python
        if job.task == "ontology":
            parsed = run_ontology_import(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s indexed %d ontology terms", job.id, len(parsed.terms))
            return True
```

In `main()`, pass these to `PipelineDeps(...)`:

```python
        ontologies=PgOntologyStore(psycopg.connect(settings.database_url, autocommit=True)),
        ontology_max_triples=settings.ontology_max_triples,
```

In `worker/src/ingest_worker/config.py`:
- Add the field `ontology_max_triples: int = 2_000_000` as the last field of `Settings`, with
  the comment `#: Ontology imports over this many triples are refused (ADR 0011).`
- In `from_env`, add `ontology_max_triples=int(env.get("ONTOLOGY_MAX_TRIPLES", "2000000")),`.

Also add `ONTOLOGY_MAX_TRIPLES=2000000` with that comment to `deploy/.env.example`, next to
the other worker settings.

- [ ] **Step 4: Run the tests to see them pass, then the whole worker suite and lint**

Run: `cd worker && uv run pytest tests/test_ontology_job.py tests/test_ontology.py -q && cd .. && npm run worker:test && npm run worker:lint`
Expected: all PASS. The Pg test is skipped (not selected) unless `-m integration` is given.

- [ ] **Step 5: Commit**

```bash
git add worker deploy/.env.example
git commit -m "Worker: ontology import job and PgOntologyStore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API `OntologyRepo` (memory and Postgres)

**Files:**
- Create: `apps/api/src/ontologies/repo.ts`
- Test: `apps/api/test/ontology-repo.test.ts` (memory), `apps/api/test/integration/ontology-pg.test.ts` (Pg)

**Interfaces:**
- Consumes: the shared types (Task 1).
- Produces:

```ts
export interface NewOntologyVersion {
  ontologyId: string;
  /** Required when the ontology is new; ignored when it exists. */
  meta: { label: string; description: string; tags: string[]; localOnly: boolean } | null;
  fileName: string;
  mediaType: string;
  sourceKey: string;
  sha256: string;
  bytes: number;
  by: string | null;
}
export type CreateVersionResult =
  | { ok: true; version: OntologyVersionView; jobId: string }
  | { ok: false; reason: 'needs-label' }
  | { ok: false; reason: 'duplicate'; version: number };
export interface TermQuery {
  group?: TermGroup;
  q?: string;
  parent?: string;
  root?: boolean;
  offset: number;
  limit: number;
}
export type DeleteVersionResult =
  | { result: 'deleted'; sha256: string; fileName: string }
  | { result: 'missing' }
  | { result: 'busy' };
export interface OntologyRepo {
  list(opts: { retired: boolean }): Promise<OntologySummary[]>;
  get(id: string): Promise<OntologyDetail | null>;
  createVersion(input: NewOntologyVersion): Promise<CreateVersionResult>;
  update(id: string, patch: OntologyPatch): Promise<OntologySummary | null>;
  deleteVersion(id: string, version: number): Promise<DeleteVersionResult>;
  terms(id: string, version: number, query: TermQuery): Promise<TermPage | null>;
  term(id: string, version: number, iri: string): Promise<TermDetail | null>;
}
```

`MemoryOntologyRepo` also exposes these test seeders:
- `jobs: { id: string; params: Record<string, unknown>; createdBy: string | null }[]`
- `markReady(id, version, extra?: Partial<OntologyVersionView>)`
- `markFailed(id, version, error)`
- `seedTerms(id, version, terms: SeedTerm[])`, where
  `SeedTerm = Partial<OntologyTerm> & { iri: string; kind: OntologyTermKind; root?: boolean }`

- [ ] **Step 1: Write the failing memory tests** `apps/api/test/ontology-repo.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { MemoryOntologyRepo, type NewOntologyVersion } from '../src/ontologies/repo.js';

const input = (over: Partial<NewOntologyVersion> = {}): NewOntologyVersion => ({
  ontologyId: 'pv',
  meta: { label: 'Process validation', description: '', tags: ['industry:pharma'], localOnly: false },
  fileName: 'pv.ttl',
  mediaType: 'text/turtle',
  sourceKey: 'ontologies/pv/sources/aaa.ttl',
  sha256: 'aaa',
  bytes: 10,
  by: 'Ken',
  ...over,
});

const C = 'https://example.org/pv#';

async function seeded() {
  const repo = new MemoryOntologyRepo();
  await repo.createVersion(input());
  repo.markReady('pv', 1, { stats: { triples: 9, classes: 3, properties: 1, concepts: 0, schemes: 0, shapes: 0 } });
  repo.seedTerms('pv', 1, [
    { iri: `${C}Document`, kind: 'class', label: 'Document', root: true, childCount: 1 },
    { iri: `${C}Protocol`, kind: 'class', label: 'Protocol', parents: [`${C}Document`], altLabels: ['Validation protocol'] },
    { iri: `${C}Batch`, kind: 'class', label: 'Batch', root: true },
    { iri: `${C}hasBatch`, kind: 'object_property', label: 'has batch', root: true, domain: [`${C}Protocol`], range: [`${C}Batch`] },
    { iri: `${C}BatchShape`, kind: 'shape', label: 'Batch shape', root: true, domain: [`${C}Batch`] },
  ]);
  return repo;
}

describe('MemoryOntologyRepo', () => {
  it('creates an ontology with its first version and a queued job', async () => {
    const repo = new MemoryOntologyRepo();
    const result = await repo.createVersion(input());
    expect(result).toMatchObject({ ok: true, version: { ontologyId: 'pv', version: 1, status: 'queued' } });
    expect(repo.jobs).toEqual([
      {
        id: expect.any(String),
        createdBy: 'Ken',
        params: { ontologyId: 'pv', version: 1, sourceKey: 'ontologies/pv/sources/aaa.ttl', fileName: 'pv.ttl', mediaType: 'text/turtle' },
      },
    ]);
    const [summary] = await repo.list({ retired: false });
    expect(summary).toMatchObject({ id: 'pv', label: 'Process validation', versionCount: 1, latest: { version: 1 } });
  });

  it('needs a label for a new ontology and refuses the same bytes twice', async () => {
    const repo = new MemoryOntologyRepo();
    expect(await repo.createVersion(input({ meta: null }))).toEqual({ ok: false, reason: 'needs-label' });
    await repo.createVersion(input());
    expect(await repo.createVersion(input({ meta: null }))).toEqual({ ok: false, reason: 'duplicate', version: 1 });
    const second = await repo.createVersion(input({ meta: null, sha256: 'bbb', sourceKey: 'k2' }));
    expect(second).toMatchObject({ ok: true, version: { version: 2 } });
    expect((await repo.get('pv'))!.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('patches metadata, retires and hides retired ontologies by default', async () => {
    const repo = await seeded();
    expect(await repo.update('nope', { label: 'x' })).toBeNull();
    const updated = await repo.update('pv', { label: 'PV', tags: ['customer:acme'], localOnly: true, retired: true });
    expect(updated).toMatchObject({ label: 'PV', tags: ['customer:acme'], localOnly: true, retiredAt: expect.any(String) });
    expect(await repo.list({ retired: false })).toEqual([]);
    expect(await repo.list({ retired: true })).toHaveLength(1);
    expect(await repo.update('pv', { retired: false })).toMatchObject({ retiredAt: null });
  });

  it('refuses to delete a version still importing; the last version takes the ontology', async () => {
    const repo = new MemoryOntologyRepo();
    await repo.createVersion(input());
    expect(await repo.deleteVersion('pv', 1)).toEqual({ result: 'busy' });
    repo.markFailed('pv', 1, 'cannot read');
    expect(await repo.deleteVersion('pv', 2)).toEqual({ result: 'missing' });
    expect(await repo.deleteVersion('pv', 1)).toEqual({ result: 'deleted', sha256: 'aaa', fileName: 'pv.ttl' });
    expect(await repo.get('pv')).toBeNull();
  });

  it('pages roots, children and searches within a group', async () => {
    const repo = await seeded();
    const roots = await repo.terms('pv', 1, { group: 'classes', root: true, offset: 0, limit: 100 });
    expect(roots!.items.map((t) => t.label)).toEqual(['Batch', 'Document']);
    const children = await repo.terms('pv', 1, { group: 'classes', parent: `${C}Document`, offset: 0, limit: 100 });
    expect(children!.items.map((t) => t.label)).toEqual(['Protocol']);
    // Alt labels match; an exact label ranks first.
    const found = await repo.terms('pv', 1, { q: 'protocol', offset: 0, limit: 100 });
    expect(found!.items.map((t) => t.label)).toEqual(['Protocol']);
    const paged = await repo.terms('pv', 1, { group: 'classes', offset: 1, limit: 1 });
    expect(paged).toMatchObject({ total: 3, offset: 1, limit: 1, items: [{ label: 'Document' }] });
    expect(await repo.terms('pv', 9, { offset: 0, limit: 10 })).toBeNull();
  });

  it('describes a term with its neighbours', async () => {
    const repo = await seeded();
    const batch = await repo.term('pv', 1, `${C}Batch`);
    expect(batch).toMatchObject({
      label: 'Batch',
      asRange: [{ iri: `${C}hasBatch`, label: 'has batch', kind: 'object_property' }],
      asDomain: [],
      shapes: [{ iri: `${C}BatchShape`, label: 'Batch shape', kind: 'shape' }],
    });
    const protocol = await repo.term('pv', 1, `${C}Protocol`);
    expect(protocol!.parentTerms).toEqual([{ iri: `${C}Document`, label: 'Document', kind: 'class' }]);
    const doc = await repo.term('pv', 1, `${C}Document`);
    expect(doc!.children.map((c) => c.label)).toEqual(['Protocol']);
    const prop = await repo.term('pv', 1, `${C}hasBatch`);
    expect(prop!.domainTerms.map((r) => r.label)).toEqual(['Protocol']);
    expect(prop!.rangeTerms.map((r) => r.label)).toEqual(['Batch']);
    expect(await repo.term('pv', 1, `${C}Nope`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run apps/api/test/ontology-repo.test.ts`
Expected: FAIL, because `../src/ontologies/repo.js` does not exist.

- [ ] **Step 3: Implement `apps/api/src/ontologies/repo.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  TERM_GROUPS,
  type OntologyDetail,
  type OntologyPatch,
  type OntologySummary,
  type OntologyTerm,
  type OntologyTermKind,
  type OntologyVersionView,
  type TermDetail,
  type TermGroup,
  type TermPage,
  type TermRef,
} from '@ih/shared';

/** Workbench-level priority: ontology imports never delay production documents. */
export const ONTOLOGY_PRIORITY = -10;

// NewOntologyVersion, CreateVersionResult, TermQuery, DeleteVersionResult and OntologyRepo:
// exactly as in this task's Interfaces block.

export type SeedTerm = Partial<OntologyTerm> & { iri: string; kind: OntologyTermKind; root?: boolean };
type StoredTerm = OntologyTerm & { root: boolean };

const KIND_ORDER: OntologyTermKind[] = [
  'class', 'object_property', 'datatype_property', 'annotation_property', 'scheme', 'concept', 'shape',
];
const ref = (t: OntologyTerm): TermRef => ({ iri: t.iri, kind: t.kind, label: t.label });
const byLabel = (a: OntologyTerm, b: OntologyTerm) =>
  a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.iri.localeCompare(b.iri);
/** Neighbour lists in a detail are capped: the tree pages the rest. */
export const DETAIL_LIMIT = 200;

const jobParams = (input: NewOntologyVersion, version: number) => ({
  ontologyId: input.ontologyId,
  version,
  sourceKey: input.sourceKey,
  fileName: input.fileName,
  mediaType: input.mediaType,
});

/** Ranks search hits: exact label, label prefix, then by label. */
function rank(q: string, t: OntologyTerm): number {
  const label = t.label.toLowerCase();
  return label === q ? 0 : label.startsWith(q) ? 1 : 2;
}

function matches(q: string, t: OntologyTerm): boolean {
  return [t.label, t.iri, ...t.altLabels].some((s) => s.toLowerCase().includes(q));
}

/** Builds a detail from the version's terms: shared by both repos. */
export function termDetail(all: readonly OntologyTerm[], iri: string): TermDetail | null {
  const own = all
    .filter((t) => t.iri === iri)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0];
  if (!own) return null;
  const byIri = new Map<string, OntologyTerm>();
  for (const t of all) if (!byIri.has(t.iri)) byIri.set(t.iri, t);
  const refs = (iris: readonly string[]) =>
    iris.flatMap((i) => {
      const t = byIri.get(i);
      return t ? [ref(t)] : [];
    });
  const pick = (keep: (t: OntologyTerm) => boolean) =>
    all.filter(keep).sort(byLabel).slice(0, DETAIL_LIMIT).map(ref);
  const isProperty = (t: OntologyTerm) => TERM_GROUPS.properties.some((k) => k === t.kind);
  return {
    ...own,
    parentTerms: refs(own.parents),
    children: pick((t) => t.parents.includes(iri) && t.iri !== iri),
    domainTerms: refs(own.domain),
    rangeTerms: refs(own.range),
    schemeTerm: own.scheme ? (refs([own.scheme])[0] ?? null) : null,
    asDomain: pick((t) => isProperty(t) && t.domain.includes(iri)),
    asRange: pick((t) => isProperty(t) && t.range.includes(iri)),
    concepts: own.kind === 'scheme' ? pick((t) => t.kind === 'concept' && t.scheme === iri) : [],
    shapes: pick((t) => t.kind === 'shape' && t.domain.includes(iri)),
  };
}

interface MemoryOntology extends Omit<OntologySummary, 'latest' | 'versionCount'> {
  versions: OntologyVersionView[];
}

export class MemoryOntologyRepo implements OntologyRepo {
  private readonly ontologies = new Map<string, MemoryOntology>();
  private readonly termsByVersion = new Map<string, StoredTerm[]>();
  readonly jobs: { id: string; params: Record<string, unknown>; createdBy: string | null }[] = [];

  private summary(o: MemoryOntology): OntologySummary {
    const { versions, ...rest } = o;
    return { ...rest, latest: versions[0] ?? null, versionCount: versions.length };
  }

  async list(opts: { retired: boolean }): Promise<OntologySummary[]> {
    return [...this.ontologies.values()]
      .filter((o) => opts.retired || o.retiredAt === null)
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
      .map((o) => this.summary(o));
  }

  async get(id: string): Promise<OntologyDetail | null> {
    const o = this.ontologies.get(id);
    return o ? { ...this.summary(o), versions: [...o.versions] } : null;
  }

  async createVersion(input: NewOntologyVersion): Promise<CreateVersionResult> {
    let o = this.ontologies.get(input.ontologyId);
    if (!o) {
      if (!input.meta) return { ok: false, reason: 'needs-label' };
      o = {
        id: input.ontologyId,
        ...input.meta,
        retiredAt: null,
        createdBy: input.by,
        createdAt: new Date().toISOString(),
        versions: [],
      };
      this.ontologies.set(o.id, o);
    }
    const same = o.versions.find((v) => v.sha256 === input.sha256);
    if (same) return { ok: false, reason: 'duplicate', version: same.version };
    const number = (o.versions[0]?.version ?? 0) + 1;
    const version: OntologyVersionView = {
      ontologyId: o.id,
      version: number,
      status: 'queued',
      fileName: input.fileName,
      mediaType: input.mediaType,
      sha256: input.sha256,
      bytes: input.bytes,
      ontologyIri: null,
      versionIri: null,
      license: null,
      kinds: [],
      stats: null,
      imports: [],
      error: null,
      importedBy: input.by,
      importedAt: new Date().toISOString(),
    };
    o.versions.unshift(version);
    const jobId = randomUUID();
    this.jobs.push({ id: jobId, params: jobParams(input, number), createdBy: input.by });
    return { ok: true, version, jobId };
  }

  async update(id: string, patch: OntologyPatch): Promise<OntologySummary | null> {
    const o = this.ontologies.get(id);
    if (!o) return null;
    if (patch.label !== undefined) o.label = patch.label;
    if (patch.description !== undefined) o.description = patch.description;
    if (patch.tags !== undefined) o.tags = patch.tags;
    if (patch.localOnly !== undefined) o.localOnly = patch.localOnly;
    if (patch.retired !== undefined) {
      o.retiredAt = patch.retired ? (o.retiredAt ?? new Date().toISOString()) : null;
    }
    return this.summary(o);
  }

  async deleteVersion(id: string, version: number): Promise<DeleteVersionResult> {
    const o = this.ontologies.get(id);
    const v = o?.versions.find((x) => x.version === version);
    if (!o || !v) return { result: 'missing' };
    if (v.status === 'queued' || v.status === 'parsing') return { result: 'busy' };
    o.versions = o.versions.filter((x) => x !== v);
    this.termsByVersion.delete(`${id}:${version}`);
    if (o.versions.length === 0) this.ontologies.delete(id);
    return { result: 'deleted', sha256: v.sha256, fileName: v.fileName };
  }

  private version(id: string, version: number) {
    return this.ontologies.get(id)?.versions.find((v) => v.version === version) ?? null;
  }

  async terms(id: string, version: number, query: TermQuery): Promise<TermPage | null> {
    if (!this.version(id, version)) return null;
    const kinds: readonly string[] | null = query.group ? TERM_GROUPS[query.group] : null;
    const q = query.q?.trim().toLowerCase() ?? '';
    const hits = (this.termsByVersion.get(`${id}:${version}`) ?? [])
      .filter((t) => !kinds || kinds.includes(t.kind))
      .filter((t) => !query.parent || t.parents.includes(query.parent))
      .filter((t) => !query.root || t.root)
      .filter((t) => !q || matches(q, t))
      .sort((a, b) => (q ? rank(q, a) - rank(q, b) : 0) || byLabel(a, b));
    return {
      items: hits.slice(query.offset, query.offset + query.limit).map(({ root: _root, ...t }) => t),
      total: hits.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  async term(id: string, version: number, iri: string): Promise<TermDetail | null> {
    if (!this.version(id, version)) return null;
    const all = (this.termsByVersion.get(`${id}:${version}`) ?? []).map(({ root: _root, ...t }) => t);
    return termDetail(all, iri);
  }

  /** Test seeders: what the worker would have written. */
  markReady(id: string, version: number, extra: Partial<OntologyVersionView> = {}): void {
    Object.assign(this.version(id, version)!, { status: 'ready', kinds: ['owl'], ...extra });
  }

  markFailed(id: string, version: number, error: string): void {
    Object.assign(this.version(id, version)!, { status: 'failed', error });
  }

  seedTerms(id: string, version: number, terms: SeedTerm[]): void {
    this.termsByVersion.set(
      `${id}:${version}`,
      terms.map((t) => ({
        label: t.iri,
        altLabels: [],
        definition: '',
        parents: [],
        domain: [],
        range: [],
        scheme: null,
        deprecated: false,
        childCount: 0,
        root: false,
        ...t,
      })),
    );
  }
}
```

For `PgOntologyRepo`, copy the style of `PgLlmConfigRepo` in `apps/api/src/llm/repo.ts`:
raw SQL through the pool, `client` for transactions, `BEGIN/COMMIT/ROLLBACK` in
`try/catch/finally`.

```ts
const VERSION_COLS = `ontology_id, version, status, file_name, media_type, sha256, bytes,
  ontology_iri, version_iri, license, kinds, stats, imports, error, imported_by, imported_at`;

interface VersionRow {
  ontology_id: string; version: number; status: OntologyVersionView['status'];
  file_name: string; media_type: string; sha256: string; bytes: string | number;
  ontology_iri: string | null; version_iri: string | null; license: string | null;
  kinds: OntologyVersionView['kinds']; stats: OntologyVersionView['stats'];
  imports: OntologyVersionView['imports']; error: string | null;
  imported_by: string | null; imported_at: Date | string;
}

const iso = (v: Date | string) => new Date(v).toISOString();

function toVersion(r: VersionRow): OntologyVersionView {
  return {
    ontologyId: r.ontology_id, version: r.version, status: r.status, fileName: r.file_name,
    mediaType: r.media_type, sha256: r.sha256, bytes: Number(r.bytes),
    ontologyIri: r.ontology_iri, versionIri: r.version_iri, license: r.license,
    kinds: r.kinds, stats: r.stats, imports: r.imports, error: r.error,
    importedBy: r.imported_by, importedAt: iso(r.imported_at),
  };
}

interface OntologyRow {
  id: string; label: string; description: string; tags: string[]; local_only: boolean;
  retired_at: Date | null; created_by: string | null; created_at: Date;
  version_count: number; latest: VersionRow | null;
}

const SUMMARY_SELECT = `
  SELECT o.*,
    (SELECT count(*)::int FROM ontology_versions v WHERE v.ontology_id = o.id) AS version_count,
    (SELECT row_to_json(v) FROM (SELECT ${VERSION_COLS} FROM ontology_versions v
       WHERE v.ontology_id = o.id ORDER BY version DESC LIMIT 1) v) AS latest
  FROM ontologies o`;

function toSummary(r: OntologyRow): OntologySummary {
  return {
    id: r.id, label: r.label, description: r.description, tags: r.tags, localOnly: r.local_only,
    retiredAt: r.retired_at ? iso(r.retired_at) : null, createdBy: r.created_by,
    createdAt: iso(r.created_at), latest: r.latest ? toVersion(r.latest) : null,
    versionCount: r.version_count,
  };
}

const TERM_COLS = `iri, kind, label, alt_labels, definition, parents, domains, ranges, scheme,
  deprecated, child_count`;
interface TermRow {
  iri: string; kind: OntologyTermKind; label: string; alt_labels: string[]; definition: string;
  parents: string[]; domains: string[]; ranges: string[]; scheme: string | null;
  deprecated: boolean; child_count: number;
}
const toTerm = (r: TermRow): OntologyTerm => ({
  iri: r.iri, kind: r.kind, label: r.label, altLabels: r.alt_labels, definition: r.definition,
  parents: r.parents, domain: r.domains, range: r.ranges, scheme: r.scheme,
  deprecated: r.deprecated, childCount: r.child_count,
});

/** `%` and `_` in a search are literal. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PgOntologyRepo implements OntologyRepo {
  constructor(private readonly pool: pg.Pool) {}

  async list(opts: { retired: boolean }): Promise<OntologySummary[]> {
    const { rows } = await this.pool.query<OntologyRow>(
      `${SUMMARY_SELECT} WHERE $1 OR o.retired_at IS NULL ORDER BY lower(o.label), o.id`,
      [opts.retired],
    );
    return rows.map(toSummary);
  }

  private async summary(id: string): Promise<OntologySummary | null> {
    const { rows } = await this.pool.query<OntologyRow>(`${SUMMARY_SELECT} WHERE o.id = $1`, [id]);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async get(id: string): Promise<OntologyDetail | null> {
    const summary = await this.summary(id);
    if (!summary) return null;
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLS} FROM ontology_versions WHERE ontology_id = $1 ORDER BY version DESC`,
      [id],
    );
    return { ...summary, versions: rows.map(toVersion) };
  }

  async createVersion(input: NewOntologyVersion): Promise<CreateVersionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One import per ontology at a time: versions are numbered in order.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ontology:' || $1))`, [input.ontologyId]);
      const exists = (await client.query('SELECT 1 FROM ontologies WHERE id = $1', [input.ontologyId])).rowCount;
      if (!exists) {
        if (!input.meta) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'needs-label' };
        }
        await client.query(
          `INSERT INTO ontologies (id, label, description, tags, local_only, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.ontologyId, input.meta.label, input.meta.description, input.meta.tags, input.meta.localOnly, input.by],
        );
      }
      const same = await client.query<{ version: number }>(
        'SELECT version FROM ontology_versions WHERE ontology_id = $1 AND sha256 = $2',
        [input.ontologyId, input.sha256],
      );
      if (same.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'duplicate', version: same.rows[0].version };
      }
      const next = (
        await client.query<{ next: number }>(
          'SELECT coalesce(max(version), 0) + 1 AS next FROM ontology_versions WHERE ontology_id = $1',
          [input.ontologyId],
        )
      ).rows[0]!.next;
      const job = await client.query<{ id: string }>(
        `INSERT INTO jobs (task, test, priority, max_attempts, params, created_by)
         VALUES ('ontology', false, $1, 3, $2, $3) RETURNING id`,
        [ONTOLOGY_PRIORITY, JSON.stringify(jobParams(input, next)), input.by],
      );
      const jobId = job.rows[0]!.id;
      const { rows } = await client.query<VersionRow>(
        `INSERT INTO ontology_versions
           (ontology_id, version, file_name, media_type, sha256, bytes, job_id, imported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${VERSION_COLS}`,
        [input.ontologyId, next, input.fileName, input.mediaType, input.sha256, input.bytes, jobId, input.by],
      );
      await client.query('COMMIT');
      return { ok: true, version: toVersion(rows[0]!), jobId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(id: string, patch: OntologyPatch): Promise<OntologySummary | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, value: unknown) => {
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.label !== undefined) set('label', patch.label);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.tags !== undefined) set('tags', patch.tags);
    if (patch.localOnly !== undefined) set('local_only', patch.localOnly);
    if (patch.retired !== undefined) {
      sets.push(patch.retired ? 'retired_at = coalesce(retired_at, now())' : 'retired_at = NULL');
    }
    if (sets.length > 0) {
      values.push(id);
      const { rowCount } = await this.pool.query(
        `UPDATE ontologies SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values,
      );
      if (!rowCount) return null;
    }
    return this.summary(id);
  }

  async deleteVersion(id: string, version: number): Promise<DeleteVersionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ status: string; sha256: string; file_name: string; job_id: string | null }>(
        `SELECT status, sha256, file_name, job_id FROM ontology_versions
          WHERE ontology_id = $1 AND version = $2 FOR UPDATE`,
        [id, version],
      );
      const row = rows[0];
      if (!row || row.status === 'queued' || row.status === 'parsing') {
        await client.query('ROLLBACK');
        return { result: row ? 'busy' : 'missing' };
      }
      await client.query('DELETE FROM ontology_versions WHERE ontology_id = $1 AND version = $2', [id, version]);
      if (row.job_id) await client.query('DELETE FROM jobs WHERE id = $1', [row.job_id]);
      await client.query(
        `DELETE FROM ontologies WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM ontology_versions WHERE ontology_id = $1)`,
        [id],
      );
      await client.query('COMMIT');
      return { result: 'deleted', sha256: row.sha256, fileName: row.file_name };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async hasVersion(id: string, version: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM ontology_versions WHERE ontology_id = $1 AND version = $2',
      [id, version],
    );
    return !!rowCount;
  }

  async terms(id: string, version: number, query: TermQuery): Promise<TermPage | null> {
    if (!(await this.hasVersion(id, version))) return null;
    const values: unknown[] = [id, version];
    const where = ['t.ontology_id = $1', 't.version = $2'];
    const param = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
    if (query.group) where.push(`t.kind = ANY(${param([...TERM_GROUPS[query.group]])}::text[])`);
    if (query.parent) where.push(`t.parents @> ARRAY[${param(query.parent)}]::text[]`);
    if (query.root) where.push('t.root');
    let order = 'lower(t.label), t.iri';
    const q = query.q?.trim().toLowerCase();
    if (q) {
      const exact = param(q);
      const prefix = param(`${escapeLike(q)}%`);
      const anywhere = param(`%${escapeLike(q)}%`);
      where.push(`(lower(t.label) LIKE ${anywhere} OR lower(t.iri) LIKE ${anywhere}
        OR EXISTS (SELECT 1 FROM unnest(t.alt_labels) a WHERE lower(a) LIKE ${anywhere}))`);
      order = `(lower(t.label) = ${exact}) DESC, (lower(t.label) LIKE ${prefix}) DESC,
        similarity(lower(t.label), ${exact}) DESC, lower(t.label), t.iri`;
    }
    const filter = where.join(' AND ');
    const total = (
      await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ontology_terms t WHERE ${filter}`, values)
    ).rows[0]!.n;
    const { rows } = await this.pool.query<TermRow>(
      `SELECT ${TERM_COLS} FROM ontology_terms t WHERE ${filter}
        ORDER BY ${order} LIMIT ${param(query.limit)} OFFSET ${param(query.offset)}`,
      values,
    );
    return { items: rows.map(toTerm), total, offset: query.offset, limit: query.limit };
  }

  async term(id: string, version: number, iri: string): Promise<TermDetail | null> {
    if (!(await this.hasVersion(id, version))) return null;
    // The term and every row that can be its neighbour: its own rows, rows it names, rows naming it.
    const { rows } = await this.pool.query<TermRow>(
      `WITH own AS (SELECT * FROM ontology_terms WHERE ontology_id = $1 AND version = $2 AND iri = $3)
       SELECT ${TERM_COLS} FROM ontology_terms t
        WHERE t.ontology_id = $1 AND t.version = $2
          AND (t.iri = $3
               OR t.iri IN (SELECT unnest(parents || domains || ranges) FROM own)
               OR t.iri IN (SELECT scheme FROM own WHERE scheme IS NOT NULL)
               OR t.parents @> ARRAY[$3] OR t.domains @> ARRAY[$3] OR t.ranges @> ARRAY[$3]
               OR t.scheme = $3)`,
      [id, version, iri],
    );
    return termDetail(rows.map(toTerm), iri);
  }
}
```

- [ ] **Step 4: Write the Pg integration test** `apps/api/test/integration/ontology-pg.test.ts`

```ts
/**
 * Opt-in Postgres test for PgOntologyRepo (migration 0032). Skipped unless IH_TEST_DATABASE_URL
 * points at a THROWAWAY database: it applies db/migrations and writes ontology rows. Example:
 * docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgOntologyRepo, type NewOntologyVersion } from '../../src/ontologies/repo.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const C = 'https://example.org/pv#';

const input = (over: Partial<NewOntologyVersion> = {}): NewOntologyVersion => ({
  ontologyId: 'pv-pg',
  meta: { label: 'PV', description: '', tags: ['industry:pharma'], localOnly: false },
  fileName: 'pv.ttl', mediaType: 'text/turtle', sourceKey: 'k', sha256: 'aaa', bytes: 10, by: 'Ken',
  ...over,
});

describe.skipIf(!url)('ontology library against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgOntologyRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = new PgOntologyRepo(pool);
    await pool.query(`DELETE FROM ontologies WHERE id = 'pv-pg'`);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM ontologies WHERE id = 'pv-pg'`);
    await pool?.end();
  });

  it('imports, indexes, searches, describes and deletes', async () => {
    const created = await repo.createVersion(input());
    expect(created).toMatchObject({ ok: true, version: { version: 1, status: 'queued' } });
    expect(await repo.createVersion(input({ meta: null }))).toEqual({ ok: false, reason: 'duplicate', version: 1 });
    const job = await pool.query(`SELECT task, priority, created_by, params FROM jobs WHERE id = $1`, [
      created.ok ? created.jobId : '',
    ]);
    expect(job.rows[0]).toMatchObject({ task: 'ontology', priority: -10, created_by: 'Ken', params: { version: 1 } });
    expect(await repo.deleteVersion('pv-pg', 1)).toEqual({ result: 'busy' });

    // What the worker writes.
    await pool.query(
      `INSERT INTO ontology_terms (ontology_id, version, iri, kind, label, alt_labels, parents, domains, ranges, root, child_count)
       VALUES ('pv-pg', 1, $1, 'class', 'Document', '{}', '{}', '{}', '{}', true, 1),
              ('pv-pg', 1, $2, 'class', 'Protocol', '{Validation protocol}', $3, '{}', '{}', false, 0),
              ('pv-pg', 1, $4, 'object_property', 'has protocol', '{}', '{}', '{}', $5, true, 0)`,
      [`${C}Document`, `${C}Protocol`, [`${C}Document`], `${C}hasProtocol`, [`${C}Protocol`]],
    );
    await pool.query(`UPDATE ontology_versions SET status = 'ready' WHERE ontology_id = 'pv-pg'`);
    await expect(
      pool.query(`UPDATE ontology_versions SET error = 'x' WHERE ontology_id = 'pv-pg'`),
    ).rejects.toThrow(/cannot change/);

    const roots = await repo.terms('pv-pg', 1, { group: 'classes', root: true, offset: 0, limit: 10 });
    expect(roots!.items.map((t) => t.label)).toEqual(['Document']);
    const kids = await repo.terms('pv-pg', 1, { parent: `${C}Document`, offset: 0, limit: 10 });
    expect(kids!.items.map((t) => t.label)).toEqual(['Protocol']);
    const found = await repo.terms('pv-pg', 1, { q: 'validation', offset: 0, limit: 10 });
    expect(found!.items.map((t) => t.label)).toEqual(['Protocol']);
    const literal = await repo.terms('pv-pg', 1, { q: '%', offset: 0, limit: 10 });
    expect(literal!.total).toBe(0);
    const protocol = await repo.term('pv-pg', 1, `${C}Protocol`);
    expect(protocol).toMatchObject({
      parentTerms: [{ label: 'Document' }],
      asRange: [{ label: 'has protocol' }],
    });

    expect(await repo.update('pv-pg', { retired: true })).toMatchObject({ retiredAt: expect.any(String) });
    expect((await repo.list({ retired: false })).some((o) => o.id === 'pv-pg')).toBe(false);
    expect(await repo.deleteVersion('pv-pg', 1)).toEqual({ result: 'deleted', sha256: 'aaa', fileName: 'pv.ttl' });
    expect(await repo.get('pv-pg')).toBeNull();
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/api/test/ontology-repo.test.ts`
Expected: PASS.

Then the Pg test, on a throwaway database:

```bash
docker run --rm -d --name ih-test-pg-onto -e POSTGRES_PASSWORD=test -p 55444:5432 postgres:17-alpine
IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55444/postgres npx vitest run --config apps/api/vitest.integration.config.ts ontology-pg
```

Expected: PASS. Then run the worker's Pg test against the same database:

```bash
cd worker && IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55444/postgres uv run pytest tests/test_ontology_job.py -m integration -q
docker stop ih-test-pg-onto
```

Expected: PASS. If Docker is not available, say so in the PR. Do not skip silently.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ontologies apps/api/test/ontology-repo.test.ts apps/api/test/integration/ontology-pg.test.ts
git commit -m "API: OntologyRepo (memory and Postgres)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API routes (import, list, get, patch, delete, source)

**Files:**
- Create: `apps/api/src/routes/ontologies.ts`
- Modify:
  - `apps/api/src/app.ts` (the `ontologies: OntologyRepo` dep and route registration)
  - `apps/api/src/server.ts` (`new PgOntologyRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 }))`)
  - `apps/api/test/helpers.ts` (default `MemoryOntologyRepo`, returned as `ontologies`)
  - `apps/api/src/openapi/document.ts` (tag `Ontologies` in `TAGS` and in the `Configuration` group)
  - `apps/api/src/openapi/zod.ts` (`multipart(fields, required, fileDescription = 'The PDF. Send it last.')`)
- Test: `apps/api/test/ontologies.test.ts`

**Interfaces:**
- Consumes: `OntologyRepo`, `MemoryOntologyRepo` (Task 4), `ontologyFormat`,
  `ontologySourceKey`, `ontologyNormalizedKey`, `ONTOLOGY_ID_RE`, `TAG_RE`, the schemas
  (Task 1), and `multipartField` (`apps/api/src/uploads.ts`).
- Produces these routes. Task 6 adds terms and term detail to the same file.
  - `GET /api/ontologies?retired=include`
  - `POST /api/ontologies` (admin, multipart: `id`, `label`, `description`, `tags`
    comma-separated, `localOnly` `'true'`, then `file`) → 202 `OntologyVersionView`
  - `GET /api/ontologies/:id`
  - `PATCH /api/ontologies/:id` (admin)
  - `DELETE /api/ontologies/:id/versions/:version` (admin) → 204
  - `GET /api/ontologies/:id/versions/:version/source`

- [ ] **Step 1: Write the failing route tests** `apps/api/test/ontologies.test.ts`

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { accessApp, multipart, testApp } from './helpers.js';

const TTL = Buffer.from('@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://e.org/A> a owl:Class .\n');
const sha = createHash('sha256').update(TTL).digest('hex');

async function setup() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  const upload = (fields: Record<string, string>, file = { filename: 'pv.ttl', content: TTL, contentType: 'text/turtle' }) =>
    ctx.app.inject({ method: 'POST', url: '/api/ontologies', ...multipart(fields, file) });
  return { ...ctx, ontologies, upload };
}

describe('POST /api/ontologies', () => {
  it('stores the file by its bytes and queues an import', async () => {
    const { upload, store, ontologies } = await setup();
    const res = await upload({ id: 'pv', label: 'Process validation', tags: 'industry:pharma, customer:acme', localOnly: 'true' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ontologyId: 'pv', version: 1, status: 'queued', sha256: sha, mediaType: 'text/turtle' });
    expect(store.objects.has(`runs/ontologies/pv/sources/${sha}.ttl`)).toBe(true);
    expect(ontologies.jobs[0]!.params).toMatchObject({ sourceKey: `ontologies/pv/sources/${sha}.ttl`, fileName: 'pv.ttl' });
    const list = await (await setup()).app.inject({ url: '/api/ontologies' });
    expect(list.statusCode).toBe(200);
    const detail = (await upload({ id: 'pv' })).json();
    expect(detail).toEqual({ error: `this file is already version 1 of pv` });
  });

  it.each([
    [{ id: 'PV', label: 'x' }, 400, /id must be/],
    [{ id: 'pv' }, 400, /name is required for a new ontology/],
    [{ id: 'pv', label: 'x', tags: 'Not A Tag' }, 400, /tag "Not A Tag"/],
  ])('refuses %j', async (fields, status, message) => {
    const { upload } = await setup();
    const res = await upload(fields);
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toMatch(message);
  });

  it('refuses files that are not RDF, and the same bytes twice', async () => {
    const { upload } = await setup();
    const pdf = await upload({ id: 'pv', label: 'x' }, { filename: 'pv.pdf', content: TTL, contentType: 'application/pdf' });
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json().error).toMatch(/not a supported RDF format \(\.ttl,\.owl/);
    expect((await upload({ id: 'pv', label: 'x' })).statusCode).toBe(202);
    const again = await upload({ id: 'pv' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('this file is already version 1 of pv');
  });

  it('is admin-only', async () => {
    const { app, userCookie } = await accessApp();
    const res = await app.inject({
      method: 'POST', url: '/api/ontologies', headers: { cookie: userCookie },
      ...multipart({ id: 'pv', label: 'x' }, { filename: 'pv.ttl', content: TTL }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'admins only' });
  });
});

describe('reading and managing ontologies', () => {
  it('lists, hides retired ones unless asked, and shows versions newest first', async () => {
    const { app, upload } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    expect((await app.inject({ method: 'PATCH', url: '/api/ontologies/pv', payload: { retired: true } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/ontologies' })).json()).toEqual([]);
    const all = (await app.inject({ url: '/api/ontologies?retired=include' })).json();
    expect(all).toMatchObject([{ id: 'pv', retiredAt: expect.any(String), versionCount: 1 }]);
    const detail = await app.inject({ url: '/api/ontologies/pv' });
    expect(detail.json()).toMatchObject({ id: 'pv', versions: [{ version: 1 }] });
    expect((await app.inject({ url: '/api/ontologies/nope' })).statusCode).toBe(404);
  });

  it('patches with a strict body', async () => {
    const { app, upload } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    const bad = await app.inject({ method: 'PATCH', url: '/api/ontologies/pv', payload: { version: 3 } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: '/api/ontologies/pv', payload: { label: 'PV', tags: ['customer:acme'] } });
    expect(ok.json()).toMatchObject({ label: 'PV', tags: ['customer:acme'] });
    expect((await app.inject({ method: 'PATCH', url: '/api/ontologies/nope', payload: { label: 'x' } })).statusCode).toBe(404);
  });

  it('deletes a finished version and its files; refuses one still importing', async () => {
    const { app, upload, ontologies, store } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    const busy = await app.inject({ method: 'DELETE', url: '/api/ontologies/pv/versions/1' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('version 1 of pv is still being imported');
    ontologies.markReady('pv', 1);
    await store.put('runs', 'ontologies/pv/v1/normalized.nt', Buffer.from('x'), 'application/n-triples');
    const gone = await app.inject({ method: 'DELETE', url: '/api/ontologies/pv/versions/1' });
    expect(gone.statusCode).toBe(204);
    expect([...store.objects.keys()].filter((k) => k.includes('ontologies/pv'))).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: '/api/ontologies/pv/versions/1' })).statusCode).toBe(404);
  });

  it('downloads the source as imported', async () => {
    const { app, upload } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    const res = await app.inject({ url: '/api/ontologies/pv/versions/1/source' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/turtle');
    expect(res.headers['content-disposition']).toBe('attachment; filename="pv.ttl"');
    expect(res.rawPayload.equals(TTL)).toBe(true);
    expect((await app.inject({ url: '/api/ontologies/pv/versions/9/source' })).statusCode).toBe(404);
  });
});
```

The first test calls `(await setup()).app` for the list, which builds a fresh app; that line
only checks that the route answers. Keep it as written. Separately, confirm that
`MemoryObjectStore.objects` is keyed `` `${bucket}/${key}` `` (the API report says it is,
`storage/object-store.ts:12`).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run apps/api/test/ontologies.test.ts`
Expected: FAIL with 404s (no routes), plus a type error because `ontologies` is not in
`AppDeps`.

- [ ] **Step 3: Implement the wiring and the routes**

In `apps/api/src/app.ts`:
- Import the type: `import type { OntologyRepo } from './ontologies/repo.js';`.
- Add the field to `AppDeps`:
  `/** The ontology library (ADR 0011): imported versions and their indexed terms. */ ontologies: OntologyRepo;`
- Register the routes with the other routes: `await app.register(ontologyRoutes, { prefix: '/api' });`.

In `apps/api/test/helpers.ts`:
- Create `const ontologies = new MemoryOntologyRepo();` and pass `ontologies` into `buildApp`
  before `...overrides`.
- Return `ontologies: (overrides.ontologies ?? ontologies) as MemoryOntologyRepo`.

In `apps/api/src/server.ts`, add
`ontologies: new PgOntologyRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })),`.

In `apps/api/src/openapi/document.ts`:
- Add the tag to `TAGS`:

```ts
  Ontologies: md`
    The ontology library (ADR 0011): customer and industry ontologies (OWL/RDFS, SKOS, SHACL)
    that document types map their outputs to. Admins import a file as a new immutable
    version; the worker parses it and indexes its terms, which anyone signed in can browse.`,
```

- Add `'Ontologies'` to the `Configuration` group in `TAG_GROUPS`.

In `apps/api/src/openapi/zod.ts`, give `multipart` a third parameter,
`fileDescription = 'The PDF. Send it last.'`, and use it for the `file` property.

Create `apps/api/src/routes/ontologies.ts`:

```ts
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ONTOLOGY_ACCEPT,
  ONTOLOGY_ID_RE,
  OntologyDetailSchema,
  OntologyPatchSchema,
  OntologySummarySchema,
  OntologyVersionViewSchema,
  TAG_RE,
  ontologyFormat,
  ontologyNormalizedKey,
  ontologySourceKey,
} from '@ih/shared';
import { binary, error, md, multipart, noContent, res } from '../openapi/zod.js';
import { multipartField } from '../uploads.js';

const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND = error('No such ontology or version.');
const IdParams = z.object({ id: z.string().describe('Ontology id, e.g. `idmp-o`.') });
const VersionParams = IdParams.extend({
  version: z.coerce.number().int().positive().describe('Version number (1 is the first import).'),
});
const ListQuery = z.object({
  retired: z.enum(['include']).optional().describe('`include` lists retired ontologies too.'),
});

const ID_RULE = 'id must be 2-63 lowercase letters, digits or dashes, starting with a letter or digit';

/** Comma-separated tags from the multipart field; every tag must match TAG_RE. */
function parseTags(raw: string | undefined): { tags: string[] } | { error: string } {
  const tags = (raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const bad = tags.find((t) => !TAG_RE.test(t));
  return bad === undefined
    ? { tags }
    : { error: `tag "${bad}" must be lowercase letters, digits and : . _ - (for example industry:pharma)` };
}

export async function ontologyRoutes(app: FastifyInstance): Promise<void> {
  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  };
  const base = (operationId: string, summary: string, description: string) => ({
    tags: ['Ontologies'],
    operationId,
    summary,
    description,
  });

  app.get('/ontologies', {
    schema: {
      ...base('listOntologies', 'List the ontology library', md`
        Every ontology in the library with its newest version (whatever its status) and how
        many versions it has, by name. Retired ontologies are left out unless
        \`retired=include\`.`),
      querystring: ListQuery,
      response: { 200: res('The library.', z.array(OntologySummarySchema)) },
    },
  }, async (req) => {
    const query = ListQuery.safeParse(req.query ?? {});
    return app.deps.ontologies.list({ retired: query.success && query.data.retired === 'include' });
  });

  app.post('/ontologies', {
    preHandler: adminOnly,
    schema: {
      ...base('importOntology', 'Import an ontology file', md`
        **Admin token required.** Stores the file and queues its import as the next version of
        the ontology \`id\` (a new ontology needs \`label\`). The worker parses it (Turtle,
        RDF/XML, JSON-LD, N-Triples or N3, judged by the file name) and indexes its classes,
        properties, SKOS concepts and SHACL shapes; the version's \`status\` moves from
        \`queued\` to \`ready\` or \`failed\`. The same bytes twice under one id are refused.`),
      'x-admin': true,
      consumes: ['multipart/form-data'],
      body: multipart(
        {
          id: { type: 'string', description: 'Ontology id (new or existing), e.g. `idmp-o`.' },
          label: { type: 'string', description: 'Name; required for a new ontology.' },
          description: { type: 'string', description: 'Optional description (new ontologies).' },
          tags: { type: 'string', description: 'Comma-separated tags, e.g. `industry:pharma`.' },
          localOnly: { type: 'string', enum: ['true', 'false'], description: '`true`: never sent to external models.' },
        },
        ['id'],
        `The ontology file (${ONTOLOGY_ACCEPT}). Send it last.`,
      ),
      response: {
        202: res('The queued version.', OntologyVersionViewSchema),
        400: error('A missing or invalid field, or an empty file.'),
        403: ADMINS_ONLY,
        409: error('The same file is already a version of this ontology.'),
        413: error('The file is over the upload limit.'),
        415: error('Not a supported RDF format.'),
      },
    },
  }, async (req, reply) => {
    const { store, buckets, ontologies } = app.deps;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file part is required' });
    const id = (multipartField(file, 'id') ?? '').trim();
    if (!ONTOLOGY_ID_RE.test(id)) return reply.code(400).send({ error: ID_RULE });
    const format = ontologyFormat(file.filename);
    if (!format) {
      return reply.code(415).send({ error: `file is not a supported RDF format (${ONTOLOGY_ACCEPT})` });
    }
    const label = (multipartField(file, 'label') ?? '').trim();
    const tags = parseTags(multipartField(file, 'tags'));
    if ('error' in tags) return reply.code(400).send({ error: tags.error });
    const existing = await ontologies.get(id);
    if (!existing && !label) return reply.code(400).send({ error: 'name is required for a new ontology' });
    const body = await file.toBuffer(); // a RequestFileTooLargeError (413) past the limit
    if (body.length === 0) return reply.code(400).send({ error: 'file is empty' });
    const sha256 = createHash('sha256').update(body).digest('hex');
    const sourceKey = ontologySourceKey(id, sha256, format.ext);
    await store.put(buckets.runs, sourceKey, body, format.mediaType);
    const result = await ontologies.createVersion({
      ontologyId: id,
      meta: existing
        ? null
        : {
            label,
            description: (multipartField(file, 'description') ?? '').trim(),
            tags: tags.tags,
            localOnly: multipartField(file, 'localOnly') === 'true',
          },
      fileName: file.filename,
      mediaType: format.mediaType,
      sourceKey,
      sha256,
      bytes: body.length,
      by: by(req),
    });
    if (!result.ok) {
      if (result.reason === 'duplicate') {
        return reply.code(409).send({ error: `this file is already version ${result.version} of ${id}` });
      }
      await store.delete(buckets.runs, sourceKey);
      return reply.code(400).send({ error: 'name is required for a new ontology' });
    }
    req.log.info({ ontology: id, version: result.version.version, by: by(req) }, 'ontology imported');
    return reply.code(202).send(result.version);
  });

  app.get('/ontologies/:id', {
    schema: {
      ...base('getOntology', 'One ontology with its versions', md`
        The ontology's metadata and every version, newest first, with each version's status,
        counts and any \`owl:imports\` it names (listed, not resolved).`),
      params: IdParams,
      response: { 200: res('The ontology.', OntologyDetailSchema), 404: NOT_FOUND },
    },
  }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const detail = await app.deps.ontologies.get(id);
    return detail ?? reply.code(404).send({ error: 'ontology not found' });
  });

  app.patch('/ontologies/:id', {
    preHandler: adminOnly,
    schema: {
      ...base('updateOntology', 'Edit an ontology', md`
        **Admin token required.** Changes the name, description, tags or the *Local only*
        flag, or retires the ontology (\`retired: true\`): a retired ontology is hidden from
        the library and pickers, and everything that pins it keeps working.`),
      'x-admin': true,
      params: IdParams,
      body: OntologyPatchSchema,
      response: {
        200: res('The ontology.', OntologySummarySchema),
        400: error('An invalid body.'),
        403: ADMINS_ONLY,
        404: NOT_FOUND,
      },
    },
  }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const patch = OntologyPatchSchema.safeParse(req.body ?? {});
    if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
    const updated = await app.deps.ontologies.update(id, patch.data);
    if (!updated) return reply.code(404).send({ error: 'ontology not found' });
    req.log.info({ ontology: id, by: by(req) }, 'ontology updated');
    return updated;
  });

  app.delete('/ontologies/:id/versions/:version', {
    preHandler: adminOnly,
    schema: {
      ...base('deleteOntologyVersion', 'Delete an ontology version', md`
        **Admin token required.** Deletes a version that is \`ready\` or \`failed\`, with its
        indexed terms and files; deleting the last version deletes the ontology. A version
        still being imported cannot be deleted.`),
      'x-admin': true,
      params: VersionParams,
      response: {
        204: noContent('Deleted.'),
        403: ADMINS_ONLY,
        404: NOT_FOUND,
        409: error('The version is still being imported.'),
      },
    },
  }, async (req, reply) => {
    const params = VersionParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'version not found' });
    const { id, version } = params.data;
    const outcome = await app.deps.ontologies.deleteVersion(id, version);
    if (outcome.result === 'missing') return reply.code(404).send({ error: 'version not found' });
    if (outcome.result === 'busy') {
      return reply.code(409).send({ error: `version ${version} of ${id} is still being imported` });
    }
    const { store, buckets } = app.deps;
    const ext = ontologyFormat(outcome.fileName)?.ext;
    for (const key of [ext ? ontologySourceKey(id, outcome.sha256, ext) : null, ontologyNormalizedKey(id, version)]) {
      if (key) await store.delete(buckets.runs, key).catch((err: unknown) => req.log.warn({ err, key }, 'ontology file not removed'));
    }
    req.log.info({ ontology: id, version, by: by(req) }, 'ontology version deleted');
    return reply.code(204).send();
  });

  app.get('/ontologies/:id/versions/:version/source', {
    schema: {
      ...base('downloadOntologySource', 'Download an ontology file', md`
        The file of this version exactly as it was imported, as an attachment named after
        the uploaded file.`),
      params: VersionParams,
      response: {
        200: binary('The ontology file.', ...new Set(['text/turtle', 'application/rdf+xml', 'application/ld+json', 'application/n-triples', 'text/n3'])),
        404: NOT_FOUND,
      },
    },
  }, async (req, reply) => {
    const params = VersionParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'version not found' });
    const { id, version } = params.data;
    const v = (await app.deps.ontologies.get(id))?.versions.find((x) => x.version === version);
    const ext = v ? ontologyFormat(v.fileName)?.ext : undefined;
    const body = v && ext ? await app.deps.store.get(app.deps.buckets.runs, ontologySourceKey(id, v.sha256, ext)) : null;
    if (!v || !body) return reply.code(404).send({ error: 'version not found' });
    return reply
      .header('content-type', v.mediaType)
      .header('content-disposition', `attachment; filename="${v.fileName.replace(/["\\\r\n]/g, '_')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
```

`MemoryObjectStore.delete` may be synchronous or return a promise. If it is synchronous,
wrap the call as `Promise.resolve().then(() => store.delete(...))` so `.catch` works, or use
`try`/`await`. Keep the behaviour: a failed removal is logged, never a 500.

- [ ] **Step 4: Run the tests to see them pass, plus the sweeps**

Run: `npx vitest run apps/api/test/ontologies.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts`
Expected:
- the ontology tests PASS;
- `access.test.ts` PASSES, because every new route answers 401 when signed out;
- `openapi.test.ts` passes except the `docs/openapi.json` snapshot.

To regenerate the snapshot, run `npm run openapi` and check the diff only adds the
`Ontologies` routes and tag.

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/openapi.json
git commit -m "API: ontology library routes (import, list, edit, delete, download)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API term routes (search, tree children, detail)

**Files:**
- Modify: `apps/api/src/routes/ontologies.ts` (append two routes)
- Test: append to `apps/api/test/ontologies.test.ts`

**Interfaces:**
- Consumes: `OntologyRepo.terms` and `OntologyRepo.term` (Task 4), `TermQuerySchema`,
  `TermPageSchema` and `TermDetailSchema` (Task 1).
- Produces:
  - `GET /api/ontologies/:id/versions/:version/terms?group=&q=&parent=&root=1&offset=&limit=` → `TermPage`
  - `GET /api/ontologies/:id/versions/:version/term?iri=` → `TermDetail`

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe('browsing terms', () => {
  const C = 'https://example.org/pv#';
  async function ready() {
    const ctx = await setup();
    await ctx.upload({ id: 'pv', label: 'Process validation' });
    ctx.ontologies.markReady('pv', 1);
    ctx.ontologies.seedTerms('pv', 1, [
      { iri: `${C}Document`, kind: 'class', label: 'Document', root: true, childCount: 1 },
      { iri: `${C}Protocol`, kind: 'class', label: 'Protocol', parents: [`${C}Document`] },
    ]);
    return ctx;
  }

  it('pages roots, children and search hits', async () => {
    const { app } = await ready();
    const roots = await app.inject({ url: '/api/ontologies/pv/versions/1/terms?group=classes&root=1' });
    expect(roots.json()).toMatchObject({ total: 1, offset: 0, limit: 100, items: [{ label: 'Document', childCount: 1 }] });
    const kids = await app.inject({ url: `/api/ontologies/pv/versions/1/terms?parent=${encodeURIComponent(`${C}Document`)}` });
    expect(kids.json().items.map((t: { label: string }) => t.label)).toEqual(['Protocol']);
    const hits = await app.inject({ url: '/api/ontologies/pv/versions/1/terms?q=proto&limit=5' });
    expect(hits.json()).toMatchObject({ limit: 5, items: [{ label: 'Protocol' }] });
  });

  it('refuses a bad query and an unknown version', async () => {
    const { app } = await ready();
    expect((await app.inject({ url: '/api/ontologies/pv/versions/1/terms?group=nope' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/ontologies/pv/versions/1/terms?limit=999' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/ontologies/pv/versions/2/terms' })).statusCode).toBe(404);
  });

  it('describes a term', async () => {
    const { app } = await ready();
    const res = await app.inject({ url: `/api/ontologies/pv/versions/1/term?iri=${encodeURIComponent(`${C}Protocol`)}` });
    expect(res.json()).toMatchObject({ label: 'Protocol', parentTerms: [{ label: 'Document' }] });
    expect((await app.inject({ url: '/api/ontologies/pv/versions/1/term' })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/ontologies/pv/versions/1/term?iri=${encodeURIComponent(`${C}Nope`)}` })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run apps/api/test/ontologies.test.ts -t "browsing terms"`
Expected: FAIL with 404 status codes.

- [ ] **Step 3: Implement** (append inside `ontologyRoutes`)

```ts
  const TermParams = VersionParams;
  const TermDetailQuery = z.object({ iri: z.string().min(1).max(2000).describe('The term IRI.') });

  app.get('/ontologies/:id/versions/:version/terms', {
    schema: {
      ...base('listOntologyTerms', 'Search and page ontology terms', md`
        One page of a version's terms, by label. \`group\` keeps one browser tab
        (\`classes\`, \`properties\`, \`concepts\` — schemes and concepts — or \`shapes\`);
        \`root=1\` keeps the tops of the hierarchy, \`parent\` one term's children (a top
        concept's parent is its scheme); \`q\` searches labels, synonyms and IRIs, exact and
        prefix matches first. At most 500 per page.`),
      params: TermParams,
      querystring: TermQuerySchema,
      response: {
        200: res('One page of terms.', TermPageSchema),
        400: error('An invalid query.'),
        404: NOT_FOUND,
      },
    },
  }, async (req, reply) => {
    const params = TermParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'version not found' });
    const query = TermQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: query.error.issues });
    const { group, q, parent, root, offset, limit } = query.data;
    const page = await app.deps.ontologies.terms(params.data.id, params.data.version, {
      ...(group ? { group } : {}),
      ...(q ? { q } : {}),
      ...(parent ? { parent } : {}),
      root: root !== undefined,
      offset,
      limit,
    });
    return page ?? reply.code(404).send({ error: 'version not found' });
  });

  app.get('/ontologies/:id/versions/:version/term', {
    schema: {
      ...base('getOntologyTerm', 'Describe one ontology term', md`
        A term with its neighbours in this version: parents and children, the classes a
        property's domain and range name, the properties whose domain or range is this class,
        a scheme's concepts and the SHACL shapes targeting it (each list at most 200).`),
      params: TermParams,
      querystring: TermDetailQuery,
      response: {
        200: res('The term.', TermDetailSchema),
        400: error('`iri` is missing.'),
        404: error('No such version or term.'),
      },
    },
  }, async (req, reply) => {
    const params = TermParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'version not found' });
    const query = TermDetailQuery.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: 'iri is required' });
    const term = await app.deps.ontologies.term(params.data.id, params.data.version, query.data.iri);
    return term ?? reply.code(404).send({ error: 'term not found' });
  });
```

Add `TermQuerySchema`, `TermPageSchema` and `TermDetailSchema` to the `@ih/shared` import.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run apps/api/test/ontologies.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts`,
then `npm run openapi` for the snapshot.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/openapi.json
git commit -m "API: ontology term search, tree children and detail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web client, routes and nav

**Files:**
- Modify:
  - `apps/web/src/api/client.ts` (7 methods + `ontologySourceUrl`)
  - `apps/web/test/fake-api.ts` (fakes and fixtures)
  - `apps/web/src/router.ts` and `apps/web/src/shell/derive.ts` (routes, section, title)
  - `apps/web/src/shell/AppShell.tsx` (nav)
  - `apps/web/src/ui/Icon.tsx` (the `graph` icon)
  - `apps/web/src/App.tsx` (dispatch; pages arrive in Tasks 8 and 9, so dispatch a
    placeholder `<p>` until then and replace it in Task 8)
- Test: `apps/web/test/router.test.ts` (extend), `apps/web/test/client.test.ts` (extend)

**Interfaces:**
- Produces these `Api` methods:
  - `listOntologies(opts?: { retired?: boolean }): Promise<OntologySummary[]>`
  - `getOntology(id: string): Promise<OntologyDetail>`
  - `importOntology(file: File, fields: OntologyImportFields): Promise<OntologyVersionView>`
  - `updateOntology(id: string, patch: OntologyPatch): Promise<OntologySummary>`
  - `deleteOntologyVersion(id: string, version: number): Promise<void>`
  - `listOntologyTerms(id: string, version: number, query: OntologyTermQuery): Promise<TermPage>`
  - `getOntologyTerm(id: string, version: number, iri: string): Promise<TermDetail>`
- Also produces:
  - the exported types `OntologyImportFields = { id: string; label?: string; description?: string; tags?: string[]; localOnly?: boolean }`
    and `OntologyTermQuery = { group?: TermGroup; q?: string; parent?: string; root?: boolean; offset?: number; limit?: number }`
  - `ontologySourceUrl(id, version): string`
  - the routes `{ name: 'ontologies' }` and `{ name: 'ontology'; ontologyId: string }`
  - the fixture builders in `fake-api.ts`: `ontologySummary(o?)`, `ontologyVersion(o?)`,
    `ontologyTerm(o?)`, `termDetail(o?)`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/router.test.ts`'s `it.each` table:

```ts
    ['#/ontologies', { name: 'ontologies' }],
    ['#/ontologies/idmp-o', { name: 'ontology', ontologyId: 'idmp-o' }],
```

Add to `apps/web/test/client.test.ts`. Follow the existing pattern there for stubbing
`fetch`; the test for `importBundle` field order is the model.

```ts
  it('sends ontology fields before the file', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ ontologyId: 'pv', version: 1 }), { status: 202 });
    }));
    const file = new File(['x'], 'pv.ttl');
    await createHttpApi('/api').importOntology(file, { id: 'pv', label: 'PV', tags: ['a', 'b'], localOnly: true });
    const form = calls[0]!.body as FormData;
    expect([...form.keys()]).toEqual(['id', 'label', 'tags', 'localOnly', 'file']);
    expect(form.get('tags')).toBe('a,b');
  });

  it('builds term queries', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ items: [], total: 0, offset: 0, limit: 100 }));
    }));
    await createHttpApi('/api').listOntologyTerms('pv', 2, { group: 'classes', root: true });
    expect(urls[0]).toBe('/api/ontologies/pv/versions/2/terms?group=classes&root=1');
  });
```

If `client.test.ts` restores globals in an `afterEach`, keep that. If it does not, add
`afterEach(() => vi.unstubAllGlobals())` to this block.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/router.test.ts apps/web/test/client.test.ts`
Expected: FAIL. The new routes parse as `home`, and the client methods are undefined.

- [ ] **Step 3: Implement**

`router.ts`:
- Add the two variants to `Route`.
- In `parseHash`, before the exact comparisons, add:

```ts
  const ontology = /^#\/ontologies\/([^/]+)$/.exec(hash);
  if (ontology) return { name: 'ontology', ontologyId: decodeURIComponent(ontology[1]!) };
```

  and `if (hash === '#/ontologies') return { name: 'ontologies' };`.
- Add `#/ontologies, #/ontologies/<id>` to the doc comment.

`shell/derive.ts`:
- Add `'ontologies'` to `Section`.
- In `SECTION`, add `ontologies: 'ontologies', ontology: 'ontologies'`.
- In `PAGE`, add `ontologies: 'Ontologies', ontology: 'Ontologies'`.

`ui/Icon.tsx`: add the `graph` icon to `PATHS`.

```tsx
  graph: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.4 6.4l7.1 1.2M6.9 8.4l1.5 7.2M16.5 10.1l-5.9 6" />
    </>
  ),
```

`shell/AppShell.tsx`: add this after the Document types link.

```tsx
          <NavLink
            href="#/ontologies"
            icon="graph"
            label="Ontologies"
            current={section === 'ontologies'}
            compact={compact}
          />
```

`api/client.ts`:
- Import the ontology types from `@ih/shared`.
- Export `OntologyImportFields` and `OntologyTermQuery`.
- Add the 7 signatures to `interface Api`, each with a short `/** … */`.
- Add these implementations in `createHttpApi`:

```ts
    listOntologies: (opts = {}) =>
      apiFetch(`${base}/ontologies${opts.retired ? '?retired=include' : ''}`).then(json<OntologySummary[]>),
    getOntology: (id) => apiFetch(`${base}/ontologies/${encodeURIComponent(id)}`).then(json<OntologyDetail>),
    importOntology: (file, fields) => {
      const form = new FormData();
      // Fields precede the file part: the API reads them from the file's preamble.
      form.append('id', fields.id);
      if (fields.label) form.append('label', fields.label);
      if (fields.description) form.append('description', fields.description);
      if (fields.tags?.length) form.append('tags', fields.tags.join(','));
      if (fields.localOnly) form.append('localOnly', 'true');
      form.append('file', file);
      return apiFetch(`${base}/ontologies`, { method: 'POST', body: form }).then(json<OntologyVersionView>);
    },
    updateOntology: (id, patch) =>
      post<OntologySummary>(`${base}/ontologies/${encodeURIComponent(id)}`, patch, 'PATCH'),
    deleteOntologyVersion: (id, version) =>
      noContent(apiFetch(`${base}/ontologies/${encodeURIComponent(id)}/versions/${version}`, { method: 'DELETE' })),
    listOntologyTerms: (id, version, query) => {
      const params = new URLSearchParams();
      if (query.group) params.set('group', query.group);
      if (query.q) params.set('q', query.q);
      if (query.parent) params.set('parent', query.parent);
      if (query.root) params.set('root', '1');
      if (query.offset) params.set('offset', String(query.offset));
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.toString();
      return apiFetch(`${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/terms${qs ? `?${qs}` : ''}`).then(json<TermPage>);
    },
    getOntologyTerm: (id, version, iri) =>
      apiFetch(`${base}/ontologies/${encodeURIComponent(id)}/versions/${version}/term?iri=${encodeURIComponent(iri)}`).then(json<TermDetail>),
```

Then add, below `httpApi`:

```ts
/** The imported file of an ontology version (a plain link: the browser downloads it). */
export function ontologySourceUrl(id: string, version: number): string {
  return `/api/ontologies/${encodeURIComponent(id)}/versions/${version}/source`;
}
```

`test/fake-api.ts`:
- Add the fakes:
  - `listOntologies: vi.fn(async () => [])`
  - `listOntologyTerms: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 100 }))`
  - `getOntology`, `importOntology`, `updateOntology`, `deleteOntologyVersion` and
    `getOntologyTerm`: each throws `new Error('<name> not stubbed')`
- Add the fixtures:

```ts
export function ontologyVersion(o: Partial<OntologyVersionView> = {}): OntologyVersionView {
  return {
    ontologyId: 'pv', version: 1, status: 'ready', fileName: 'pv.ttl', mediaType: 'text/turtle',
    sha256: 'abc', bytes: 120, ontologyIri: 'https://example.org/pv', versionIri: null, license: null,
    kinds: ['owl'], stats: { triples: 40, classes: 3, properties: 2, concepts: 0, schemes: 0, shapes: 0 },
    imports: [], error: null, importedBy: 'Ken', importedAt: '2026-10-14T10:00:00.000Z', ...o,
  };
}
export function ontologySummary(o: Partial<OntologySummary> = {}): OntologySummary {
  return {
    id: 'pv', label: 'Process validation', description: '', tags: ['industry:pharma'], localOnly: false,
    retiredAt: null, createdBy: 'Ken', createdAt: '2026-10-14T10:00:00.000Z',
    latest: ontologyVersion(), versionCount: 1, ...o,
  };
}
export function ontologyTerm(o: Partial<OntologyTerm> = {}): OntologyTerm {
  return {
    iri: 'https://example.org/pv#Document', kind: 'class', label: 'Document', altLabels: [],
    definition: '', parents: [], domain: [], range: [], scheme: null, deprecated: false, childCount: 0, ...o,
  };
}
export function termDetail(o: Partial<TermDetail> = {}): TermDetail {
  return {
    ...ontologyTerm(), parentTerms: [], children: [], domainTerms: [], rangeTerms: [], schemeTerm: null,
    asDomain: [], asRange: [], concepts: [], shapes: [], ...o,
  };
}
```

`App.tsx`: add two branches to the dispatch:
- `route.name === 'ontologies'` renders `<p>Ontologies</p>`;
- `route.name === 'ontology'` renders `<p>{route.ontologyId}</p>`.

Task 8 replaces both.

- [ ] **Step 4: Run the tests to see them pass, then typecheck**

Run: `npx vitest run --project web apps/web/test/router.test.ts apps/web/test/client.test.ts && npm run typecheck`
Expected: PASS. The typecheck catches any missing fake method or route record entry.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: ontology API client, routes and nav

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web Ontologies page and import dialog

**Files:**
- Create: `apps/web/src/ontologies/derive.ts`, `apps/web/src/ontologies/OntologiesPage.tsx`, `apps/web/src/ontologies/ImportOntologyDialog.tsx`
- Modify: `apps/web/src/App.tsx` (render `OntologiesPage`), `apps/web/src/styles.css` (append an `/* Ontologies (ADR 0011) */` section)
- Test: `apps/web/test/ontology-derive.test.ts`, `apps/web/test/OntologiesPage.test.tsx`

**Interfaces:**
- Consumes: the `Api` methods and fixtures from Task 7; `Dialog`, `Icon` and `matchesQuery`.
- Produces from `derive.ts`:
  - `KIND_LABEL`, `GROUP_LABEL`, `TERM_KIND_LABEL`
  - `isImporting(status)`, `statsLine(stats)`, `versionStatusText(v)`, `groupCount(stats, group)`
  - `slugify(label)`, `splitTags(text)`
  - `type TreeRow`, `visibleRows(kids, open)`
- Produces the components `OntologiesPage({ api, role, pollMs? })` and
  `ImportOntologyDialog({ api, existing, onClose, onImported })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/ontology-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { slugify, splitTags, statsLine, versionStatusText, visibleRows } from '../src/ontologies/derive.js';
import { ontologyTerm, ontologyVersion } from './fake-api.js';

describe('ontology helpers', () => {
  it.each([
    [{ triples: 9, classes: 1, properties: 2, concepts: 0, schemes: 0, shapes: 0 }, '1 class · 2 properties'],
    [{ triples: 9, classes: 0, properties: 0, concepts: 5, schemes: 1, shapes: 3 }, '5 concepts · 1 scheme · 3 shapes'],
    [{ triples: 0, classes: 0, properties: 0, concepts: 0, schemes: 0, shapes: 0 }, 'No terms'],
  ])('statsLine %j', (stats, text) => {
    expect(statsLine(stats)).toBe(text);
  });

  it('describes each version status', () => {
    expect(versionStatusText(ontologyVersion({ status: 'queued' }))).toBe('Queued for import');
    expect(versionStatusText(ontologyVersion({ status: 'parsing' }))).toBe('Importing…');
    expect(versionStatusText(ontologyVersion({ status: 'failed', error: 'cannot read' }))).toBe('Import failed: cannot read');
    expect(versionStatusText(ontologyVersion())).toBe('3 classes · 2 properties');
  });

  it.each([
    ['IDMP-O Ontology', 'idmp-o-ontology'],
    ['  Acme  PV v2.1 ', 'acme-pv-v21'],
    ['Café_Ontologie', 'cafe-ontologie'],
  ])('slugify %s', (label, id) => {
    expect(slugify(label)).toBe(id);
  });

  it('splits tags', () => {
    expect(splitTags(' a, b ,,c')).toEqual(['a', 'b', 'c']);
  });

  it('flattens open nodes, stops at cycles and notes hidden children', () => {
    const a = ontologyTerm({ iri: 'A', label: 'A', childCount: 1 });
    const b = ontologyTerm({ iri: 'B', label: 'B', childCount: 1, parents: ['A'] });
    const kids = new Map([
      ['', { items: [a], total: 3 }],
      ['A', { items: [b], total: 1 }],
      ['B', { items: [a], total: 1 }], // A ⊂ B ⊂ A
    ]);
    const rows = visibleRows(kids, new Set(['/A', '/A/B', '/A/B/A']));
    expect(rows.map((r) => (r.kind === 'term' ? `${r.level}:${r.term.label}${r.cycle ? '↺' : ''}` : `more ${r.hidden}`))).toEqual([
      '1:A',
      '2:B',
      '3:A↺',
      'more 2',
    ]);
  });
});
```

`apps/web/test/OntologiesPage.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OntologiesPage } from '../src/ontologies/OntologiesPage.js';
import { fakeApi, ontologySummary, ontologyVersion } from './fake-api.js';

function page(list = [ontologySummary()], role: 'admin' | 'user' = 'admin', overrides = {}) {
  const api = fakeApi({ listOntologies: vi.fn(async () => list), ...overrides });
  render(<OntologiesPage api={api} role={role} pollMs={10} />);
  return api;
}

describe('OntologiesPage', () => {
  it('shows each ontology with its kinds, tags and newest version', async () => {
    page([
      ontologySummary({ localOnly: true }),
      ontologySummary({ id: 'stages', label: 'Process stages', tags: [], latest: ontologyVersion({ status: 'failed', error: 'cannot read stages.ttl as Turtle' }) }),
    ]);
    const pv = await screen.findByRole('region', { name: 'Ontology Process validation' });
    expect(within(pv).getByRole('link', { name: 'Process validation' })).toHaveAttribute('href', '#/ontologies/pv');
    expect(within(pv).getByText('OWL')).toBeInTheDocument();
    expect(within(pv).getByText('Local only')).toBeInTheDocument();
    expect(within(pv).getByText('industry:pharma')).toBeInTheDocument();
    expect(within(pv).getByText(/3 classes · 2 properties/)).toBeInTheDocument();
    const stages = screen.getByRole('region', { name: 'Ontology Process stages' });
    expect(within(stages).getByText(/Import failed: cannot read stages.ttl/)).toBeInTheDocument();
  });

  it('filters by the search box', async () => {
    page([ontologySummary(), ontologySummary({ id: 'stages', label: 'Process stages', tags: ['customer:acme'] })]);
    await screen.findByRole('region', { name: 'Ontology Process stages' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search ontologies' }), 'acme');
    expect(screen.queryByRole('region', { name: 'Ontology Process validation' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Ontology Process stages' })).toBeInTheDocument();
  });

  it('offers Import only to admins and explains an empty library', async () => {
    page([], 'user');
    expect(await screen.findByText(/No ontologies yet\. An admin imports them\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import ontology' })).not.toBeInTheDocument();
  });

  it('polls while a version is importing', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([ontologySummary({ latest: ontologyVersion({ status: 'parsing' }) })])
      .mockResolvedValue([ontologySummary()]);
    page(undefined, 'admin', { listOntologies: list });
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
    expect(await screen.findByText(/3 classes/)).toBeInTheDocument();
    const calls = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(list.mock.calls.length).toBe(calls); // stopped once ready
  });

  it('imports a new ontology, its id made from the name', async () => {
    const api = page([], 'admin', { importOntology: vi.fn(async () => ontologyVersion()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    const file = new File(['@prefix x: <y> .'], 'idmp.ttl', { type: 'text/turtle' });
    await userEvent.upload(within(dialog).getByLabelText('Ontology file'), file);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP O');
    expect(within(dialog).getByLabelText('Id')).toHaveValue('idmp-o');
    await userEvent.type(within(dialog).getByLabelText('Tags (comma-separated)'), 'industry:pharma');
    await userEvent.click(within(dialog).getByLabelText(/Local only/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntology).toHaveBeenCalledWith(file, { id: 'idmp-o', label: 'IDMP O', tags: ['industry:pharma'], localOnly: true }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('adds a version to an existing ontology and shows refusals', async () => {
    const api = page([ontologySummary()], 'admin', {
      importOntology: vi.fn(async () => { throw new Error('this file is already version 1 of pv'); }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'pv');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Adds version 2 of Process validation.');
    const file = new File(['x'], 'pv.ttl');
    await userEvent.upload(within(dialog).getByLabelText('Ontology file'), file);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already version 1 of pv');
    expect(api.importOntology).toHaveBeenCalledWith(file, { id: 'pv' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/ontology-derive.test.ts apps/web/test/OntologiesPage.test.tsx`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement**

`apps/web/src/ontologies/derive.ts`:

```ts
import type { OntologyStats, OntologyStatus, OntologyTerm, OntologyTermKind, OntologyVersionView, TermGroup } from '@ih/shared';

export const KIND_LABEL = { owl: 'OWL', skos: 'SKOS', shacl: 'SHACL' } as const;

export const GROUP_LABEL: Record<TermGroup, string> = {
  classes: 'Classes',
  properties: 'Properties',
  concepts: 'Concept schemes',
  shapes: 'Shapes',
};

export const TERM_KIND_LABEL: Record<OntologyTermKind, string> = {
  class: 'Class',
  object_property: 'Object property',
  datatype_property: 'Datatype property',
  annotation_property: 'Annotation property',
  concept: 'Concept',
  scheme: 'Concept scheme',
  shape: 'Shape',
};

export const isImporting = (status: OntologyStatus) => status === 'queued' || status === 'parsing';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function statsLine(stats: OntologyStats | null): string {
  if (!stats) return '';
  const parts = [
    stats.classes && plural(stats.classes, 'class', 'classes'),
    stats.properties && plural(stats.properties, 'property', 'properties'),
    stats.concepts && plural(stats.concepts, 'concept', 'concepts'),
    stats.schemes && plural(stats.schemes, 'scheme', 'schemes'),
    stats.shapes && plural(stats.shapes, 'shape', 'shapes'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No terms';
}

export function versionStatusText(v: OntologyVersionView): string {
  if (v.status === 'queued') return 'Queued for import';
  if (v.status === 'parsing') return 'Importing…';
  if (v.status === 'failed') return `Import failed: ${v.error ?? 'unknown error'}`;
  return statsLine(v.stats);
}

export function groupCount(stats: OntologyStats | null, group: TermGroup): number {
  if (!stats) return 0;
  if (group === 'classes') return stats.classes;
  if (group === 'properties') return stats.properties;
  if (group === 'concepts') return stats.concepts + stats.schemes;
  return stats.shapes;
}

/** An ontology id from its name (ONTOLOGY_ID_RE): lowercase ASCII words joined by dashes. */
export function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

export const splitTags = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

export interface LoadedChildren {
  items: OntologyTerm[];
  total: number;
}

export type TreeRow =
  | { kind: 'term'; term: OntologyTerm; level: number; path: string; cycle: boolean }
  | { kind: 'more'; level: number; path: string; hidden: number };

/**
 * The tree's visible rows: children loaded per parent IRI ('' = the roots), open nodes keyed by
 * path (the same term can appear under several parents). A term already among its ancestors is
 * shown once more, marked `cycle`, and never expanded.
 */
export function visibleRows(kids: ReadonlyMap<string, LoadedChildren>, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parent: string, level: number, path: string, ancestors: readonly string[]) => {
    const page = kids.get(parent);
    if (!page) return;
    for (const term of page.items) {
      const p = `${path}/${term.iri}`;
      const cycle = ancestors.includes(term.iri);
      rows.push({ kind: 'term', term, level, path: p, cycle });
      if (!cycle && open.has(p)) walk(term.iri, level + 1, p, [...ancestors, term.iri]);
    }
    if (page.total > page.items.length) {
      rows.push({ kind: 'more', level, path: `${path}/…`, hidden: page.total - page.items.length });
    }
  };
  walk('', 1, '', []);
  return rows;
}
```

Check the slugify cases against this code. `'  Acme  PV v2.1 '` becomes `acme-pv-v21` (the
`.` is dropped). `Café_Ontologie` becomes `cafe-ontologie`. If a case disagrees, fix the
code, not the test.

`apps/web/src/ontologies/OntologiesPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { OntologySummary, OntologyVersionView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';
import { Icon } from '../ui/Icon.js';
import { KIND_LABEL, isImporting, versionStatusText } from './derive.js';
import { ImportOntologyDialog } from './ImportOntologyDialog.js';

export function OntologiesPage({ api, role, pollMs = 2000 }: { api: Api; role: 'admin' | 'user'; pollMs?: number }) {
  const [items, setItems] = useState<OntologySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(
    () =>
      api.listOntologies().then(
        (list) => {
          setItems(list);
          setError(null);
        },
        (err: Error) => setError(err.message),
      ),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const busy = items?.some((o) => o.latest !== null && isImporting(o.latest.status)) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [busy, load, pollMs]);

  const shown = (items ?? []).filter((o) => matchesQuery(query, o.label, o.id, o.description, ...o.tags));
  return (
    <div className="ontologies-page">
      <div className="page-header">
        <div>
          <h1>Ontologies</h1>
          <p className="muted">Customer and industry ontologies that document types map their outputs to.</p>
        </div>
        {role === 'admin' && (
          <button type="button" className="primary" onClick={() => setImporting(true)}>
            <Icon name="upload" />
            Import ontology
          </button>
        )}
      </div>
      <label className="search">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search ontologies"
          placeholder="Search ontologies"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items?.length === 0 && (
        <p className="muted">
          No ontologies yet.{role === 'admin' ? ' Import one to start.' : ' An admin imports them.'}
        </p>
      )}
      <div className="type-grid">
        {shown.map((o) => (
          <OntologyCard key={o.id} ontology={o} />
        ))}
      </div>
      {importing && (
        <ImportOntologyDialog
          api={api}
          existing={items ?? []}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function OntologyCard({ ontology: o }: { ontology: OntologySummary }) {
  return (
    <section className="ontology-card" aria-label={`Ontology ${o.label}`}>
      <header className="ontology-card-head">
        <h2>
          <a href={`#/ontologies/${encodeURIComponent(o.id)}`}>{o.label}</a>
        </h2>
        <span className="mono muted">{o.id}</span>
      </header>
      {o.description && <p className="muted">{o.description}</p>}
      <div className="pills">
        {o.latest?.kinds.map((k) => (
          <span key={k} className="tag tone-info">
            {KIND_LABEL[k]}
          </span>
        ))}
        {o.localOnly && <span className="tag tone-warn">Local only</span>}
        {o.retiredAt && <span className="tag tone-neutral">Retired</span>}
        {o.tags.map((t) => (
          <span key={t} className="tag tone-neutral">
            {t}
          </span>
        ))}
      </div>
      <VersionLine version={o.latest} count={o.versionCount} />
    </section>
  );
}

export function VersionLine({ version, count }: { version: OntologyVersionView | null; count: number }) {
  if (!version) return <p className="muted">No versions</p>;
  const tone = version.status === 'failed' ? 'alert' : isImporting(version.status) ? 'info' : 'ok';
  return (
    <p className="ontology-version">
      <span className={`pill tone-${tone}`}>v{version.version}</span> {versionStatusText(version)}
      {count > 1 && <span className="muted"> · {count} versions</span>}
    </p>
  );
}
```

`apps/web/src/ontologies/ImportOntologyDialog.tsx`:

```tsx
import { useId, useState, type FormEvent } from 'react';
import { ONTOLOGY_ACCEPT, ONTOLOGY_ID_RE, type OntologySummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { slugify, splitTags } from './derive.js';

export function ImportOntologyDialog({
  api,
  existing,
  onClose,
  onImported,
}: {
  api: Api;
  existing: readonly OntologySummary[];
  onClose: () => void;
  onImported: () => void;
}) {
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [tags, setTags] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = id.trim();
  const match = existing.find((o) => o.id === trimmed);
  const ready = file !== null && ONTOLOGY_ID_RE.test(trimmed) && (match !== undefined || label.trim() !== '');

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!file || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.importOntology(
        file,
        match ? { id: trimmed } : { id: trimmed, label: label.trim(), tags: splitTags(tags), localOnly },
      );
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Import ontology"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !ready}>
          Import
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(ev) => void submit(ev)}>
        <label>
          Ontology file
          <input type="file" accept={ONTOLOGY_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <p className="muted">Turtle, RDF/XML, JSON-LD, N-Triples or N3 ({ONTOLOGY_ACCEPT}).</p>
        <label>
          Name
          <input
            value={match ? match.label : label}
            disabled={match !== undefined}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!idEdited) setId(slugify(e.target.value));
            }}
          />
        </label>
        <label>
          Id
          <input
            className="mono"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setIdEdited(true);
            }}
          />
        </label>
        {match ? (
          <p className="muted" role="status">
            Adds version {match.versionCount + 1} of {match.label}.
          </p>
        ) : (
          <>
            <label>
              Tags (comma-separated)
              <input value={tags} placeholder="industry:pharma, customer:acme" onChange={(e) => setTags(e.target.value)} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />
              Local only: never sent to external models
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
```

Check the `Dialog` test name: the dialog must be findable as
`getByRole('dialog', { name: 'Import ontology' })`. If `Dialog` does not set `aria-labelledby`
to its title, query with `getByRole('dialog')` instead, and note that the primitive has no
accessible name. Use whatever class name checkbox labels already have in `styles.css`; if
there is none, add `.checkbox { display: flex; gap: 8px; align-items: center; }` in the
Ontologies CSS section.

`App.tsx`: replace the Task 7 placeholder for `ontologies` with
`<OntologiesPage api={api} role={me.role} />`.

`styles.css`: append this section.

```css
/* Ontologies (ADR 0011) */
.ontologies-page { display: flex; flex-direction: column; gap: var(--ih-space-4); }
.ontology-card {
  padding: 16px 20px; border: 1px solid var(--ih-border); border-radius: var(--ih-radius-lg);
  background: var(--ih-surface); display: flex; flex-direction: column; gap: 10px; min-width: 0;
}
.ontology-card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ontology-card-head h2 { margin: 0; font-size: var(--ih-text-lg); }
.ontology-version { margin: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project web apps/web/test/ontology-derive.test.ts apps/web/test/OntologiesPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: Ontologies page and import dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web ontology view (tree, detail, edit, delete)

**Files:**
- Create: `apps/web/src/ontologies/OntologyPage.tsx`, `EditOntologyDialog.tsx`, `TermBrowser.tsx`, `TermTree.tsx`, `TermDetailPanel.tsx`
- Modify: `apps/web/src/App.tsx` (render `OntologyPage` keyed by id), `apps/web/src/styles.css`
- Test: `apps/web/test/OntologyPage.test.tsx`

**Interfaces:**
- Consumes:
  - `derive.ts` (Task 8): `visibleRows`, `groupCount`, `GROUP_LABEL`, `TERM_KIND_LABEL`,
    `KIND_LABEL`, `isImporting`, `versionStatusText`
  - the `Api` from Task 7 and `ontologySourceUrl`
  - `VersionLine` from `OntologiesPage.tsx`
- Produces:
  - `OntologyPage({ api, role, ontologyId, pollMs?, searchDelayMs? })`
  - `TermBrowser({ api, ontologyId, version, stats, searchDelayMs })`
  - `TermTree({ api, ontologyId, version, group, selected, onSelect })`
  - `TermDetailPanel({ api, ontologyId, version, iri, onSelect })`
  - `EditOntologyDialog({ api, ontology, onClose, onSaved })`

- [ ] **Step 1: Write the failing tests** `apps/web/test/OntologyPage.test.tsx`

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TermPage } from '@ih/shared';
import { OntologyPage } from '../src/ontologies/OntologyPage.js';
import { fakeApi, ontologySummary, ontologyTerm, ontologyVersion, termDetail } from './fake-api.js';

const C = 'https://example.org/pv#';
const page = (items = [ontologyTerm()]): TermPage => ({ items, total: items.length, offset: 0, limit: 100 });
const detail = (o = {}) => ({ ...ontologySummary(), versions: [ontologyVersion()], ...o });

function view(role: 'admin' | 'user' = 'user', overrides = {}) {
  const api = fakeApi({
    getOntology: vi.fn(async () => detail()),
    listOntologyTerms: vi.fn(async (_id: string, _v: number, q: { parent?: string; q?: string }) =>
      q.q
        ? page([ontologyTerm({ iri: `${C}Protocol`, label: 'Protocol' })])
        : q.parent
          ? page([ontologyTerm({ iri: `${C}Protocol`, label: 'Protocol', parents: [`${C}Document`] })])
          : page([ontologyTerm({ childCount: 1 })]),
    ),
    getOntologyTerm: vi.fn(async (_id: string, _v: number, iri: string) =>
      iri.endsWith('Protocol')
        ? termDetail({ iri, label: 'Protocol', parents: [`${C}Document`, 'https://other.org/Thing'], parentTerms: [{ iri: `${C}Document`, kind: 'class', label: 'Document' }] })
        : termDetail({ definition: 'Anything written down.', children: [{ iri: `${C}Protocol`, kind: 'class', label: 'Protocol' }] }),
    ),
    ...overrides,
  });
  render(<OntologyPage api={api} role={role} ontologyId="pv" pollMs={10} searchDelayMs={0} />);
  return api;
}

describe('OntologyPage', () => {
  it('shows the ontology, its version and a download link', async () => {
    view();
    expect(await screen.findByRole('heading', { level: 1, name: 'Process validation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download pv\.ttl/ })).toHaveAttribute('href', '/api/ontologies/pv/versions/1/source');
    expect(screen.getByText('https://example.org/pv')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  it('lazily expands the class tree and shows a term', async () => {
    const api = view();
    const tree = await screen.findByRole('tree', { name: 'Classes hierarchy' });
    expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, { group: 'classes', root: true, limit: 500 });
    await userEvent.click(within(tree).getByRole('button', { name: 'Expand Document' }));
    await within(tree).findByRole('treeitem', { name: /Protocol/ });
    expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, { group: 'classes', parent: `${C}Document`, limit: 500 });
    await userEvent.click(within(tree).getByRole('treeitem', { name: /Protocol/ }));
    const panel = await screen.findByRole('region', { name: 'Term details' });
    expect(await within(panel).findByRole('heading', { name: 'Protocol' })).toBeInTheDocument();
    // An outside parent shows as its IRI; a known one can be followed.
    expect(within(panel).getByText('https://other.org/Thing')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Document' }));
    expect(await within(panel).findByText('Anything written down.')).toBeInTheDocument();
  });

  it('moves through the tree with the keyboard', async () => {
    view();
    const tree = await screen.findByRole('tree', { name: 'Classes hierarchy' });
    const document = await within(tree).findByRole('treeitem', { name: /Document/ });
    document.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(await within(tree).findByRole('treeitem', { name: /Protocol/ })).toBeInTheDocument();
    expect(document).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('heading', { name: 'Protocol' })).toBeInTheDocument();
  });

  it('searches terms instead of the tree', async () => {
    const api = view();
    await screen.findByRole('tree');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search terms' }), 'proto');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(within(results).getByRole('button', { name: /Protocol/ })).toBeInTheDocument();
    await waitFor(() => expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, { group: 'classes', q: 'proto', limit: 100 }));
  });

  it('switches tabs by term kind with counts', async () => {
    const api = view();
    await screen.findByRole('tree');
    const kinds = screen.getByRole('group', { name: 'Term kinds' });
    await userEvent.click(within(kinds).getByRole('button', { name: 'Properties (2)' }));
    await screen.findByRole('tree', { name: 'Properties hierarchy' });
    expect(api.listOntologyTerms).toHaveBeenCalledWith('pv', 1, { group: 'properties', root: true, limit: 500 });
  });

  it('says a version is importing or failed instead of browsing it', async () => {
    view('user', {
      getOntology: vi.fn(async () => detail({ versions: [ontologyVersion({ status: 'failed', error: 'cannot read pv.ttl as Turtle' })] })),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Import failed: cannot read pv.ttl as Turtle');
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it('lists imports it could not resolve', async () => {
    view('user', {
      getOntology: vi.fn(async () => detail({ versions: [ontologyVersion({ imports: [{ iri: 'https://example.org/base', resolution: 'unresolved' }] })] })),
    });
    expect(await screen.findByText('1 imported ontology is not in the library')).toBeInTheDocument();
  });

  it('lets admins edit and delete a version', async () => {
    const api = view('admin', {
      updateOntology: vi.fn(async () => ontologySummary({ label: 'PV' })),
      deleteOntologyVersion: vi.fn(async () => undefined),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
    const edit = screen.getByRole('dialog', { name: 'Edit ontology' });
    await userEvent.clear(within(edit).getByLabelText('Name'));
    await userEvent.type(within(edit).getByLabelText('Name'), 'PV');
    await userEvent.click(within(edit).getByLabelText('Retired'));
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateOntology).toHaveBeenCalledWith('pv', { label: 'PV', description: '', tags: ['industry:pharma'], localOnly: false, retired: true }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete version…' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete version 1' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete version' }));
    await waitFor(() => expect(api.deleteOntologyVersion).toHaveBeenCalledWith('pv', 1));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/OntologyPage.test.tsx`
Expected: FAIL, because `OntologyPage` does not exist.

- [ ] **Step 3: Implement**

`apps/web/src/ontologies/TermTree.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TermGroup } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { GROUP_LABEL, visibleRows, type LoadedChildren, type TreeRow } from './derive.js';

/** Children loaded per node: past this, the tree says how many more and search finds them. */
export const TREE_LIMIT = 500;

export function TermTree({
  api,
  ontologyId,
  version,
  group,
  selected,
  onSelect,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  group: TermGroup;
  selected: string | null;
  onSelect: (iri: string) => void;
}) {
  const [kids, setKids] = useState<Map<string, LoadedChildren>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const items = useRef<(HTMLLIElement | null)[]>([]);

  const fetchChildren = useCallback(
    async (parent: string) => {
      const page = await api.listOntologyTerms(
        ontologyId,
        version,
        parent ? { group, parent, limit: TREE_LIMIT } : { group, root: true, limit: TREE_LIMIT },
      );
      setKids((m) => new Map(m).set(parent, { items: page.items, total: page.total }));
    },
    [api, ontologyId, version, group],
  );

  useEffect(() => {
    setKids(new Map());
    setOpen(new Set());
    setFocus(0);
    setError(null);
    fetchChildren('').catch((err: Error) => setError(err.message));
  }, [fetchChildren]);

  const rows = visibleRows(kids, open);
  const expandable = (r: TreeRow) => r.kind === 'term' && r.term.childCount > 0 && !r.cycle;

  const toggle = (r: Extract<TreeRow, { kind: 'term' }>) => {
    const next = new Set(open);
    if (next.has(r.path)) next.delete(r.path);
    else {
      next.add(r.path);
      if (!kids.has(r.term.iri)) fetchChildren(r.term.iri).catch((err: Error) => setError(err.message));
    }
    setOpen(next);
  };

  const move = (i: number) => {
    const target = Math.max(0, Math.min(rows.length - 1, i));
    setFocus(target);
    items.current[target]?.focus();
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLUListElement>) => {
    const row = rows[focus];
    if (!row) return;
    if (ev.key === 'ArrowDown') move(focus + 1);
    else if (ev.key === 'ArrowUp') move(focus - 1);
    else if (ev.key === 'ArrowRight' && row.kind === 'term' && expandable(row) && !open.has(row.path)) toggle(row);
    else if (ev.key === 'ArrowLeft' && row.kind === 'term') {
      if (open.has(row.path)) toggle(row);
      else {
        const parentPath = row.path.slice(0, row.path.lastIndexOf('/'));
        const parent = rows.findIndex((r) => r.path === parentPath);
        if (parent >= 0) move(parent);
      }
    } else if ((ev.key === 'Enter' || ev.key === ' ') && row.kind === 'term') onSelect(row.term.iri);
    else return;
    ev.preventDefault();
  };

  if (error) return <p role="alert">{error}</p>;
  if (!kids.has('')) return <p>Loading…</p>;
  if (rows.length === 0) return <p className="muted">No {GROUP_LABEL[group].toLowerCase()} in this version.</p>;
  return (
    <ul role="tree" aria-label={`${GROUP_LABEL[group]} hierarchy`} className="term-tree" onKeyDown={onKeyDown}>
      {rows.map((r, i) =>
        r.kind === 'more' ? (
          <li key={r.path} className="tree-more muted" style={{ paddingLeft: `${(r.level - 1) * 16 + 24}px` }}>
            and {r.hidden} more: search to find them
          </li>
        ) : (
          <li
            key={r.path}
            ref={(el) => {
              items.current[i] = el;
            }}
            role="treeitem"
            aria-level={r.level}
            aria-expanded={expandable(r) ? open.has(r.path) : undefined}
            aria-selected={selected === r.term.iri}
            tabIndex={i === focus ? 0 : -1}
            className={selected === r.term.iri ? 'tree-row selected' : 'tree-row'}
            style={{ paddingLeft: `${(r.level - 1) * 16}px` }}
            onClick={() => {
              setFocus(i);
              onSelect(r.term.iri);
            }}
          >
            {expandable(r) ? (
              <button
                type="button"
                className="icon tree-toggle"
                tabIndex={-1}
                aria-label={`${open.has(r.path) ? 'Collapse' : 'Expand'} ${r.term.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r);
                }}
              >
                <Icon name={open.has(r.path) ? 'chevronDown' : 'chevronRight'} size={14} />
              </button>
            ) : (
              <span className="tree-leaf" aria-hidden="true" />
            )}
            <span className="term-label">{r.term.label}</span>
            {r.cycle && <span className="muted"> (cycle)</span>}
            {r.term.deprecated && <span className="tag tone-neutral">deprecated</span>}
          </li>
        ),
      )}
    </ul>
  );
}
```

`apps/web/src/ontologies/TermDetailPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { TermDetail, TermRef } from '@ih/shared';
import type { Api } from '../api/client.js';
import { TERM_KIND_LABEL } from './derive.js';

export function TermDetailPanel({
  api,
  ontologyId,
  version,
  iri,
  onSelect,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  iri: string;
  onSelect: (iri: string) => void;
}) {
  const [term, setTerm] = useState<TermDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setTerm(null);
    setError(null);
    api.getOntologyTerm(ontologyId, version, iri).then(
      (t) => live && setTerm(t),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api, ontologyId, version, iri]);

  return (
    <section className="term-detail" aria-label="Term details">
      {error && <p role="alert">{error}</p>}
      {!term && !error && <p>Loading…</p>}
      {term && (
        <>
          <header className="term-detail-head">
            <h2>{term.label}</h2>
            <span className="tag tone-info">{TERM_KIND_LABEL[term.kind]}</span>
            {term.deprecated && <span className="tag tone-neutral">Deprecated</span>}
          </header>
          <p className="mono term-iri">{term.iri}</p>
          {term.definition && <p>{term.definition}</p>}
          {term.altLabels.length > 0 && <p className="muted">Also called: {term.altLabels.join(', ')}</p>}
          <Refs title="Parents" refs={term.parentTerms} outside={term.parents} onSelect={onSelect} />
          <Refs title="Children" refs={term.children} onSelect={onSelect} />
          {term.schemeTerm && <Refs title="Scheme" refs={[term.schemeTerm]} onSelect={onSelect} />}
          <Refs title="Domain" refs={term.domainTerms} outside={term.domain} onSelect={onSelect} />
          <Refs title="Range" refs={term.rangeTerms} outside={term.range} onSelect={onSelect} />
          <Refs title="Properties with this domain" refs={term.asDomain} onSelect={onSelect} />
          <Refs title="Properties with this range" refs={term.asRange} onSelect={onSelect} />
          <Refs title="Concepts" refs={term.concepts} onSelect={onSelect} />
          <Refs title="Shapes targeting it" refs={term.shapes} onSelect={onSelect} />
        </>
      )}
    </section>
  );
}

/** Terms of this version as buttons; IRIs outside it (imports, XSD) as plain text. */
function Refs({
  title,
  refs,
  outside = [],
  onSelect,
}: {
  title: string;
  refs: readonly TermRef[];
  outside?: readonly string[];
  onSelect: (iri: string) => void;
}) {
  const known = new Set(refs.map((r) => r.iri));
  const external = outside.filter((i) => !known.has(i));
  if (refs.length === 0 && external.length === 0) return null;
  return (
    <div className="term-refs">
      <h3>{title}</h3>
      <ul>
        {refs.map((r) => (
          <li key={r.iri}>
            <button type="button" className="link" onClick={() => onSelect(r.iri)}>
              {r.label}
            </button>
          </li>
        ))}
        {external.map((i) => (
          <li key={i} className="mono muted">
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`apps/web/src/ontologies/TermBrowser.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { OntologyStats, TermGroup, TermPage } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { GROUP_LABEL, groupCount } from './derive.js';
import { TermDetailPanel } from './TermDetailPanel.js';
import { TermTree } from './TermTree.js';

const GROUPS: TermGroup[] = ['classes', 'properties', 'concepts', 'shapes'];
export const SEARCH_LIMIT = 100;

export function TermBrowser({
  api,
  ontologyId,
  version,
  stats,
  searchDelayMs,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  stats: OntologyStats | null;
  searchDelayMs: number;
}) {
  const [group, setGroup] = useState<TermGroup>(() => GROUPS.find((g) => groupCount(stats, g) > 0) ?? 'classes');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="term-browser">
      <div className="term-browser-bar">
        <Segmented
          label="Term kinds"
          options={GROUPS.map((g) => ({ value: g, label: `${GROUP_LABEL[g]} (${groupCount(stats, g)})` }))}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setSelected(null);
          }}
        />
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search terms"
            placeholder="Search terms"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="term-panes">
        <div className="term-list">
          {query.trim() ? (
            <TermResults
              api={api}
              ontologyId={ontologyId}
              version={version}
              group={group}
              query={query.trim()}
              delayMs={searchDelayMs}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <TermTree api={api} ontologyId={ontologyId} version={version} group={group} selected={selected} onSelect={setSelected} />
          )}
        </div>
        <div className="term-detail-pane">
          {selected ? (
            <TermDetailPanel api={api} ontologyId={ontologyId} version={version} iri={selected} onSelect={setSelected} />
          ) : (
            <p className="muted">Pick a term to see its definition and neighbours.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TermResults({
  api,
  ontologyId,
  version,
  group,
  query,
  delayMs,
  selected,
  onSelect,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  group: TermGroup;
  query: string;
  delayMs: number;
  selected: string | null;
  onSelect: (iri: string) => void;
}) {
  const [page, setPage] = useState<TermPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.listOntologyTerms(ontologyId, version, { group, q: query, limit: SEARCH_LIMIT }).then(
        (p) => live && (setPage(p), setError(null)),
        (err: Error) => live && setError(err.message),
      );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, ontologyId, version, group, query, delayMs]);
  if (error) return <p role="alert">{error}</p>;
  if (!page) return <p>Searching…</p>;
  if (page.items.length === 0) return <p className="muted">No matching terms.</p>;
  return (
    <>
      <ul className="term-results" aria-label="Search results">
        {page.items.map((t) => (
          <li key={`${t.kind}:${t.iri}`}>
            <button type="button" aria-pressed={selected === t.iri} onClick={() => onSelect(t.iri)}>
              {t.label}
              {t.deprecated && <span className="tag tone-neutral">deprecated</span>}
            </button>
          </li>
        ))}
      </ul>
      {page.total > page.items.length && (
        <p className="muted">
          Showing the first {page.items.length} of {page.total}.
        </p>
      )}
    </>
  );
}
```

`apps/web/src/ontologies/EditOntologyDialog.tsx`:

```tsx
import { useId, useState, type FormEvent } from 'react';
import type { OntologySummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { splitTags } from './derive.js';

export function EditOntologyDialog({
  api,
  ontology,
  onClose,
  onSaved,
}: {
  api: Api;
  ontology: OntologySummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const [label, setLabel] = useState(ontology.label);
  const [description, setDescription] = useState(ontology.description);
  const [tags, setTags] = useState(ontology.tags.join(', '));
  const [localOnly, setLocalOnly] = useState(ontology.localOnly);
  const [retired, setRetired] = useState(ontology.retiredAt !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateOntology(ontology.id, { label: label.trim(), description, tags: splitTags(tags), localOnly, retired });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Edit ontology"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !label.trim()}>
          Save
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(ev) => void submit(ev)}>
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Description
          <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Tags (comma-separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />
          Local only: never sent to external models
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} />
          Retired
        </label>
        <p className="muted">A retired ontology is hidden from the library; anything that uses it keeps working.</p>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
```

The test expects `updateOntology` to be called with `description: ''` and
`tags: ['industry:pharma']`. These come from the `ontologySummary()` fixture.

`apps/web/src/ontologies/OntologyPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { OntologyDetail } from '@ih/shared';
import { ontologySourceUrl, type Api } from '../api/client.js';
import { navigate } from '../router.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { KIND_LABEL, isImporting, versionStatusText } from './derive.js';
import { EditOntologyDialog } from './EditOntologyDialog.js';
import { VersionLine } from './OntologiesPage.js';
import { TermBrowser } from './TermBrowser.js';

export function OntologyPage({
  api,
  role,
  ontologyId,
  pollMs = 2000,
  searchDelayMs = 250,
}: {
  api: Api;
  role: 'admin' | 'user';
  ontologyId: string;
  pollMs?: number;
  searchDelayMs?: number;
}) {
  const [detail, setDetail] = useState<OntologyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.getOntology(ontologyId).then(
        (d) => {
          setDetail(d);
          setError(null);
          setVersion((v) =>
            v !== null && d.versions.some((x) => x.version === v)
              ? v
              : (d.versions.find((x) => x.status === 'ready')?.version ?? d.versions[0]?.version ?? null),
          );
        },
        (err: Error) => setError(err.message),
      ),
    [api, ontologyId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const current = detail?.versions.find((v) => v.version === version) ?? null;
  const importing = current !== null && isImporting(current.status);
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [importing, load, pollMs]);

  const remove = async () => {
    if (!detail || !current) return;
    setDeleteError(null);
    try {
      await api.deleteOntologyVersion(detail.id, current.version);
      setDeleting(false);
      if (detail.versions.length === 1) navigate('#/ontologies');
      else {
        setVersion(null);
        await load();
      }
    } catch (err) {
      setDeleteError((err as Error).message);
    }
  };

  return (
    <div className="ontology-page">
      <a className="back-link" href="#/ontologies">
        <Icon name="back" />
        Ontologies
      </a>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p>Loading…</p>}
      {detail && (
        <>
          <div className="page-header">
            <div>
              <h1>{detail.label}</h1>
              <p className="mono muted">{detail.id}</p>
            </div>
            <div className="header-actions">
              {detail.versions.length > 1 && (
                <select aria-label="Version" value={version ?? ''} onChange={(e) => setVersion(Number(e.target.value))}>
                  {detail.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} · {v.status}
                    </option>
                  ))}
                </select>
              )}
              {current && (
                <a className="button" href={ontologySourceUrl(detail.id, current.version)}>
                  <Icon name="download" />
                  Download {current.fileName}
                </a>
              )}
              {role === 'admin' && (
                <>
                  <button type="button" onClick={() => setEditing(true)}>
                    <Icon name="pencil" />
                    Edit…
                  </button>
                  {current && !importing && (
                    <button type="button" className="danger" onClick={() => setDeleting(true)}>
                      <Icon name="trash" />
                      Delete version…
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {detail.description && <p>{detail.description}</p>}
          <div className="pills">
            {current?.kinds.map((k) => (
              <span key={k} className="tag tone-info">
                {KIND_LABEL[k]}
              </span>
            ))}
            {detail.localOnly && <span className="tag tone-warn">Local only</span>}
            {detail.retiredAt && <span className="tag tone-neutral">Retired</span>}
            {detail.tags.map((t) => (
              <span key={t} className="tag tone-neutral">
                {t}
              </span>
            ))}
          </div>
          {current && (
            <>
              <VersionLine version={current} count={detail.versions.length} />
              {importing && <p role="status">{versionStatusText(current)}</p>}
              {current.status === 'failed' && <p role="alert">{versionStatusText(current)}</p>}
              {current.imports.length > 0 && (
                <details className="ontology-imports">
                  <summary>
                    {current.imports.length === 1
                      ? '1 imported ontology is not in the library'
                      : `${current.imports.length} imported ontologies are not in the library`}
                  </summary>
                  <ul>
                    {current.imports.map((i) => (
                      <li key={i.iri} className="mono">
                        {i.iri}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <dl className="meta ontology-meta">
                {current.ontologyIri && (
                  <>
                    <dt>Ontology IRI</dt>
                    <dd className="mono">{current.ontologyIri}</dd>
                  </>
                )}
                {current.versionIri && (
                  <>
                    <dt>Version IRI</dt>
                    <dd className="mono">{current.versionIri}</dd>
                  </>
                )}
                {current.license && (
                  <>
                    <dt>Licence</dt>
                    <dd className="mono">{current.license}</dd>
                  </>
                )}
                <dt>Imported</dt>
                <dd>
                  {new Date(current.importedAt).toLocaleString()}
                  {current.importedBy ? ` by ${current.importedBy}` : ''}
                </dd>
              </dl>
              {current.status === 'ready' && (
                <TermBrowser
                  key={current.version}
                  api={api}
                  ontologyId={detail.id}
                  version={current.version}
                  stats={current.stats}
                  searchDelayMs={searchDelayMs}
                />
              )}
            </>
          )}
          {editing && (
            <EditOntologyDialog
              api={api}
              ontology={detail}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                void load();
              }}
            />
          )}
          {deleting && current && (
            <Dialog
              title={`Delete version ${current.version}`}
              onClose={() => setDeleting(false)}
              actions={
                <button type="button" className="danger" onClick={() => void remove()}>
                  Delete version
                </button>
              }
            >
              <p>
                Deletes version {current.version} of {detail.label}, its terms and its file.
                {detail.versions.length === 1 ? ' It is the only version, so the ontology goes too.' : ''}
              </p>
              {deleteError && <p role="alert">{deleteError}</p>}
            </Dialog>
          )}
        </>
      )}
    </div>
  );
}
```

`App.tsx`: replace the Task 7 placeholder for `ontology` with
`<OntologyPage key={route.ontologyId} api={api} role={me.role} ontologyId={route.ontologyId} />`.

If `.back-link` or `a.button` classes do not exist in `styles.css`, use the classes the review
or result pages use for their back link and link-buttons. Search
`grep -n "back" apps/web/src/review/*.tsx` before adding new ones.

`styles.css`: append to the Ontologies section.

```css
.ontology-page { display: flex; flex-direction: column; gap: var(--ih-space-3); }
.ontology-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; }
.ontology-meta dd { margin: 0; overflow-wrap: anywhere; }
.term-browser { display: flex; flex-direction: column; gap: var(--ih-space-3); }
.term-browser-bar { display: flex; gap: var(--ih-space-3); flex-wrap: wrap; align-items: center; }
.term-panes { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: var(--ih-space-4); }
@media (max-width: 760px) { .term-panes { grid-template-columns: minmax(0, 1fr); } }
.term-list, .term-detail-pane {
  border: 1px solid var(--ih-border); border-radius: var(--ih-radius-lg); background: var(--ih-surface);
  padding: 8px; min-width: 0; max-height: 70vh; overflow: auto;
}
.term-tree, .term-results, .term-refs ul { list-style: none; margin: 0; padding: 0; }
.tree-row { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: var(--ih-radius-sm); cursor: pointer; }
.tree-row:hover { background: var(--ih-surface2); }
.tree-row.selected { background: var(--ih-sel-row); }
.tree-row:focus-visible { outline: 2px solid var(--ih-accent); outline-offset: -2px; }
.tree-toggle { width: 22px; height: 22px; }
.tree-leaf { display: inline-block; width: 22px; }
.tree-more { padding: 3px 6px; font-size: var(--ih-text-sm); }
.term-results button { width: 100%; text-align: left; display: flex; gap: 6px; align-items: center; }
.term-results button[aria-pressed='true'] { background: var(--ih-sel-row); }
.term-detail { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.term-detail-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.term-detail-head h2 { margin: 0; }
.term-iri { overflow-wrap: anywhere; margin: 0; }
.term-refs h3 { font-size: var(--ih-text-sm); margin: 8px 0 4px; color: var(--ih-muted); }
.term-refs li { overflow-wrap: anywhere; }
```

- [ ] **Step 4: Run the tests to see them pass, then the web suite and typecheck**

Run: `npx vitest run --project web apps/web/test/OntologyPage.test.tsx && npx vitest run --project web && npm run typecheck`
Expected: PASS. If the keyboard test fails because focus does not reach the treeitem, check
that `tabIndex={0}` is on the focused row and that `onKeyDown` is on the `ul`. Do not loosen
the test.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: ontology view with lazy class tree, term detail, edit and delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, contracts and the full check

**Files:**
- Modify:
  - `CLAUDE.md`: in the **Cross-language contracts** table, add the row below. Extend the
    "Job statuses and tasks" row with `ontology` (migration 0032). Add `ontologies/…` to the
    "Object keys" row.
  - `docs/design/rdf-publishing.md`: the *Object keys* bullets under *Ontology library → Model*
    become `ontologies/{id}/sources/{sha256}.{ext}` (as received, named by its bytes) and
    `ontologies/{id}/v{version}/normalized.nt`. Note `root` and `child_count` on
    `ontology_terms`, and the column names `domains`/`ranges`.
  - `docs/architecture.md`: if it lists job tasks or tables, add `ontology` and the three
    tables.

The new contracts row:

```markdown
| Ontology library (ADR 0011, migration 0032) | `packages/shared/src/ontologies.ts` (`OntologySummary`, `OntologyVersionView`, `TermPage`, `TermDetail`, `TERM_GROUPS`, `ontologyFormat`, `ONTOLOGY_INDEXED_EVENT`), `ontologySourceKey`/`ontologyNormalizedKey`; `OntologyRepo` (`apps/api/src/ontologies/repo.ts`) creates versions and `ontology` jobs (params `{ontologyId, version, sourceKey, fileName, mediaType}`) | `ontology.parse_ontology`, `run_ontology_import` (`OntologyJobParams`), `PgOntologyStore` (writes `ontology_terms` incl. `root`/`child_count`, version status), `ONTOLOGY_INDEXED`, `storage.ontology_normalized_key`; `tests/fakes.py` `MemoryOntologyStore` |
```

- [ ] **Step 1: Make the docs changes above.**

- [ ] **Step 2: Run everything CI checks**

Run: `npm run check` then `npm run worker:test` then `npm run worker:lint`
Expected: all green. Fix anything red at its cause; never weaken a test.

- [ ] **Step 3: Commit, push and open the PR**

```bash
git add CLAUDE.md docs
git commit -m "Docs: ontology library contracts and keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin claude/ontology-library
```

Open the PR against `main` with the title *Ontology library (ADR 0011, rollout step 1)*.
The body should cover the summary, the scope (file import only), how it was tested, and
whether the Pg integration tests were run. End it with the attribution line.
