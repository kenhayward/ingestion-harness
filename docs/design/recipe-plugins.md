# Recipe plugins (phase 3 of the agent graph research)

Status: **3a to 3d done**, 2026-10-19. This is phase 3 of
[agent-graph-architecture.md](agent-graph-architecture.md) §8. It builds on the node contract in
[ADR 0018](../adr/0018-capabilities-as-nodes.md).

## Goal

A recipe step that runs a registered capability, a **plugin**, instead of a model call. Plugins
are how CT Studio grows without each new capability being a change to the pipeline:
- deterministic extractors;
- other OCR engines;
- value normalisers;
- later, remote agents over A2A (phase 5).

## The step

```yaml
pipeline:
  - type: plugin
    id: references
    uses: text.pattern@1        # <plugin id>@<major version>
    fields: [invoice_number, po_number]   # or table: <id>; same rule as an extract step
    sections: [head]            # the text it reads (optional: a plugin may read only values)
    context:                    # earlier values it may read, as for an extract step (optional)
      supplier: supplier_name
    with:                       # the plugin's own settings, checked against its schema
      patterns:
        invoice_number: 'Invoice\s+No\.?\s*:?\s*(?P<value>[A-Z0-9-]+)'
        po_number: 'PO\s*:?\s*(?P<value>\d+)'
```

- **The same fill rules as an extract step.** A plugin step fills either fields or one table, and
  every output is filled by exactly one step, whatever its type. So output coverage, check paths,
  `context`, the RDF mapping and review all work unchanged.
- **The same reply shape as a model.** A plugin returns what an extract step's model returns:
  `{field: {value, evidence, page}}`, or `{rows: [...]}` for a table. `normalise_step` then
  types the values and lists the issues, so a plugin never re-implements normalisation.
- **`uses` pins a major version.** A published recipe runs the same plugin major for as long as
  it exists. A plugin's minor changes must keep its output for the same input; anything else is
  a new major.
- **`with` is the plugin's own settings.** The plugin's schema checks them before any model call
  of the job, like model resolution. A bad setting, or a plugin this worker does not have, is a
  `DocumentError` (needs review).

## The plugin contract (worker)

```text
Plugin
  spec: NodeSpec          id, version (major), output StepData, effects, egress
  settings: type[BaseModel]   pydantic model of `with` (extra="forbid"); its JSON Schema is
                              what the API and the recipe editor show and check (3b)
  run(ctx: PluginContext, settings) -> StepData

PluginContext (what a plugin may read, nothing else)
  job: the claimed job (read-only)
  step: the plugin step
  sections: {section id: text} for the step's sections (page markers included)
  context: the step's `context` values, rendered as for a prompt
  models: JobModels for the job (egress "model" plugins only; the data policy applies)
  event(message, data): an advisory job event
```

- **Registry.** `ingest_worker.plugins.BUILTINS` holds the built-ins, and `plugins()` adds those of
  packages installed in the worker image, through the entry point group `ct_studio.plugins` (3d,
  [the plugin-writing guide](../plugins/writing-plugins.md)).
- **Trust.** A plugin runs in the worker process with the worker's privileges, so only plugins
  installed in the image run. It gets models through `JobModels` and nothing else (no bucket,
  no database, no queue writes). A third party's capability belongs behind A2A (phase 5), not
  in-process.
- **Step runs.** A plugin step records a step run with `model: null` (`modelsUsed` already
  skips null models) and an event `ran <step>`. A plugin step cannot be re-run from review in 3a:
  a deterministic plugin would return the same values.

## First plugin: `text.pattern@1`

Deterministic extraction by regular expression, with no model call and no cost.
- **Fields.** For each field in `with.patterns`, the first match across the step's sections. The
  value is the named group `value`, else group 1, else the whole match. The evidence is the
  matched line, and the page comes from the nearest `[page N]` marker before the match.
- **A table.** `with.row` is one pattern whose named groups are column ids. Each match is a row,
  and a column without a group is empty.
- **No match** is an empty value, which normalisation and review handle as for a model's empty
  reply.
- **Patterns** must compile and name only the step's own fields or the table's columns, checked
  with `with`.
- **Like anchors, patterns run without a time limit in production.** The recipe editor's preview
  (3c) runs them capped, as the Sections tab does for anchors.

## Slices

| Slice | What | Done when |
| --- | --- | --- |
| 3a | Recipe format (TS and Python, shared fixture), the worker's registry, `PluginContext`, plugin steps in the pipeline (validation before any call, step runs, events), `text.pattern@1` | a recipe with a plugin step processes end to end; equivalence traces unchanged; `npm run check` green |
| 3b | Plugin catalogue: the worker publishes its plugins (ref, summary, egress, settings JSON Schema) into a table at start; `GET /api/plugins`; `templateIssues` checks `uses` exists and `with` fits the schema | publishing a recipe with an unknown plugin or bad settings is refused with the reason |
| 3c | Recipe editor: add a plugin step, a settings form from the JSON Schema, a capped preview on dev samples; help topic | a designer adds a `text.pattern` step without writing YAML |
| 3d | Entry points for installed packages; a plugin-writing guide with a cookiecutter-style example | a plugin from another package runs in a recipe |

## The catalogue (3b)

- **What it holds.** The worker publishes the plugins it can run when it starts, and its set
  replaces the table's. So the catalogue is what the newest worker to start has, and a plugin
  removed from the image disappears. A short overlap of two images during a deploy can only
  lose or add a plugin's row until the next worker start.
- **Built-in nodes are not listed.** No recipe names them.
- **What the API checks.** The API checks a plugin step against the catalogue: the plugin must be
  listed, and `with` must fit its settings JSON Schema (ajv, draft 2020-12). Both issues block
  publishing.
- **What only the worker checks.** Rules a schema cannot state, such as a pattern that must
  compile or a field the step must fill, are checked when the job runs. That remains a
  `DocumentError` before any model call. The 3c editor's preview will show them sooner.
- **Before any worker has started**, the catalogue is empty, and a recipe with plugin steps cannot
  be published until one has.

## Progress

| Slice | State |
| --- | --- |
| 3a | done. TS: `PluginStepSchema`, `PLUGIN_REF`, `FILLING_STEP_TYPES`; coverage and validation count plugin steps; shared fixture `packages/shared/test/fixtures/plugin-steps.json`. Worker: `template.PluginStep`, `filling_steps`; `plugins.py` (`Plugin`, `PluginContext`, `resolve_plugins`, `PLUGINS`, `text.pattern@1`); `template_pipeline.run_plugin_step`. Web: `stepKind`, `PluginStepDetail` (read-only, edited in YAML) on the Pipeline tabs, step cards and proposal chips. |
| 3b | done. Migration `202610191612_plugin_catalogue` (`plugin_catalogue`, `ref` = `plugin_id@major`); worker `plugin_catalogue.py` (`catalogue_rows`, `PgPluginCatalogue.publish`, which replaces the set in one transaction, at worker start, advisory); shared `PluginInfoSchema`; API `plugins/catalogue.ts` (`PluginCatalogue`, memory and Pg), `plugins/settings.ts` (`settingsProblems`: ajv 2020 against the schema), `GET /api/plugins` (designers and admins), `templateIssues`: `pipeline.N.uses` `no plugin X on this deployment's workers`, `pipeline.N.with` `X settings: …`, both blocking; shared fixture `plugin-catalogue.json` pins the worker's rows and the API's settings cases. |
| 3c | done. Editor: `Api.listPlugins`, `usePlugins`, `AddPluginStep`, `PluginStepForm` (id, plugin, fills, sections (repeating ones from P2), context, settings), `settings-schema.ts` (`settingsFields`, `setSetting`: text, switches, numbers, choices, lists, text maps; anything else and an unknown plugin as JSON; empty values and defaults left out). Preview: task `plugin` (migration 202610191642), `POST|GET /api/workbench/projects/:id/plugin-previews` (open draft, ready dev samples, plugins with egress `none` only, one per project), worker `plugin_preview.py` (`preview_samples` in `capped.capped_call`, 20 s; problems in the result, never a failed job), `pluginPreviewKey`/`plugin_preview_key`, web `PluginPreview` under a plugin step in the Workbench pipeline (saved draft only). |
| 3d | done. Worker: `BUILTINS`, `plugins()` (cached per process, so a preview's spawned child loads the same set), `ENTRY_POINT_GROUP` `ct_studio.plugins` (an entry point loads a `Plugin` or a list), `load_installed` (sorted by entry point name; a package that does not load, a non-Plugin, a bad ref, settings without `extra="forbid"` or a JSON Schema, egress other than `none`, a built-in id or a ref already taken is logged and left out, the rest load), `check_plugin`, `plugin_context`; the worker logs `plugins: …` and publishes them all in the catalogue. Example package `worker/plugins/example` (`example.label_value@1`), a dev dependency of the worker; image: build argument `WORKER_PLUGINS` (`uv pip install` under the worker's locked versions, `deploy/.env`). Guide: [docs/plugins/writing-plugins.md](../plugins/writing-plugins.md). |

## Follow-ups (after phase 3)

| Follow-up | State |
| --- | --- |
| P1. Plugins that call a model | done. A plugin whose egress is `model` gets `ctx.model` (`PluginModel.ask(prompt, schema, *, system, max_attempts, max_tokens, check)`: `run_extraction` with validation and retries; refusals, unavailable models, context overruns and replies that never fit are a `DocumentError` naming the step; attempts audited as `{job}/{step}.ask-{n}/attempt-{k}.json`). The model is the job's override, else the step's optional `model` (a model choice; absent, not `default`, so older recipes hash as before), else the document type's (`stepModel`/`Template.step_model` take plugin steps), resolved by `resolve_plugins(template, JobModels)` before any model call, so the data policy applies. The step run records the model, attempts and tokens; the document's `models` names it. API: `pipeline.N.model` checked like an extract step's; a model on a plugin that calls none is a warning. Editor: a Model picker on a plugin step whose plugin calls a model (switching to a plugin that calls none drops it). `check_plugin` accepts egress `model`. The preview still runs egress `none` only. |
| P2. Plugin steps reading repeating sections | done. `PluginStep.keyColumn` on both sides; the repeat rules (a field step cannot read a repeating section, at most one per step, `keyColumn` needs a table step on a repeating section with `key`/`keyFrom` and a real column) apply to every filling step (`TemplateSchema.superRefine`, `Template._repeat_errors`), and the rule refusing plugin steps is gone; shared fixture `plugin-steps.json` cases. Run: `plugins.run_plugin(plugin, settings, ctx, repeat)` (`repeat_plan` takes any filling step) calls the plugin once per occurrence with that occurrence's text as the section and `ctx.occurrence` (`PluginOccurrence` `{index, count, key, section}`), joins the rows and sets `keyColumn` from each key; no occurrence, no call and `{"rows": []}`; a reply without `rows` is a `ValueError` naming the occurrence. `key_column_issues` covers plugin steps. One step run per step. The preview (`preview_samples`) uses the same helper over `segment_occurrences`. Editor: `PluginStepForm` disables repeating sections only for field steps (`repeatNote`) and shows `RepeatKeyColumn` (`tableColumns` from both editors). |
| P3. Re-running a plugin step from review | done. `POST /api/jobs/:id/steps/:step/rerun` takes a plugin step (`no extract or plugin step "…"` otherwise): the reviewer-edit 409 as before; `pageImages` refused (`page images are for extract steps; …`); `model` only for a plugin the catalogue lists with egress `model` (`{plugin} calls no model: …`, or `no plugin … on this deployment's workers`; unchecked without a catalogue), then `modelRefProblem` as for extract steps. Worker: `rerun_template_job` finds any filling step; a plugin step resolves through `resolve_plugins(…, only=step, model=params.model)` (re-run model, else the job's, the step's, the type's; the data policy applies), runs `run_plugin_step(trigger="rerun", instructions=…)` (`ctx.instructions`, event `re-ran <step>`), and shares the rest (issues replaced, checks re-run, `reruns` appended). Web: the Review page's Steps tab lists plugin steps with *Re-run* through `ReprocessDialog` (`noModel` unless the plugin's egress is `model`, no page images; `usePlugins(api, enabled)`). |
| P4. Steps that enrich an earlier table | plugin steps done (see P4 below); extract steps: next commit. `columns` on `ExtractStepSchema`/`PluginStepSchema` and `ExtractStep`/`PluginStep` (absent: the step creates the rows); the rules in `TemplateSchema.superRefine` (`tableSteps`) and `Template._enrich_errors`/`_column_errors`, an extract step refused with `an extract step cannot enrich a table yet`; shared fixture `enrich-steps.json` (validity, and the TS coverage of each column). `outputCoverage`: a table's `steps` are its creating steps, `columns` (only on a table some step enriches) the filler of each, `multiple` adds `table.column`; `fillerOf` and `gateHints` read a column's filler; Python `filler_of_table` (the creating step), `enriching_steps`, `filler_of_column` (used by `_resolve` and the context order), `step_inputs` adds the creating step. Run: `ctx.rows` (the rows without the step's own columns), a reply with another row count a `DocumentError` naming the step (`step 'E': P answered n rows for the m rows of T: …`), `normalise_step` types the step's own columns (the creating step leaves enriched columns `None`), `StepOutcome.columns` and `DocState.apply` merge by position (`zip(strict=True)`), the enriching step's result the merged rows. Re-runs: a creating step re-runs its enrichers (`resolve_plugins(only=…)`, their own models, `trigger` `rerun`); the API's reviewer-edit 409 counts any cell of the table for a creating step, only its columns for an enriching one. Preview: `preview_problem` (`step E fills columns of T, whose rows step C creates: try it in a test run`). Editor: *Enriches only these columns* on a plugin table step. |

## P4. Steps that enrich an earlier table

A table is often filled in two passes: one step finds the rows (the batches of a stability
report), and a later one fills a column the rows' own text lacks (each batch's expiry date,
printed in a summary elsewhere in the document). Today a table has exactly one filling step, so
the later pass cannot be written. P4 makes ownership **per column**.

### The rule

- A table step without `columns` **creates** the table's rows. A table has exactly one creating
  step, as now.
- A later table step names the same `table` and `columns: [...]`, a non-empty list of that
  table's columns: it **enriches** the table. It receives the rows so far and returns the same
  rows, in the same order, filling only its columns.
- **Every column is filled by exactly one step.** The creating step fills every column no
  enriching step names, and must keep at least one; two enriching steps never name the same
  column.
- An enriching step runs after its creating step (the rows must exist), so the rule reads like
  the context-order rule: a step's `context` may name an enriched column only when that column's
  enriching step comes earlier.
- An enriching step reads no repeating section, has no `keyColumn` and (an extract step) no
  `chunkPages`: it answers once, for every row. The creating step may still read a repeating
  section; its rows are what the enriching step gets.
- `columns` on a step filling fields is an error. Absent `columns` changes nothing, so older
  recipes parse and hash as before.

Messages (both sides, the shared fixture `packages/shared/test/fixtures/enrich-steps.json`):
`step "E": columns needs a table`, `step "E": unknown column "c" of T`,
`table "T" has no step creating its rows`, `table "T" is filled by more than one step` (two
creating steps, as before), `column "T.c" is filled by more than one step`,
`step "C" creates the rows of T but fills none of its columns`,
`step "E" enriches T before step "C" creates its rows`,
`step "E": an enriching step cannot read a repeating section`,
`step "E": keyColumn is for the step creating the rows`,
`step "E": an enriching step cannot be chunked`.

### Coverage

`outputCoverage` keeps one row per output; a table's `steps` are its creating steps, and each
table row gains `columns: [{id, steps}]`, the step filling each column (the enriching step that
names it, else the creating step). `multiple` adds `T.c` for a column two enriching steps name.
`fillerOf` (the context-order rule) and `gateHints`' `no_step` read a column's own filler, so a
column hint points at the step that fills it. Python: `Template.filler_of_column(table, column)`,
used by `_resolve` (a check path `T.c` reads the column's filler's result) and the context
order; `_consistency` counts creating steps per table and enriching steps per column;
`step_inputs` adds an enriching step's creating step to its inputs.

### Running

- `StepOutcome.columns` (None for every other step): `normalise_step` types only the step's
  columns; `DocState.apply` merges them into the table's rows by position instead of replacing
  the table, and the step's result is the merged rows (what check paths read).
- **Plugins**: `ctx.rows`, a copy of the table's rows so far (None for every other step). A reply
  with another number of rows is a `DocumentError` naming the step (the plugin is code: retrying
  it changes nothing). The Workbench preview runs no earlier step, so it says an enriching step
  needs a test run.
- **Extract steps**: the prompt shows the rows so far as numbered context and asks for one entry
  per row with only the step's columns (the schema has just those columns); a reply with another
  number of rows fails validation and is fed back like any other schema error (`run_extraction`'s
  `check`), then goes to review once the attempts are spent. It is never served across documents
  from the step cache by mistake: the rows are part of the rendered prompt, so of the cache key.
- **Re-runs** (P3's path): re-running a step that **creates** a table also re-runs every step
  enriching it, in pipeline order, with their own models (the re-run's model and guidance apply
  to the creating step only), because new rows would otherwise sit beside the old rows'
  enriched values, aligned to nothing. Re-running an enriching step re-runs that step alone on
  the stored rows. The reviewer-edit 409 follows: a creating step is refused while any cell of
  its table was edited (its re-run would replace them all), an enriching step only while one of
  its columns was.
