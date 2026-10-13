# Detecting a document's type: research (step 1)

Could CT Studio tell an uploaded document's type from its text, instead of the uploader picking
it? Step 1 measures this without changing anything users see: `worker/src/ingest_worker/detect.py`
scores every Workbench sample (whose type is known) against every document type and reports how
it would be detected. No model calls; it only reads.

## How it scores

Each type's layout is applied as production applies it: page range, copy selection, page markers,
then `segment.section_spans`. Anchors that match empty text (`\A`, `^`) are no evidence and are
left out. Two rules:

- **required**: a type matches when every distinctive *required* section is found and the page
  count fits. One matching type is the answer; several are ambiguous.
- **coverage**: the share of a type's distinctive sections found, required or not. The answer
  needs at least `COVERAGE_MIN` (0.5), and any type within `COVERAGE_MARGIN` (0.25) of the best
  makes it ambiguous.

The report also prints the coverage matrix: how every type scores the samples of every other type.

## Running it

Against a deployment whose worker includes this module:

```bash
docker exec ingestion-worker-1 python -m ingest_worker.detect
```

Add `--published-only` to leave out types with no published version (drafts count by default),
and `--json` for machine-readable output. It needs `DATABASE_URL` and the `S3_*` settings, which
the worker already has. Samples whose text is not prepared yet are listed as skipped.

## Results (2026-10-13, the local deployment)

3 published types, 12 samples, 8 distinct PDFs.

| Rule | Correct | Ambiguous | None | Wrong |
| --- | --- | --- | --- | --- |
| required | 0 | 0 | 12 | 0 |
| coverage | 7 | 2 | 0 | 3 |

Findings:

1. **The required rule has nothing to work with.** The newest published version of every type
   marks every section optional (earlier versions had required ones). Beyond detection, this
   means production no longer refuses a document of the wrong type: a document uploaded under the
   wrong type produces output instead of stopping in `needs_review`.
2. **Every miss of the coverage rule is between `analytical-method-validation-report` and
   `tables-only`.** 4 of the 8 PDFs are samples of both: these are two templates (different
   outputs) for one kind of document. No reading of the text can choose between them; which
   outputs are wanted is the uploader's decision.
3. **By kind of document, the coverage rule was right 12 out of 12 times.** The validation
   reports score 0.00-0.08 as a process-validation protocol, and the protocol scores 0.00 as
   either report type.
4. **The evidence is thin.** There are 2 kinds of document. The protocol has one sample, and it
   covers exactly 0.50 of its own type's sections, right at the threshold. The deployment holds 7
   distinct production documents in all.

## Recommendation

- **Don't build detection in the upload flow yet.** With two kinds of document and a handful of
  uploads, the type dropdown costs less than detection would. The one real confusion (two
  templates for the same document) is not something detection can resolve.
- **Revisit with 4 or more kinds of document, or batch intake.** Rerun this report then. If the
  types stay apart by kind, step 2 would group templates that read the same documents, detect the
  kind, and let the uploader pick among that kind's templates.
- **Independently of detection, consider making one distinctive section required per type**
  (for example the protocol's approvals heading or the report's numbered title). That restores
  the check that stops a document uploaded under the wrong type.
