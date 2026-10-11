# Results page: design

Date: 2026-10-11 · Status: approved in conversation

## Goal

The app has Jobs and Document types pages. Add a **Results** page that shows what each document
actually delivered: the published outputs of each job, **read back from the configured final
target** (`TARGET_S3_*`). It works one document at a time: a list of published documents, and a
detail view per document. Aggregating a dataset across documents is out of scope.

## Background (current behaviour)

- The publish target is set once per deployment by the worker env `TARGET_S3_ENDPOINT`,
  `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY`, `_BUCKET` (default `ingest-published`) and `_PREFIX`.
  An empty endpoint, region or key falls back to the matching `S3_*` value
  (`worker/src/ingest_worker/config.py`). docker-compose already passes these variables to the
  API container through the shared `x-s3-env` anchor.
- Non-test jobs publish either right after processing (no review needed) or when a reviewer
  approves them (a `publish` task). `publish_outputs` writes `{prefix}{outputKey}` to the target
  bucket. `record_published` inserts `job_outputs` rows with `stage='published'`, the target
  `bucket`, the full prefixed `object_key`, and `created_at` (the publish time).
- Template jobs publish `fields.csv` (when the template has fields), one CSV per table, one CSV
  per check, `issues.csv`, and `document.json`. `document.json` holds `fields{id:{value,…}}`,
  `tables{id:[row…]}`, `checks`, `issues`, `template{id,version,name}`, and, for reviewed jobs,
  `review{reviewer,note,reviewed_at,edits[{field,table,row,column,value,…}]}` plus
  `published_at`. Legacy spec jobs publish the CSV/JSON outputs their spec declares.
- The API has a single `ObjectStore` (SeaweedFS). `GET /api/jobs/:id/outputs/:outputId` reads
  from it and takes the first output with a matching id, so it ignores `stage`. For a target on
  another endpoint that read fails.

## Design

### API

**Config** (`apps/api/src/config.ts`). Add optional `TARGET_S3_ENDPOINT`, `TARGET_S3_REGION`,
`TARGET_S3_ACCESS_KEY`, `TARGET_S3_SECRET_KEY`, `TARGET_S3_BUCKET` (default
`ingest-published`) and `TARGET_S3_PREFIX` (default `''`). An empty string counts as unset. A
new helper `targetConfig(config)` returns the resolved endpoint, region, keys, bucket and
prefix, with the same fallback to `S3_*` that the worker uses.

**Deps** (`AppDeps`). Add `targetStore: ObjectStore` and
`target: { bucket: string; prefix: string }`. `server.ts` builds a second `S3ObjectStore` from
`targetConfig`. `test/helpers.ts` passes a separate `MemoryObjectStore` and returns it as
`targetStore`.

**Store selection.** A helper `storeFor(deps, stage)` returns `targetStore` for `published`
and `store` for `draft`. Every read of a `job_outputs` object goes through it.

**Download endpoint** `GET /api/jobs/:id/outputs/:outputId`:
- Takes optional `?stage=draft|published`. Without it, the endpoint prefers `published` and
  falls back to `draft`.
- `?inline=1` returns `content-disposition: inline` so the browser can preview the file.
- A missing object returns 404 `{ error: 'output object missing from storage' }`, as it does
  today.
- A store error (target unreachable) returns 502 `{ error: 'target storage unavailable' }`.

**`GET /api/results?templateId=&limit=&before=`** returns `ResultSummary[]` for non-test jobs
with at least one published output, newest publish first.
- `limit` defaults to 50 (max 200). `before` is an ISO timestamp cursor for "Load more".
- Each item is `{ jobId, documentId, filename, specId, specVersion, publishedAt, reviewer,
  reviewedAt, outputCount, issueCount }`.
- `reviewer` is null for jobs published without review.
- `issueCount` is the `row_count` of the published `issues` output, or null when there isn't
  one.

**`GET /api/results/:jobId`** returns `ResultDetail`:
- `{ job: JobSummary, target: { bucket, prefix }, outputs: JobOutput[] (published only),
  document: PublishedDocument | null, documentError: string | null,
  definition: { kind: 'template', fields, tables } | { kind: 'spec' } }`.
- `document` is the parsed published `document.json` from the target, when one exists.
- `documentError` is `'missing from target'` or `'target storage unavailable'`; in either case
  `document` is null and the rest of the response still returns 200.
- `fields` and `tables` come from the job's template version via the existing
  `resolveDefinition`, to supply labels (`name ?? id`), types and column order.
- A job with no published outputs, or an unknown or invalid id, returns 404.

**Repo.** Add `listPublished({ templateId?, limit, before? })` to `IngestionRepo`, implemented
in `PgRepo` and `MemoryRepo`. The PgRepo version uses this SQL:

```sql
SELECT <job columns>, max(o.created_at) AS published_at, count(*) AS output_count,
       max(o.row_count) FILTER (WHERE o.output_id = 'issues') AS issue_count
  FROM jobs j JOIN documents d ON d.id = j.document_id
  JOIN job_outputs o ON o.job_id = j.id AND o.stage = 'published'
 WHERE NOT j.test AND ($1::text IS NULL OR d.spec_id = $1)
 GROUP BY j.id, d.id
HAVING ($2::timestamptz IS NULL OR max(o.created_at) < $2)
 ORDER BY published_at DESC LIMIT $3
```

There's no migration, because the existing columns cover this.

**Shared contracts** (`packages/shared/src/results.ts`, exported from the index). Zod schemas
for `ResultSummary`, `ResultDetail` and `PublishedDocument`. `PublishedDocument` is permissive
(`passthrough`): `fields: record<{value: unknown}>`, `tables: record<array<record<unknown>>>`,
`checks: record<{rows: array}>`, `issues: array`, `review?: {reviewer, note, reviewed_at,
edits[]}`, `published_at?`. No worker change is needed. The env contract is the worker's
existing one.

### Web

**Routing and nav.** Add routes `{ name: 'results' }` (`#/results`) and
`{ name: 'result'; jobId }` (`#/results/<jobId>`). The nav becomes Jobs · Results · Document
types. The page uses the wide layout.

**`Api` port.** Add `listResults({ templateId?, before? })` and `getResult(jobId)`.
`outputUrl(jobId, outputId, opts?: { stage?, inline? })` gains the optional third argument,
which existing callers don't need to pass. `fakeApi()` gains defaults for both new methods.

**`ResultsPage`** (`apps/web/src/results/ResultsPage.tsx`):
- A document-type filter: a select built from `listTemplates()`, with "All" as the default.
- A table with columns Document (filename), Type (`specId vN`), Published, Reviewed by
  (reviewer, or "auto"), Issues, and Files.
- Each row links to `#/results/<jobId>`.
- "Load more" passes `before` = the last row's `publishedAt` and is hidden when fewer than 50
  rows come back.
- The empty state reads: "No published results yet. Test runs and rejected documents never
  appear here."

**`ResultDetail`** (`apps/web/src/results/ResultDetail.tsx`):
- **Header:** filename, type and version, published time, reviewer and note (or
  "Published without review"), target `bucket/prefix`, a link back to `#/results`, and a list of
  downloads (one link per published output, using `outputUrl(…, { stage: 'published' })`).
- **Template jobs with a `document`:**
  - **Fields:** label-left rows (the same `form-rows` look as the General tab) with the field
    label and its formatted value. A field edited in review (from `review.edits`) gets an
    "edited" marker.
  - **Tables:** one section per template table, with headings from the template columns, inside
    `.table-scroll` and using the compact review-table style. Edited cells are marked.
  - **Checks** and **Issues:** `<details>` elements, collapsed by default, with the count in
    the summary.
- **`document` null with a `documentError`:** an alert names the problem and the target bucket.
  The downloads list still appears, each link pointing at its object.
- **Legacy spec jobs:** for each published output, CSVs are fetched through the `inline` URL
  and rendered as a table of the first 500 rows (a small CSV parser in `results/csv.ts` that
  handles quotes and doubled quotes), with "Showing 500 of N rows" when cut off. JSON is shown
  pretty-printed in a `<pre>`. A file that fails to load shows "missing from target" next to it.

### Error handling summary

| Situation | API | UI |
| --- | --- | --- |
| Object deleted from target | 404 on download; `documentError: 'missing from target'` on detail | Inline alert on that file or on the document view |
| Target unreachable | 502 on download; `documentError: 'target storage unavailable'` | Banner naming the target bucket; job metadata still shown |
| Job not published / unknown | 404 | "Result not found" with a link back |

## Testing (written first)

- **Shared:** schema tests in `packages/shared/test/results.test.ts` cover parsing a real-shaped
  `document.json` (hand-written fixture matching `render_document` output) and that extra keys pass through.
- **API config:** `TARGET_S3_*` fall back to `S3_*`, empty strings count as unset, and the
  default bucket is `ingest-published`.
- **API routes** (`apps/api/test/results.test.ts`, using `MemoryRepo` and two
  `MemoryObjectStore`s):
  - the list skips jobs with no published outputs and test jobs;
  - the list orders by publish time, filters by `templateId`, and pages with `before`;
  - detail reads `document.json` from the **target** store, not the draft store;
  - detail returns `documentError` when the object is missing;
  - detail returns 404 for unpublished jobs.
- **API download** (`jobs.test.ts`): `?stage=published` reads the target store, the default
  prefers published, `?inline=1` sets `content-disposition: inline`, and a store error returns
  502.
- **Repo:** the API has no Postgres test harness, so `PgRepo.listPublished` is exercised by the
  compose smoke test. `deploy/scripts/smoke-test.sh` gains `GET /api/results` → 200 with a JSON
  array.
- **Web** (`apps/web/test/ResultsPage.test.tsx`, `ResultDetail.test.tsx`, `csv.test.ts`, with
  `fakeApi`):
  - the list renders rows, filters, loads more, and shows the empty state;
  - detail renders labelled fields, edited markers, table headings and rows, collapsed
    checks/issues, and downloads with `stage=published`;
  - detail renders the `documentError` alert and the legacy CSV preview with truncation;
  - the CSV parser is covered by table-driven tests.
- **Router and nav:** `parseHash` handles the new routes, and the nav link is current on both.

## Out of scope

Aggregating or exporting a dataset across documents, browsing the target bucket outside the
recorded job outputs, editing results, and per-document-type targets.
