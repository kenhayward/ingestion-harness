# Recipe plugins (phase 3 of the agent graph research)

Status: **3a done**, 2026-10-19; 3b–3d to come. This is phase 3 of
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

- **Registry.** `ingest_worker.plugins.PLUGINS` holds the built-ins. Packages installed in the
  worker image add theirs through the entry point group `ct_studio.plugins` (3d).
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
| 3b | Plugin catalogue: the worker upserts `NODES` and `PLUGINS` (id, version, summary, settings JSON Schema) into a table at start; `GET /api/plugins`; `templateIssues` checks `uses` exists and `with` is valid | publishing a recipe with an unknown plugin or bad settings is refused with the reason |
| 3c | Recipe editor: add a plugin step, a settings form from the JSON Schema, a capped preview on dev samples; help topic | a designer adds a `text.pattern` step without writing YAML |
| 3d | Entry points for installed packages; a plugin-writing guide with a cookiecutter-style example | a plugin from another package runs in a recipe |

## Progress

| Slice | State |
| --- | --- |
| 3a | done. TS: `PluginStepSchema`, `PLUGIN_REF`, `FILLING_STEP_TYPES`; coverage and validation count plugin steps; shared fixture `packages/shared/test/fixtures/plugin-steps.json`. Worker: `template.PluginStep`, `filling_steps`; `plugins.py` (`Plugin`, `PluginContext`, `resolve_plugins`, `PLUGINS`, `text.pattern@1`); `template_pipeline.run_plugin_step`. Web: `stepKind`, `PluginStepDetail` (read-only, edited in YAML) on the Pipeline tabs, step cards and proposal chips. |
| 3b | — |
| 3c | — |
| 3d | — |
