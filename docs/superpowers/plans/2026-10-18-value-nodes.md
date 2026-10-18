# Value Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipe can map a field or column as a **value node**: a minted node of a chosen class carrying the value (and optionally a fixed unit), with recipe-level `semantics.valueNodes` defaults for the link, value and unit properties. The Workbench mapping stage, the per-output matcher and the evaluation harness can propose and score it.

**Architecture:** An additive fourth form in the template contract (`OutputMapping.node`, `Semantics.valueNodes`, one resolver per side), rendered by the worker under the document's own IRI space (`value_node_iri`), validated by the API against the ontology library, named in SHACL results by focus node, proposed by the mapping stage through flat string keys (no unions), and edited in the recipe's Mapping tab.

**Tech Stack:** Zod (`packages/shared`), Fastify API (`apps/api`), Pydantic + rdflib + pySHACL (`worker`), React (`apps/web`).

**Spec:** [docs/design/value-node-mapping.md](../../design/value-node-mapping.md) (PR #242).

## Global Constraints

- **One branch, one PR** for the whole feature (CI is slow); no side sessions. Never enable auto-merge: a merge redeploys staging and stops its workers. The user merges.
- TDD per CLAUDE.md: a failing test first for every behaviour, run and seen failing for the expected reason; never weaken a test. Unit tests stay offline (MemoryRepo, `MemoryOntologyStore`, `FakeProvider`, `FakeGraphStore`).
- **Cross-language contract** (template format; drafting changes): TS and Python change in this PR together, held in step by shared fixtures run in both suites.
- **Additive:** new keys are `.optional()` with **no `.default()`** in Zod, `None` in Pydantic. A recipe without them parses to the same object, hashes the same and renders byte-identical Turtle.
- No union types in any stage schema (`MAPPING_SCHEMA`): new keys are strings, `""` = unused.
- UI text says **recipe**, never template. Help changes go into the existing `MappingHelp` body (no new topic, so `HELP_INDEX` is unchanged; if a new topic is added after all, it needs its `HELP_INDEX` entry).
- No new routes and no migration are expected. If one appears, it follows CLAUDE.md (documented route; `YYYYMMDDHHMM_*.sql`).
- `npm run check` green and `npm run worker:test`/`worker:lint` green before declaring done.

## Corrections to the design found while planning

1. **Messages are not character-identical across sides.** The existing rules already quote ids differently (TS `field "x"`, Python `field 'x'` via `repr`). New messages follow each side's convention; the shared fixture checks validity (`valid: true|false`), as today. (The design's §3.2 now says so.)
2. **`term()` in `convert_mapping` now takes a kind** (PR #239, implied local terms). Node terms pass `class` (node class), `object_property` (link, unit property) and `datatype_property` (value property), so an implied local term gets the right kind.
3. **`graph_preview` calls `render_graph`**, which drops the rendering's extras; it moves to `render()` to get `Rendering.nodes` for SHACL naming.
4. **`picks_from_body` needs the defaults**: a node change may leave `property` empty, so it reads `valueNodes` from the answer's `setDocumentMapping` change, else the draft's `semantics.valueNodes` (new parameter).

## Review Focus

1. **Existing recipes unchanged.** The golden-Turtle test (Task 0) and the hash test (Task 0) must pass untouched at the end. Any diff there is a bug, not a fixture update.
2. **`property` is optional now.** Every reader goes through `linkOf`/`link_of`. A non-node mapping without a property must be refused by validation on both sides before any renderer sees it (Task 1 fixture case, Task 2 sweep).
3. **Node IRIs scope to the document even under a readable row IRI** (two documents naming the same batch never share a value node) → Task 3 test `value_nodes_scope_to_the_document_under_a_readable_row`.
4. **SHACL names the right column** when several columns share the link and value property → Task 4 test.
5. **`MAPPING_SCHEMA` stays union-free** → the existing all-stage-schemas union test plus Task 7's new assertions.

---

## File structure

```
packages/shared/src/template.ts                      NodeMappingSchema, ValueNodeDefaultsSchema, OutputMapping.property optional, node; Semantics.valueNodes; rules; resolveNode, linkOf
packages/shared/src/drafting.ts                      setDocumentMapping.valueNodes (optional); applyChanges
packages/shared/test/fixtures/template-semantics.json new cases
packages/shared/test/fixtures/value-nodes.json       NEW: resolution per output, both suites
packages/shared/test/fixtures/draft-changes.json     setDocumentMapping with/without valueNodes; a node column
packages/shared/test/template.test.ts                fixture runs, resolveNode, parse identity + hash
apps/api/src/templates/semantics.ts                  node uses, new Wants, defaults paths, range warning
apps/api/src/ontologies/repo.ts                      termRanges (Memory + Pg)
apps/api/test/semantics.test.ts                      node validation cases
worker/src/ingest_worker/template.py                 NodeMapping, ValueNodeDefaults, Semantics.value_nodes, resolve_node, link_of, rules
worker/src/ingest_worker/rdf.py                      value_node_iri, node branch, ct:output, Rendering.nodes, validate(nodes=)
worker/src/ingest_worker/shacl.py                    outputs_by_property via link_of
worker/src/ingest_worker/template_pipeline.py        pass rendering.nodes to validate
worker/src/ingest_worker/graph_preview.py            render() instead of render_graph(), nodes to validate_with_timeout
worker/src/ingest_worker/draft_changes.py            setDocumentMapping.valueNodes
worker/src/ingest_worker/mapping_stage.py            shortlists (classes for every output, #valueNodes), MAPPING_SCHEMA, convert_mapping, prompt, _compact_terms
worker/src/ingest_worker/mapping_match.py            value-node defaults question, mixed options, node picks
worker/src/ingest_worker/mapping_eval.py             as: node (and lists), picks_from_body(defaults), gold_template
worker/tests/fixtures/rdf/letter-graph.ttl           NEW: golden Turtle of an existing recipe's graph
worker/tests/test_template.py, test_rdf.py, test_shacl.py, test_graph_preview.py, test_draft_changes.py,
             test_mapping_stage.py, test_mapping_match.py, test_mapping_eval.py, test_rdf_rebuild.py
apps/web/src/templates/MappingEditor.tsx             Node form, Value nodes in setup, outline status
apps/web/src/workbench/changes.ts, mapping.ts         node change and mapping text
apps/web/src/help/MappingHelp.tsx                    Value nodes part
apps/web/test/MappingEditor.test.tsx, MappingTab.test.tsx (and the changes test)
docs/design/mapping-gold/covalidation.yaml           as: node for per-row results
docs/design/value-node-mapping.md, rdf-publishing.md, mapping-automation.md, docs/consumers/sparql.md, CLAUDE.md
```

---

### Task 0: Safety net (characterisation, before any change)

These pass on today's code. They pin behaviour that must not move.

**Files:** create `worker/tests/fixtures/rdf/letter-graph.ttl`; modify `worker/tests/test_rdf.py`, `packages/shared/test/template.test.ts`.

- [ ] Branch from `main` (after #239, and after #242 if merged): `claude/value-nodes`.
- [ ] `test_rdf.py::test_an_existing_recipe_renders_byte_identical_turtle`: render the module's full-mapping recipe (entities, concepts, a table with a readable row IRI, an unmapped output, evidence) to Turtle with `to_turtle`, compare with the fixture file. Generate the fixture once from current code (a helper guarded by `IH_REGEN_GOLDEN=1`, documented in the test), commit it, and never regenerate it in this PR.
- [ ] `template.test.ts`: for the `full mapping with rdf delivery` case of `template-semantics.json`, `TemplateSchema.parse` output has no `valueNodes` key and no `node` key in any output mapping, and `definitionCanonical(parsed)` (`github-sync.ts`) equals a pinned sha256 computed now.
- [ ] Run: `cd worker && uv run pytest tests/test_rdf.py -k byte_identical` and `npx vitest run packages/shared/test/template.test.ts`, both green. Commit: `Value nodes: pin today's graphs and recipe hashes`.

### Task 1: The contract (both sides)

**Files:** `packages/shared/src/template.ts`, `packages/shared/test/fixtures/template-semantics.json`, new `packages/shared/test/fixtures/value-nodes.json`, `packages/shared/test/template.test.ts`; `worker/src/ingest_worker/template.py`, `worker/tests/test_template.py`.

**Interfaces — Produces:**
- TS: `NodeMappingSchema` `{ class: TermRef, value?, unit?, unitProperty? }` (strict); `OutputMappingSchema.property` optional, `node?: NodeMapping`; `ValueNodeDefaultsSchema` `{ link?, value?, unitProperty? }` (strict); `SemanticsSchema.valueNodes?`; `type ResolvedNode = { link?: string; class: string; value?: string; unit?: string; unitProperty?: string }`; `resolveNode(semantics, m): ResolvedNode | null`; `linkOf(semantics, m): string | undefined` (a node's resolved link, else `m.property`).
- Python: `NodeMapping` (`class_` alias `class`, `value`, `unit`, `unit_property` alias `unitProperty`), `ValueNodeDefaults` (`link`, `value`, `unit_property`), `OutputMapping.property: str | None`, `.node: NodeMapping | None`, `Semantics.value_nodes` (alias `valueNodes`), `ResolvedNode` (frozen dataclass), `Semantics.resolve_node(m)`, `Semantics.link_of(m)`.

- [ ] **Red:** add `template-semantics.json` cases (both suites already iterate the file):
  valid: `a node with the recipe's defaults` (column `qty` as `{ node: { class: acme:Quantity } }`, `valueNodes: { link, value }`), `a node with its own terms and no defaults`, `defaults alone`, `a node with a unit and a default unit property`;
  invalid: `node and object`, `node and concepts`, `a node without a link`, `a node without a value property`, `a unit without a unit property`, `a node on a list` (add a `list` field to `base`… or patch one in), `a literal without a property`, `an unknown key in node`, `an unknown key in valueNodes`.
- [ ] **Red:** `value-nodes.json`: `{ semantics, expected: { "<path>": ResolvedNode | null } }` with an output overriding `value` only, one overriding `property`, one non-node (`null`). Test in `template.test.ts` (`resolveNode`) and `test_template.py` (`resolve_node`, `link_of`), both reading the same file.
- [ ] Run both, see the new cases fail (schemas refuse `node`/`valueNodes` as unknown keys, so the *valid* cases fail; the resolver tests fail on import).
- [ ] **Green:** schemas and rules. In `TemplateSchema.superRefine` `mapping()` and `Template._semantics_errors.mapping()`, after the existing object+concepts rule:
  `a property is required` (no property, no node) · `a node cannot also be an entity or concepts` · `a node needs a link: give its property or set semantics.valueNodes.link` · `a node needs a value property: give node.value or set semantics.valueNodes.value` · `a unit needs a unit property: give node.unitProperty or set semantics.valueNodes.unitProperty` · `a list cannot be a value node: map its items as literals, entities or concepts`. Prefix and quoting as each side's existing messages.
- [ ] Task 0 tests still green. Run: `npx vitest run --project shared`, `cd worker && uv run pytest tests/test_template.py`. Commit: `Value nodes: the node form and valueNodes defaults in the recipe contract`.

### Task 2: `property` is optional: every reader resolves it

Typecheck finds the TS readers; grep finds the Python ones (`\.property\b`, `["property"]`).

**Files:** `apps/api/src/templates/semantics.ts` (`uses()`), `apps/web/src/workbench/changes.ts` (`mappingText`), `apps/web/src/workbench/mapping.ts` (line ~61), `apps/web/src/templates/MappingEditor.tsx` (`set`, the Property field), `worker/src/ingest_worker/shacl.py` (`outputs_by_property`), `worker/src/ingest_worker/rdf.py` (`field`, `table`), `worker/src/ingest_worker/mapping_stage.py` (`_compact_terms`, `meta` chosen sets), `worker/src/ingest_worker/mapping_eval.py` (`picks_from_body`).

- [ ] **Red:** `test_shacl.py::test_outputs_by_property_takes_a_nodes_default_link` (a node column without `property` maps `valueNodes.link` → the column); `changes.test` (or the existing web test for `describeChange`): a node mapping without property reads its class, not `undefined`.
- [ ] **Green:** route each through `linkOf`/`link_of`. `_compact_terms` compacts `property` only when present, plus `node.class/value/unit/unitProperty`, and a `setDocumentMapping` change's `valueNodes`.
- [ ] `npm run typecheck`, `npm run worker:lint` clean. Commit: `Value nodes: read a mapping's link through one resolver`.

### Task 3: Rendering

**Files:** `worker/src/ingest_worker/rdf.py`, `worker/tests/test_rdf.py`, `worker/tests/test_rdf_rebuild.py`.

**Produces:** `value_node_iri(base, sha256, type_id, output, row: int | None) -> str` (`doc/{sha}/{type}/value/{f}`; `doc/{sha}/{type}/{t}/{n}/{c}`); `Rendering.nodes: dict[str, str]` (node IRI → output path); `CT.output`.

- [ ] **Red** (`test_rdf.py`, table-driven over output types): `value_node_carries_a_typed_literal[integer|decimal|date|boolean|text|enum]`; `a_unit_is_added_only_when_set`; `an_empty_value_publishes_no_node_and_no_link[None|""|[]]`; `a_failed_normalisation_puts_the_raw_text_on_the_node` (plus `ct:normalisationIssue` on the evidence); `a_field_node_is_the_evidence_value`; `value_nodes_scope_to_the_document_under_a_readable_row`; `every_value_node_states_its_output`; `rendering_lists_its_value_nodes`; `node_iris_follow_the_base`. `test_rdf_rebuild.py`: a remint moves node IRIs to the new base.
- [ ] **Green:** a node branch in `_Renderer.objects` before the entity branch (it needs the subject's output path and row: pass them from `field`/`table` through `facts`). It mints the node, adds `a class`, the value literal via `self.literal`, the unit, `ct:output`, and records `self.nodes`. The caller adds `subject link node` as for any object. Not recorded in `entities`.
- [ ] Task 0 golden test green. Run: `uv run pytest tests/test_rdf.py tests/test_rdf_rebuild.py`. Commit: `Value nodes: render a node of a class under the document`.

### Task 4: SHACL names the output by focus node

**Files:** `worker/src/ingest_worker/rdf.py` (`validate(…, nodes: dict[str, str] | None = None)`), `shacl.py` (`validate_with_timeout` passes `nodes` through the child), `template_pipeline.py` (~line 802: `rendering.nodes`), `graph_preview.py` (~line 89: `render()`), `worker/tests/test_shacl.py`, `worker/tests/test_graph_preview.py`.

- [ ] **Red:** `test_shacl.py::test_a_result_on_a_value_node_names_its_column`: two decimal columns sharing link and value property, a shape `sh:targetClass` the first column's class with `sh:maxInclusive`, the violation's `output` is that column; `…::test_a_class_targeted_shape_sees_value_nodes`. `test_graph_preview.py`: a preview's report names the column.
- [ ] **Green:** focus-node lookup first, then the path lookup as today. Thread `nodes` through `validate_with_timeout` (the child gets it as a plain dict).
- [ ] Commit: `Value nodes: SHACL results name the column a node publishes`.

### Task 5: API validation against the library

**Files:** `apps/api/src/templates/semantics.ts`, `apps/api/src/ontologies/repo.ts` (`termRanges` on the interface, `MemoryOntologyRepo`, `PgOntologyRepo`: `SELECT iri, ranges … ` joined as `termKinds`), `apps/api/test/semantics.test.ts`, the Pg ontology integration test (`apps/api/test/integration/ontology-pg.test.ts`) for `termRanges`.

- [ ] **Red** (`semantics.test.ts`): `a node's class must be a class`; `a node's link must be an object property` (datatype → message `… is a datatype property, not an object property: a value node is reached by an object property`); `a value property must be a datatype property`; `a unit property must be an object property`; `a unit must expand and be a valid IRI, and is not looked up`; `defaults are checked once, at semantics.valueNodes.*`; `a value property whose XSD range does not fit the output type is a warning`; `a complete node mapping to a ready ontology has no issues`.
- [ ] **Green:** new `Want`s `link` (object_property), `value` (datatype_property); `uses()` lists node class, a node's own link/value/unit property at the output's path, and the `valueNodes` defaults at their own paths (not again per output); unit checked by `expandTerm` + `IRI_UNSAFE` only. Range warning from `termRanges` with a small TS `XSD_FITS` table (integer, decimal, date, boolean), severity `warning`.
- [ ] Integration test for `termRanges` runs with `IH_TEST_DATABASE_URL` (skips otherwise). Commit: `Value nodes: check node terms against the ontology library`.

### Task 6: The drafting change carries the defaults

**Files:** `packages/shared/src/drafting.ts` (`setDocumentMapping.valueNodes?: ValueNodeDefaults`, `applyChanges`), `packages/shared/test/fixtures/draft-changes.json`, `worker/src/ingest_worker/draft_changes.py`, `worker/tests/test_draft_changes.py`, `apps/web/src/workbench/changes.ts`.

- [ ] **Red:** fixture cases `setDocumentMapping sets the value-node defaults`, `setDocumentMapping without valueNodes keeps the draft's`, `putTableMapping with a node column`; a web test that a node change reads `Node: <class> · value <property> · unit <unit>`.
- [ ] **Green:** apply sets `semantics.valueNodes` only when the change has it (both sides). Commit: `Value nodes: the mapping stage's document change sets the defaults`.

### Task 7: The mapping stage

**Files:** `worker/src/ingest_worker/mapping_stage.py`, `worker/tests/test_mapping_stage.py`.

- [ ] **Red:**
  - shortlists: `every_field_and_column_gets_class_candidates` (a decimal column too: classes only, not concepts or schemes); `numeric_outputs_get_fewer_properties` (5, and 10 classes); `value_node_defaults_get_their_own_candidates` (`#valueNodes`, property kinds, the fixed queries);
  - schema: `valueAs` includes `node`; the new keys (`nodeClass`, `nodeValue`, `nodeUnit`, `nodeUnitProperty`, `valueLink`, `valueProperty`, `unitProperty`) are plain strings; the existing no-unions test still passes;
  - `convert_mapping`: `a_node_with_an_empty_property_takes_the_answers_value_link`; `…takes_the_drafts_value_link`; `a_node_without_any_link_is_refused` (the schema's message); `a_node_class_must_be_a_class_candidate` (a property IRI is refused); `implied_local_node_terms_get_their_kinds` (class / object / datatype property); `a_unit_outside_qudt_units_is_refused`; `a_qudt_unit_is_kept_at_most_medium_and_declares_its_prefix`; `a_node_on_a_list_is_refused`; `set_document_mapping_carries_value_nodes`;
  - prompt: `the_prompt_explains_value_nodes` (mentions `node`, `valueLink`, prefers node over a generic property).
- [ ] **Green:** `stage_shortlists` (classes for every output, numeric 5 + 10, a `#valueNodes` entry; `_cap` unchanged), `MAPPING_SCHEMA`, `output_mapping` node branch, document change `valueNodes`, `MAPPING_INSTRUCTIONS` text from the design §6.4, a `#valueNodes` block in `mapping_context`. `ALTERNATIVES` for a node come from the output's class candidates.
- [ ] Commit: `Value nodes: the mapping stage proposes nodes and their defaults`.

### Task 8: The per-output matcher

**Files:** `worker/src/ingest_worker/mapping_match.py`, `worker/tests/test_mapping_match.py`.

- [ ] **Red:** `value_node_defaults_are_asked_once` (one `ChoiceRequest` with `#valueNodes.link/value/unitProperty`); `outputs_get_classes_and_properties_when_defaults_exist` (≤ 4 classes + ≤ 3 properties; classes first for numeric types; a class option's prompt line says it publishes a node); `a_class_pick_is_a_node` (`value_as == "node"`, `term` = the link, `entity_class` = the class); `the_subclass_rule_applies_to_node_classes`; `without_defaults_outputs_get_properties_only` (today's behaviour).
- [ ] **Green:** a step between the document class and the tables; `_published` learns a class pick. Commit: `Value nodes: the per-output matcher can choose a class`.

### Task 9: Evaluation harness and gold

**Files:** `worker/src/ingest_worker/mapping_eval.py`, `worker/tests/test_mapping_eval.py`, `docs/design/mapping-gold/covalidation.yaml`, `worker/tests/fixtures/mapping-gold/batch-record.yaml` (one node case).

- [ ] **Red:** `a_gold_may_say_as_node`; `as_may_list_several_forms`; `a_node_pick_scores_value_as_and_class`; `picks_from_body_reads_a_node_with_the_answers_defaults` and `…with_the_drafts_defaults`; `gold_template_prints_a_node`.
- [ ] **Green:** `ValueAs`/`VALUE_AS` gain `node`; `Expected.value_as` becomes a frozenset (one or several); `picks_from_body(body, prefixes, defaults=None)` and its callers pass the draft's `semantics.valueNodes`.
- [ ] Gold: per-row results `as: node` per the design §8 table; identifiers stay `as: entity`; header comment updated (the format can now say "a node of that class").
- [ ] Commit: `Value nodes: the evaluation harness and the covalidation gold`.

### Task 10: The Mapping editor and help

Build on whatever `MappingEditor.tsx` is on `main` when this task starts. If PR #241 (outline and editor) has merged, the switch is its Literal / Entity / Concept segmented control and the setup group is its outline. Otherwise it is today's `<select>` and fieldsets. The tests are written against labels and roles, so they read the same either way.

**Files:** `apps/web/src/templates/MappingEditor.tsx`, `apps/web/src/help/MappingHelp.tsx`, `apps/web/test/MappingEditor.test.tsx`, `apps/web/test/Help.test.tsx` if a section heading is asserted.

- [ ] **Red** (Testing Library, by role/label): `Value as Node shows Class, Value property and Unit`; `switching to Node keeps the property and drops the entity`; `an empty value property shows the recipe default as its placeholder`; `the property is labelled Link property for a node and may stay empty with a default`; `Unit property appears once a unit is set`; `Value nodes in the setup saves semantics.valueNodes`; `a node output shows its class in the outline` (or the row legend without #241); `Find a class fills the node's class`.
- [ ] **Green:** the form, with hints in user words (*A QUDT unit; not checked against the library*; *Used by every output mapped as a node unless it gives its own*). `MappingHelp` gains a *Value nodes* part.
- [ ] Commit: `Value nodes: map a node in the recipe's Mapping tab`.

### Task 11: Docs

- [ ] `CLAUDE.md`: the *Template format* row names `node`, `valueNodes`, `resolveNode`/`resolve_node`, `linkOf`/`link_of` and `value-nodes.json`; the *RDF outputs* row names `value_node_iri`, `Rendering.nodes`, `ct:output`, SHACL naming by focus node, `termRanges`; the *Drafting changes* row notes `setDocumentMapping.valueNodes`.
- [ ] `docs/design/rdf-publishing.md` layout: the two value-node paths. `docs/consumers/sparql.md`: a query for values by class with their unit, and that `ct:output` names the column.
- [ ] `docs/design/value-node-mapping.md`: status "implemented".
- [ ] Commit: `Value nodes: docs`.

### Task 12: Verify and hand over

- [ ] `npm run check` green; `npm run worker:test` and `npm run worker:lint` green. Task 0's golden and hash tests unchanged.
- [ ] Open the PR (no auto-merge). The description lists what was verified and what was not (no stack run).
- [ ] **For the user, after merge, on a deployment** (calls the model; not CI): rerun the covalidation gold with the local model and one frontier model:
  `docker cp docs/design/mapping-gold/covalidation.yaml ingestion-worker-1:/tmp/gold.yaml`, then
  `docker exec ingestion-worker-1 python -m ingest_worker.mapping_eval --gold /tmp/gold.yaml` (and `--model <choice>`).
  Add the results to `docs/design/mapping-automation.md` §5. The bar from the design: half of the 35 classes, with a 95%-precision high tier.
