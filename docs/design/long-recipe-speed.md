# Long recipes: repeated table calls, missed headings and a parallel step graph (research)

Status: **research, nothing built**, 2026-10-21. The example is a test run of a long stability
report (102 pages, a Word document) on the Workbench recipe `stability-extract-full`, draft v1:
73 steps, every one on the local 27B model, **4 h 28 min** from claim to review. The recipe was
drafted by the Workbench stages (outputs, sections, steps) and never edited by hand; it has no
references and one dev sample, so it can still be reshaped freely.

Part 1 is the big win: the recipe asks the model the same question about the wrong text 1,750
times. Part 2 is what a parallel LangGraph step graph would add on top. Document text, product
names and identifiers are left out of this note on purpose (the repository is public).

## Where the time went

| Steps | What they read | Model calls | Time |
| --- | --- | --- | --- |
| 13 steps: cover page, summary, Tables I-XI | one plain section each | 13 | 4 min |
| 60 steps: `extract_table_1` … `extract_table_60` | the repeating section `result_tables` (30 occurrences) | 60 × 30 = 1,800 | **4 h 24 min** |

A table step that reads a repeating section runs **once per occurrence** (`run_step_extraction`
with a `RepeatPlan`), told which occurrence it reads. Each of the 60 steps is meant for one
printed table ("Extract data from the block titled 'Table 8: …'"), but it is asked about all 30
blocks. Reading the 1,800 replies in the runs bucket (`{job}/{step}.occ-{n}/attempt-1.json`) and
timing each call from the job's `step progress` events:

| Reply | Calls | Time | Average |
| --- | --- | --- | --- |
| `{"rows": []}` (not my table) | 1,610 | 1.9 h | 4 s |
| Rows copied from **another** table | 141 | 2.0 h | 51 s |
| Rows of the step's own table | 49 | 0.5 h | 39 s |

So nine tenths of the time went on calls that should not have been made. It is also an accuracy
problem: of 2,612 rows extracted, **640 came from the step's own table and 1,972 from another
table** (the model, told to find "Table 8", copies a similar-looking dissolution table instead).
That, not the model, is behind most of the job's `5256 normalisation issue(s)`. Eleven tables got
no rows of their own at all, among them Tables 1-3, which never reached a result-table step.

## Why the headings were missed

The drafted section is:

```yaml
- id: result_tables
  repeat: true
  anchor: '^\s*Table\s+\d+:\s.*Results\s*$'
  key: '^\s*Table\s+(\d+):'
```

The anchor wants "Results" at the end of the **same line** as "Table N:". In the Word-to-PDF text
most titles wrap onto a second or third line:

```text
Table 2:     Study… - Batch … packed as 60 count in 160 cc HDPE bottle - Assay and
             Chromatographic Purity (…) Results
             Parameter        Assay      …
```

It matched 30 of the 60 titles (keys 4-8, 14-18, 24-28, …: the short titles), so:

- each occurrence holds two to five printed tables, which is why a step "for Table 7" sees rows of
  Tables 7, 16, 17, 26, 27 and 47 across the occurrences;
- Tables 1-3 come before the first match, so their text is part of the previous plain section
  (`test_methods` grew to about 34,000 characters, and its two steps read three result tables
  they do not need), and no result-table step ever sees them.

The anchor does have one thing right: the table of contents lists every title too, ending in dot
leaders and a page number (`…Results.......25`), and `Results\s*$` keeps those out. Any fix must
keep that.

Nothing flagged it. The Sections tab and the sections stage's anchor check count occurrences, but
30 occurrences with keys 4-8, 14-18, … look healthy unless you notice the gaps.

## Part 1: the fix

### The table shapes

The 60 printed tables have only **five** column sets (checked against the draft's outputs):

| Kind | Tables | Columns |
| --- | --- | --- |
| Appearance and water content | 6 (1, 11, 21, …) | 10 |
| Assay and chromatographic purity (both actives) | 24 (2-5, 12-15, …) | 15 |
| Dissolution (both actives) | 18 (6-8, 16-18, …) | 13 |
| Polymorphism, disintegration, hardness | 6 (9, 19, …) | 11 |
| Microbial purity and water activity | 6 (10, 20, …) | 12 |

The outputs stage made one output per *printed* table (one per study and batch). The data is
better as one output per *kind*, with the study, batch and table number as columns (the metadata
columns `table_title`, `table_number`, `page_number` are already there).

### Fix A: one repeating section per kind (recipe only, no code)

Five repeating sections, each anchored on a title of its own kind, and five table steps, each
reading its own section with `keyColumn: table_number`:

```yaml
- id: appearance_tables
  repeat: true
  key: '^\s*Table\s+(\d+):'
  anchor: '^\s*Table\s+\d+:(?=(?:(?!Parameter)[\s\S]){0,400}?Appearance\s+and\s+Water\s+Content\s+Results[ \t]*$)'
```

The other four change only the words after `{0,400}?`:

```text
assay_tables        Assay\s+and\s+Chromatographic\s+Purity\b[^\f]{0,120}?Results[ \t]*$
dissolution_tables  Dissolution\b[^\f]{0,120}?Results[ \t]*$
physical_tables     Polymorphism\s+by\s+XRD,\s+Disintegration\s+time\s+and\s+Hardness\s+Results[ \t]*$
microbial_tables    Microbial\s+Purity\s+and\s+Water\s+Activity\s+Results[ \t]*$
```

How the anchor reads: a line starting `Table N:`, then a look ahead over at most 400 characters,
stopping before the table's `Parameter` header row, for the kind's words and `Results` at the end
of a line. The look ahead spans the wrapped title lines; the end-of-line `Results` keeps the
table of contents out (its titles end in dot leaders); the `Parameter` stop keeps a title from
borrowing the next table's words.

Tested against this document's prepared text (`prepared/{sha256}/text.json`):

| Section | Occurrences | Keys |
| --- | --- | --- |
| `appearance_tables` | 6 | 1, 11, 21, 31, 41, 51 |
| `assay_tables` | 24 | 2-5, 12-15, 22-25, 32-35, 42-45, 52-55 |
| `dissolution_tables` | 18 | 6-8, 16-18, 26-28, 36-38, 46-48, 56-58 |
| `physical_tables` | 6 | 9, 19, 29, 39, 49, 59 |
| `microbial_tables` | 6 | 10, 20, 30, 40, 50, 60 |

All 60 titles, each once, none from the contents list, each anchor in under 10 ms (well inside the
preview's 10 s cap). One title (Table 8) uses a non-breaking hyphen where the others use `-`;
matching on the kind's words rather than the punctuation makes that harmless. Because an
occurrence ends at the next start of any section, every occurrence now holds exactly one table,
and `test_methods` ends at Table 1 again.

The result: **60 model calls instead of 1,800, each on exactly one table.** At this run's 39-51 s
per real table call that is about **35-50 minutes** sequentially, against 4 h 24 min, and every
row comes from the table it claims to.

Other changes the same draft needs:

- the check `check_study_ids_consistent` reads `table_1_….table_number`; point it at the new
  appearance output (or every kind);
- the steps' instructions become per kind ("one row per storage condition and time point of the
  table in this block"), with the study, batch and packaging read from the block's title;
- delivered CSVs change from 60 files to 5. Nothing is published or referenced yet, so this costs
  nothing now and much more later.

This can be done today, on the Sections and Outputs tabs or as a revise round with this note's
findings as feedback.

### Fix B: keep one output per printed table, read one occurrence (engine change)

If 60 outputs are wanted after all (a consumer expects one file per printed table), the engine
needs a way for a step to read **only the occurrence with a given key**, for example on the step:

```yaml
- id: extract_table_8
  sections: [result_tables]
  occurrences: ['8']      # new: run only on the occurrence whose key is 8
```

with `result_tables` given a corrected anchor (`^\s*Table\s+\d+:(?=(?:[^\n]*\n){0,2}[^\n]*Results[ \t]*$)`
matches all 60 titles and none of the contents list). Also 60 calls. It is a cross-language
contract change (`packages/shared/src/template.ts` and `worker/src/ingest_worker/template.py`, the
repeat plan in `pipeline.run_step_extraction`, `plugins.run_plugin`, the preview, coverage, the
Pipeline tab's step form, the shared fixture), and a step naming a key the document lacks needs a
rule (no rows, plus an issue). Fix A gets the same speed and better data without it, so B is only
worth building when one output per printed block is a real requirement.

### Stopping it happening again

The recipe was drafted, so the cheapest guards are checks the drafting stages and the editor
already have a place for:

1. **Key gaps (sections stage and Sections tab).** *Built (Part A): reported as missed headings.* When a repeating section's keys are numbers,
   report the gaps: "keys 4-8, 14-18, … found; 1-3, 9-13, … missing". Deterministic, cheap, and it
   would have caught this anchor at once. It fits next to `key_issues` and the anchor round's
   feedback (`drafting.repeated_blocks` already feeds back related problems).
2. **Calls per document (Pipeline tab, `ChecksPanel`).** *Built: the editor warnings (Part B) and run diagnostics (Part C).* Show each step's calls per document
   (occurrences × chunks on the newest sample), and warn when several table steps read the same
   repeating section: "60 steps read `result_tables` (30 occurrences): 1,800 model calls per
   document". The figure belongs beside each step in the step list too.
3. **Mostly empty occurrences (after a run).** *Partly built (Part C): run diagnostics are sent to revise and shown on the Revise tab; the Review page's Steps tab and the Pipeline tab's last-run figures are not built.* When a step's occurrence calls mostly return no
   rows, say so on the Review page's Steps tab and the Pipeline tab's last-run figures: "returned
   rows for 7 of 30 occurrences". The audit files already hold the replies.
   A step served from the Workbench step cache reports no counts, so a problem still present is
   not flagged until the step's input changes (follow-up: keep the counts in the cache entry).
4. **Outputs stage guidance.** *Built (Part B).* Tell the outputs stage to make one table per *shape*, not per
   printed block, when blocks repeat with the same columns; the sections stage then has an
   obvious anchor per kind.

## Part 2: a parallel step graph (LangGraph)

The step graph (`step_graph.py`, on in production with `WORKER_STEP_GRAPH=langgraph`) is a straight
line: one node per step, each checkpointed. It can become a real graph.

### What it would save

- **Dependencies are already known.** `step_inputs` finds a step's dependencies from its `context`
  and enrich rows; a check step depends on the steps its `values` names. In this recipe the only
  chains are cover page → summary and Table 1 → the check; everything else is independent.
- **The model servers set the limit.** A short benchmark on the two LM Studio hosts that have the
  27B model loaded (500 output tokens per request, queue idle): one request runs at 40-81
  tokens/s; two at once give 75-160 tokens/s per host, inconsistently (1.0-2.0×, probably the
  model's speculative decoding against batching); three or four at once give nothing more. A
  second host is a clean 2×, but today a model choice names one endpoint.
- **Estimates.** For this recipe as it is: about 1½-2¼ h. With Fix A it has only five result
  steps, so step-level fan-out adds little; fanning out **per occurrence** (60 calls over two hosts,
  two at a time each) brings it to about **15-25 minutes**.

### What a reliable design needs

1. **Lanes, not just edges.** LangGraph runs in supersteps and each waits for its slowest node, so
   a dependent step placed in superstep 2 would wait for every independent step of superstep 1.
   Run each chain of dependent steps as one node (a lane, sequential inside); lanes run in parallel.
2. **Per-step channels with a reducer.** Each step writes its own `StepOutcome` to its own channel;
   the `DocState` is folded from them **in pipeline order**, so outputs, issues and enrich merges
   are identical whatever order steps finish in. This also ends the checkpoint growth with the
   square of the step count (finding 4 of [langgraph-trial.md](langgraph-trial.md)).
3. **`Send` per occurrence** for steps reading a repeating section. Resume gets finer too: today a
   worker lost mid-step repeats all its occurrences (2-10 minutes here). LangGraph keeps the
   writes of the branches that finished in a failed superstep, so a retry re-runs only the rest.
4. **A limit per endpoint, across workers.** `max_concurrency` limits one job; three worker
   replicas share the hosts. A per-endpoint *max concurrent calls* setting with a slot table in
   Postgres, and model choices that can name several endpoints holding the same model, both
   checked against the data policy as now.
5. **Stopping siblings.** Check for cancellation before every occurrence call, not only between
   steps; a `DocumentError` in one branch cancels the others instead of letting them finish.
6. **Thread safety.** `PgJobQueue` shares one psycopg connection (also used for `LISTEN`); step
   runs, events and `step_reporter` assume one step at a time.
7. **Progress becomes a set.** `StepProgressSchema` and `JobProgress.step` describe one running
   step; they would list several (a cross-language contract, shown on Home, Test runs and
   References).
8. **Equivalence.** `tests/test_equivalence.py` compares the parallel parts without regard to
   order and still requires identical outputs.

### In the recipe UI

- **Before a run:** a *Run plan* on the Pipeline tab: the lanes as worked out from the
  dependencies, "runs after …" chips, calls per document per step, and the warnings of Part 1.
  The only new recipe setting would be an optional parallelism limit, absent by default so
  recipes hash as before.
- **During and after:** several running steps in the job's progress, and a timeline of the step
  runs (`step_runs.started_at`/`finished_at`) on the Review page's Steps tab, showing what ran at
  the same time.

## Fix A applied (2026-10-21)

Fix A was saved into draft v1 by hand (a `hand` change). It now has 12 sections, 16 tables and
19 steps (the 60 table steps became 5); every kept field, table and step is unchanged. The
project's dev sample is a shorter 33-page version of the report, holding Tables 1-10 of one study
(the 102-page file of the example job is no longer a sample). On it:

| | Old recipe (estimate) | Fix A (measured) |
| --- | --- | --- |
| Result-table calls | 60 steps × its blocks, about 300 | **10**, one per table |
| Calls returning another table's rows | most of them | **0**: every row's `table_number` is its block's key |
| Whole job | — | **13 min 16 s**, of which the result tables took 9 min 50 s |

The 131 result rows were checked against the source text (Tables 2 and 4 really have two rows
each). The job still goes to review, for reasons Fix A does not touch:

- **28 normalisation issues:** values such as `<0.05` in decimal columns (impurities, microbial
  counts, disintegration and hardness ranges). Those columns should be text, or keep the
  qualifier in a column of its own.
- **`check_study_ids_consistent` is always unmatched:** its reference `studies` is a list field,
  but `checks.run_check` reads reference values only from a table's rows, so it finds none. The
  drafted check never worked (before Fix A it compared table numbers with study IDs). A reference
  must be a table column, for example Table VI's studies, and the editor should flag a list-field
  reference.

## Suggested order

1. **Fix A on this recipe** (no code): five kind sections, five outputs, five steps; re-run the dev
   sample and compare. Expected: about 40 minutes and rows from the right tables.
2. **The guards** of "Stopping it happening again", key gaps first.
3. **Per-step channels and the Run plan view** (no change in behaviour).
4. **Fan-out per lane and occurrence**, the per-endpoint limit and endpoints pooled under one
   model choice, behind the existing flag.
5. **Fix B** only if one output per printed block turns out to be needed.
