# Value nodes: mapping a value to a node of a class

**Status:** implemented · 2026-10-18 (plan: [value nodes](../superpowers/plans/2026-10-18-value-nodes.md)) · follows [Proposing ontology mappings automatically](mapping-automation.md)
("The measurement pattern: class-centric ontologies") · extends [ADR 0011](../adr/0011-rdf-publishing-and-ontologies.md)

A recipe's `semantics` can publish a field or column as a literal, an entity (`object`) or a SKOS
concept (`concepts`). None of them can say what class-centric ontologies such as AFO and OBI need:
*a node of class X that carries the value*. This document adds that as a fourth form, `node`, with
recipe-level defaults so that a measurement column usually needs only its class.

```yaml
water_content_kf:
  property: obo:OBI_0000299          # the link from the row (optional: semantics.valueNodes.link)
  node:
    class: afr:AFR_0002445           # the node's class: the meaning
    value: qudt:numericValue         # the property holding the value (optional: valueNodes.value)
    unit: unit:PERCENT               # a fixed unit IRI (optional)
```

renders, for row 3 of a document:

```turtle
<…/doc/{sha256}/covalidation/appearance_water_content_table/3>
    obo:OBI_0000299 <…/doc/{sha256}/covalidation/appearance_water_content_table/3/water_content_kf> .

<…/doc/{sha256}/covalidation/appearance_water_content_table/3/water_content_kf>
    a afr:AFR_0002445 ;
    qudt:numericValue 0.4 ;
    qudt:unit unit:PERCENT ;
    ct:output "appearance_water_content_table.water_content_kf" .
```

## 1. Why

On the covalidation gold (a stability report, 46 columns, AFO and OBI pinned; results in the
mapping spike, PR #239), every model tried, the local `qwen3.8-27b-mtp`, Nemotron 3.5 Super and
Qwen 3.8 Flash Next, scored **0 of 35** on class with the per-output matcher, and the current stage
got 10 of 35 (only the identifier columns, as entities). AFO and OBI put the meaning in classes
(*water mass fraction*, *assay result*, *dissolved percentage*, *elapsed time*, *count*) and offer
only generic relations as properties (*has specified output*, *has value*). The format offers a
property plus a literal, or an entity minted once per *distinct value* (every row reading 99.1
would share one "99.1" entity), so no matcher can give the right answer. The gold's own comment
says `as: entity` "is the closest the current mapping format comes to a node of that class".

The fix is in the format, not the matcher. With it, mapping a measurement column is mostly
choosing a class, which retrieval already does well for exact and near labels.

## 2. Decisions this design works within

Taken by the user; not reopened here.

1. **`node` is a fourth form** beside literal, `object` (entity) and `concepts`. Additive: every
   existing mapping parses, validates and renders exactly as before.
2. **Recipe-level defaults** in `semantics` for the link property, the value property and the unit
   property. An output's own values override them.
3. **Stable minted IRIs, not blank nodes**, scoped to the row or the document, so re-minting, graph
   versions and withdrawal keep working.
4. **Units are a fixed IRI per output** for now. A unit read from another column is later work.
5. **Out of scope:** one column holding two quantities (covalidation's storage condition, "25
   °C/60% RH"). It stays unmapped, or the recipe splits it into two outputs.

## 3. The format

### 3.1 Schema (`packages/shared/src/template.ts`, `worker/src/ingest_worker/template.py`)

A cross-language contract (CLAUDE.md, "Template format"): both sides change in one PR and the
shared fixture `packages/shared/test/fixtures/template-semantics.json` holds them in step.

TypeScript:

```ts
/** A value node's own terms; anything left out comes from `semantics.valueNodes`. */
export const NodeMappingSchema = z
  .object({
    /** The node's class: what the value is (e.g. a water mass fraction). */
    class: TermRef,
    /** The property from the node to the value (absent: `valueNodes.value`). */
    value: TermRef.optional(),
    /** A fixed unit IRI (e.g. `unit:PERCENT`); absent: no unit. */
    unit: TermRef.optional(),
    /** The property from the node to its unit (absent: `valueNodes.unitProperty`). */
    unitProperty: TermRef.optional(),
  })
  .strict();

export const OutputMappingSchema = z
  .object({
    /** The property from the document or row; for a node, its link (absent: `valueNodes.link`). */
    property: TermRef.optional(),
    object: …,     // unchanged
    concepts: …,   // unchanged
    /** The value sits on a node of a class, minted per row (or per document for a field). */
    node: NodeMappingSchema.optional(),
  })
  .strict();

/** What every value node uses unless its output says otherwise. */
export const ValueNodeDefaultsSchema = z
  .object({ link: TermRef.optional(), value: TermRef.optional(), unitProperty: TermRef.optional() })
  .strict();

// SemanticsSchema gains:
    valueNodes: ValueNodeDefaultsSchema.optional(),
```

Python mirrors it: `NodeMapping` (`class_` alias `class`, `value`, `unit`, `unit_property` alias
`unitProperty`), `OutputMapping.property: str | None` and `node: NodeMapping | None`,
`ValueNodeDefaults`, `Semantics.value_nodes` (alias `valueNodes`, default `None`).

The defaults are called `valueNodes`, not `defaults` or `link`, because they apply to node-form
outputs only and must not be read as the table `link` (document → row).

**Resolution**, one function per side, used by every consumer (renderer, validation, SHACL
output lookup, the editor, the evaluation harness) so they cannot disagree:

```ts
/** A node-form output's effective terms; null for any other form. */
export function resolveNode(semantics: Semantics, m: OutputMapping):
  { link?: string; class: string; value?: string; unit?: string; unitProperty?: string } | null
```

Python: `Semantics.resolve_node(m) -> ResolvedNode | None`. The output's own term wins, else the
`valueNodes` default. A second shared fixture, `packages/shared/test/fixtures/value-nodes.json`
(a `semantics` block and, per output path, the expected resolution), is run by both suites.

### 3.2 Rules (both sides: `TemplateSchema.superRefine`, `Template._semantics_errors`)

The same wording on both sides, each prefixed `semantics: <field | column>: ` in that side's
existing quoting (TS `field "x"`, Python `field 'x'`); the shared fixture checks validity:

| Case | Message |
| --- | --- |
| no `property` and no `node` | `a property is required` |
| `node` with `object` or `concepts` | `a value node cannot also be an entity or concepts` (the existing `map it to an entity or to concepts, not both` stays as is) |
| `node`, no `property`, no `valueNodes.link` | `a value node needs a link: give its property or set semantics.valueNodes.link` |
| `node`, no `node.value`, no `valueNodes.value` | `a value node needs a value property: give node.value or set semantics.valueNodes.value` |
| `node.unit`, no `node.unitProperty`, no `valueNodes.unitProperty` | `a unit needs a unit property: give node.unitProperty or set semantics.valueNodes.unitProperty` |
| `node` on a `list` output | `a list cannot be a value node: map its items as literals, entities or concepts` |

`valueNodes` set but used by no output is not an error (the stage may propose it first).

`property` becomes optional in the type, so every reader that assumed it (`uses()` in
`semantics.ts`, `shacl.outputs_by_property`, `rdf._Renderer.field/table`,
`mapping_stage._compact_terms`, `mapping_eval.picks_from_body`, the Mapping editor) goes through
`resolveNode`/`linkOf` instead of `m.property`. A non-node mapping without a property is refused by
the rule above, so after validation `property` is only ever absent on a node.

### 3.3 Value types

| Output type | Node value |
| --- | --- |
| `integer`, `decimal`, `date`, `boolean` | typed literal, exactly as `_Renderer.literal` types a plain literal today (`xsd:integer`, `xsd:decimal`, `xsd:date`, `xsd:boolean`) |
| `text`, `enum` | plain string literal |
| `list` | refused (§3.2); see open questions |

The node form never changes the value: the same literal a plain mapping would publish moves onto
the node.

## 4. Rendering (`worker/src/ingest_worker/rdf.py`)

`_Renderer.objects` gains a node branch, before the entity branch. For each non-empty value it:

1. mints the node IRI (§4.1);
2. adds `link → node` from the subject (the document for a field, the row for a column);
3. adds `node a class`, `node value-property literal`, and when a unit is set
   `node unit-property unit`;
4. adds `node ct:output "<field>"` or `"<table>.<column>"`.

**Empty values:** `None`, `""` and `[]` publish nothing: no node, no link, no unit, as a plain
literal publishes nothing today.

**Normalisation failures:** when `facts` falls back to the raw text (a value that failed
normalisation, with its review issue), the node is still minted and carries the raw text as a
plain string literal; the issue goes on the evidence as now (`ct:normalisationIssue`). A shape that
expects `xsd:decimal` on the node then reports it, which is what a reviewer needs to see.

**Evidence:** a field's fact keeps `ct:property` (the link) and `ct:value`, now pointing at the node.
A row's fact is unchanged (one per row).

**Unmapped outputs** keep the recipe's default vocabulary (`def/{type}/{id}`), unchanged.

### 4.1 Node IRIs

Built by one function, `value_node_iri(base, sha256, type_id, output, row)`, beside
`mint_entity_iri`, never from values:

| Output | IRI under the base |
| --- | --- |
| field `f` | `doc/{sha256}/{type}/value/{f}` |
| column `t.c`, row `n` | `doc/{sha256}/{type}/{t}/{n}/{c}` |

- **Always under the document**, even when the row has a readable IRI (`semantics.tables.t.iri`,
  e.g. `batch/{batch_number}`). A readable row is an *entity*: two documents naming the same batch
  share it, and a value node hanging under it would then be shared by two graphs, so replacing or
  withdrawing one document's graph would leave the other's values, or remove them. Scoped to the
  document, a value node lives in exactly one named graph (`graph/source/{sha256}/{type}`), which
  graph replace, withdrawal and retirement already handle.
- **Not entities.** They have no key values, so they are not recorded in `published_entities`
  (ADR 0011 safeguard 2), like the default row IRIs.
- **Stable** across graph versions as long as the row keeps its position, the same stability the
  default row IRIs (`doc/{sha256}/{type}/{t}/{n}`) have today. A review edit that inserts a row
  renumbers both.
- **Re-minting** (`rdf_rebuild --remint`, a base change) re-renders from the reviewed document, so
  node IRIs move with the base like every other IRI. Backfill and republish need nothing new.
- `value/` keeps field nodes apart from tables (field and table ids share one namespace and cannot
  collide; ids start with a letter, rows are numbers).

### 4.2 `ct:output`

Two outputs of one row may rightly share a class (covalidation's `min_percent`, `max_percent` and
`mean_percent` are all *dissolved percentage*). Consumers must not parse IRIs (ADR 0011 safeguard
4), so each node states which output it publishes, in the same plain CT vocabulary as the evidence
nodes. It also lets SHACL results name the output (§5.2). See open question 1 for the better
answer, several classes per node.

## 5. Validation

### 5.1 Against the library (`apps/api/src/templates/semantics.ts`, `semanticsIssues`)

`uses()` lists the node terms with what each must be. Two new `Want`s:

| Term | Path | Must be |
| --- | --- | --- |
| `node.class` | `….node.class` | a class |
| link (`property`, else `valueNodes.link`) | `….property`, `semantics.valueNodes.link` | an object property (`… is a datatype property, not an object property: a value node is reached by an object property`) |
| value (`node.value`, else `valueNodes.value`) | `….node.value`, `semantics.valueNodes.value` | a datatype property (want `value`) |
| unit property | `….node.unitProperty`, `semantics.valueNodes.unitProperty` | an object property |
| `node.unit` | `….node.unit` | an IRI: the CURIE expands and has no unsafe characters. Not looked up: the library does not index individuals, and QUDT units are individuals (`qudt:Unit` instances) |

The defaults are checked where they are written (path `semantics.valueNodes.*`), once, not again
for every output that inherits them. Every issue is blocking, like today's kind mismatches.

**Range warning** (severity `warning`): a value property whose `rdfs:range` is an XSD type that does
not fit the output type (`TYPE_RANGES` of `mapping_match.py`: a `date` output on an `xsd:double`
property). `OntologyRepo.termKinds` returns kinds only, so a second lookup, `termRanges`, reads the
ranges (one query; Memory and Pg). The warning also reads the default value property, at the output's `node.value` path.

**A rdf:Property gotcha:** `ontology._kinds_of` files an `rdf:Property` without a literal range as
an object property. A vocabulary that declares its value property that way would be refused as a
value property; the message says what it is, and a local term (`kind: datatype_property`) is the
way round. Open question 7.

### 5.2 SHACL

Nothing new is needed to *write* shapes: value nodes are typed, so a shape targets the class.

```turtle
ex:WaterContentShape a sh:NodeShape ;
    sh:targetClass afr:AFR_0002445 ;
    sh:property [ sh:path qudt:numericValue ; sh:datatype xsd:decimal ; sh:minCount 1 ; sh:maxCount 1 ] ;
    sh:property [ sh:path qudt:unit ; sh:hasValue unit:PERCENT ] .
```

What changes is naming the output in a result. `shacl.outputs_by_property` maps a result's path
to an output; with nodes, many outputs share one link and one value property, so the path no
longer tells them apart. `Rendering` gains `nodes: dict[str, str]` (node IRI → output path), and
`rdf.validate` takes it: a result whose focus node is a value node names that node's output, before
the path lookup. Review reasons keep their form, `SHACL: <shape> on <output>: <message>`, with the
column now right. The renderer already knows the mapping, so `ct:output` is not read back.

## 6. The mapping stage (`worker/src/ingest_worker/mapping_stage.py`)

### 6.1 Retrieval

`stage_shortlists` gives classes only to the document, tables, enums and text outputs. A
`decimal` column like water content never sees a class candidate: part of the 0/35 is that no
right answer was ever offered. Change: every field and column also gets class candidates (`class`
kind only for non-enum, non-text outputs). A new pseudo-output `#valueNodes` gets property
candidates for fixed queries ("has specified output; has data output; has output", "has value;
numeric value", "has unit; unit"), so the defaults are chosen from the library like any term.

The term budget (`MAX_MAPPING_TERMS` 300, `_cap`) is shared. Covalidation's 46 columns at 15
properties and 8 classes each come to about 1,050 before the cap. For numeric and date outputs the
property shortlist drops to 5 (their link normally comes from `valueNodes`) and classes rise to
10, about 700 for covalidation; the cap then keeps the best-scoring. Measure recall@k of the gold
classes with the harness before and after (§8) before tuning either number.

### 6.2 The answer (`MAPPING_SCHEMA`)

No union types (the Anthropic structured-output limit of 16 union-typed parameters; a test over
every stage schema already guards it): new keys are plain strings with `""` meaning unused.

- `valueAs` enum gains `"node"`.
- New change keys `nodeClass`, `nodeValue`, `nodeUnit`, `nodeUnitProperty` (`""` when unused).
- `setDocumentMapping` uses new keys `valueLink`, `valueProperty`, `unitProperty` for
  `semantics.valueNodes` (`""` = leave as is).

The typed change `setDocumentMapping` gains an optional `valueNodes`
(`packages/shared/src/drafting.ts` `DraftChangeSchema`, `draft_changes._apply_mapping`; shared
fixture `draft-changes.json` gets a case). Applying one without `valueNodes` leaves the draft's
defaults alone, so older proposals apply as before. `putFieldMapping`/`putTableMapping` carry
`OutputMappingSchema`, which already gains `node`.

### 6.3 `convert_mapping`

- `valueAs: node`: `nodeClass` goes through `term()` (shortlist, searches or local terms) and must
  be of kind `class` (the stage's first kind check, from the candidate's `kind`).
- `property` may be `""` for a node when a link is known (this answer's `valueLink` or the draft's
  `valueNodes.link`); otherwise `a value node needs a link: give its property or set valueLink on setDocumentMapping`.
- `nodeValue`, `nodeUnitProperty`: `""` inherits, else `term()`; neither anywhere is an error.
- `nodeUnit` is not in any shortlist (units are not indexed). It must expand to an IRI under the
  QUDT unit namespace (`http://qudt.org/vocab/unit/`) or a declared local term, have no unsafe
  characters, and have a unit property. Such a change is capped at `medium` confidence and its card
  says the unit was not checked against the library. The namespace joins `used_namespaces`, so the
  document change declares `unit:`.
- A node on a `list` output is refused with the schema's message.
- Columns still follow their table (`map table … first`).
- `_compact_terms` compacts the node's terms and the `valueNodes` defaults.

### 6.4 The prompt (`MAPPING_INSTRUCTIONS`)

Added to the `putFieldMapping` bullet:

> - node: the value is a measurement or result of a kind the ontology names as a class (water
>   content, assay, elapsed time, count). nodeClass is that class; the value sits on a node of it.
>   property is the link from the document or row to the node, nodeValue the property holding the
>   value, nodeUnit a QUDT unit when the value has one (unit:PERCENT, unit:MIN). Leave property,
>   nodeValue and nodeUnitProperty "" to use the recipe's value-node defaults.
>
> When an ontology's properties are generic relations (has output, has value) and its classes carry
> the meaning, prefer node over a literal with a generic property. Set the defaults once on
> setDocumentMapping: valueLink, valueProperty and unitProperty.

Plus one worked line in the examples: a decimal "water content (% w/w)" column as
`valueAs: node, nodeClass: <the water mass fraction class>, nodeUnit: unit:PERCENT`.

### 6.5 The per-output matcher (`worker/src/ingest_worker/mapping_match.py`)

The spike's matcher picks a property first and derives the form from its range, so it never
chooses a class for a value. It gains a node path:

1. **Value-node defaults first** (after the document class): re-rank the `#valueNodes` candidates
   and ask one question for `link`, `value` and `unitProperty` (each: an option or none).
2. **Mixed options per output** when a link and a value property were chosen: up to 4 classes and
   3 properties, plus none. A class option reads `class: <label> (subclass of …) - publish the
   value on a node of this class`; a property option as today. For integer, decimal and date
   outputs the classes are listed first. The pick's kind decides the form: a class → `node`
   (`Pick.term` = the chosen link, `entity_class` = the class), an object property → entity (as
   now), else a literal.
3. **The subclass rule** (`_specific`) applies to node classes too: a parent picked over an offered
   exact-label subclass becomes the subclass, at medium confidence.
4. **Units are not asked** in this version (the gold does not score them); the stage proposes them.

`Pick.entity_class` is documented as "the class of the node the value sits on: an entity's or a
value node's", so `mapping_eval._chosen_class` needs no change.

## 7. The Mapping editor (`apps/web`)

Built on the outline-and-editor layout of PR #241 (Value as is a Literal / Entity / Concept switch),
whichever lands first; the changes below are the same either way.

- **Value as** gains **Node** (a fourth segment; the `<select>` gains `a node` if #241 has not
  landed). Switching to it keeps the property, drops `object`/`concepts`, and opens:
  - **Node class**, with *Find a class*;
  - **Value property**, with *Find a property*; empty shows the recipe default as its placeholder
    (`qudt:numericValue · recipe default`);
  - **Unit**, a CURIE or IRI (`unit:PERCENT`), with the hint *A QUDT unit; not checked against the
    library*;
  - **Unit property**, shown once a unit is set, placeholder the default.
  - The **Property** field is labelled **Link property** for a node, and may be left empty when the
    recipe has a default (placeholder `obo:OBI_0000299 · recipe default`).
- **Setup** (Ontologies, Shapes, Prefixes, Document) gains **Value nodes**: link, value property and
  unit property, each with *Find a property*, and the one-line hint *Used by every output mapped
  as a node unless it gives its own*.
- **Outline status:** a node output reads as mapped and shows its class's label, not the link
  (the class is the meaning; the link is usually the shared default).
- **Proposal cards** (`apps/web/src/workbench/mapping.ts`): a node change reads `Node: <class
  label> · value <property> · unit <unit>`, with the class's alternatives as today.
- **Help:** `MappingHelp` gains a *Value nodes* part (what a node is, when to prefer it, the
  defaults, units). No new topic, so `HELP_INDEX` is unchanged.
- **UI words** say recipe, not template (*recipe default*).

## 8. Evaluation harness and gold

`worker/src/ingest_worker/mapping_eval.py`:

- `ValueAs` and `VALUE_AS` gain `"node"`; a gold answer may give `as` as a list
  (`as: [node, entity]`) when either form is right.
- `picks_from_body` reads node mappings: `value_as = "node"`, `term` = the resolved link,
  `entity_class` = `node.class` (via `resolve_node`, so `valueNodes` defaults count).
- `gold_template` prints a node pick as `{term: <link>, as: node, class: <class>}`.
- The report's *as* and *class* columns need nothing new.

`docs/design/mapping-gold/covalidation.yaml` moves per-row results to `as: node`:

| Columns | Gold |
| --- | --- |
| water content (KF, NIR), assay, degradation products, total degradation products, dissolution mean/min/max %, solid state NIR %, storage time, dissolution time point, microbial counts, appearance, E. coli pass/fail, batches' sequence | `{term: any, class: …, as: node}` |
| batch number, study id, internal code, packaging | `as: entity`, unchanged: identifiers and container types are things shared across documents, so one entity per value is the point (joins between reports) |
| storage condition, the `<` qualifier columns | `unmapped`, unchanged |

What we expect to learn: class accuracy on measurement columns with the local model, now that a
class can be both offered (§6.1) and expressed. A per-output matcher that reaches half of the 35
classes with a high tier of 95% precision would meet the spike's decision gate in substance, not
just by the letter of Hit@1.

## 9. A worked example: covalidation

Two of the six results tables, mapped with the node form. Class labels are the gold's; `# CHECK`
marks what a domain expert or a look-up must confirm.

```yaml
semantics:
  ontologies: [{ id: afo, version: 1 }, { id: obi, version: 1 }]
  prefixes:
    afr: http://purl.allotrope.org/ontologies/result#
    afre: http://purl.allotrope.org/ontologies/realizable#
    afx: http://purl.allotrope.org/ontologies/property#   # CHECK: the AFX namespace
    obo: http://purl.obolibrary.org/obo/
    qudt: http://qudt.org/schema/qudt/
    unit: http://qudt.org/vocab/unit/
  document: { class: afr:AFR_0003368 }                    # study document (gold alternative: IAO report)
  valueNodes:
    link: obo:OBI_0000299                                 # has_specified_output
    value: qudt:numericValue
    unitProperty: qudt:unit
  tables:
    assay_chromatographic_purity_table:
      link: obo:BFO_0000051                               # CHECK: has part (document -> row)
      class: afre:AFRE_0000021                            # study point (gold: CHECK)
      columns:
        # batch_number, study_id: entity form, as today
        storage_time_months: { node: { class: afr:AFR_0002050, unit: unit:MO } }   # elapsed time; CHECK unit:MO (month)
        assay: { node: { class: afr:AFR_0000207, unit: unit:PERCENT } }            # assay result
        degradation_product_specified: { node: { class: afr:AFR_0002099, unit: unit:PERCENT } }  # mass fraction
        degradation_product_unspecified: { node: { class: afr:AFR_0002099, unit: unit:PERCENT } }
        total_degradation_products: { node: { class: afr:AFR_0002099, unit: unit:PERCENT } }
        # storage_condition and the *_below_threshold qualifiers: unmapped
    dissolution_results_table:
      link: obo:BFO_0000051
      class: afre:AFRE_0000021
      columns:
        time_point_min: { node: { class: afr:AFR_0002050, unit: unit:MIN } }       # elapsed time
        mean_percent: { node: { class: afr:AFR_0003173, unit: unit:PERCENT } }     # dissolved percentage
        min_percent: { node: { class: afr:AFR_0003173, unit: unit:PERCENT } }      # see open question 1
        max_percent: { node: { class: afr:AFR_0003173, unit: unit:PERCENT } }
    microbial_purity_table:
      link: obo:BFO_0000051
      class: afre:AFRE_0000021
      columns:
        t_amc_count: { node: { class: afr:AFR_0000984 } }                          # count; CHECK: no QUDT unit for CFU/g
        ecoli_pass_fail:
          node: { class: afr:AFR_0001991, value: afx:AFX_0000690 }                 # conformance assessment; CHECK: a text value property
```

Each measurement column is one line: its class and, where it has one, its unit. The link, value
and unit properties are written once. Row 2 of the dissolution table renders as:

```turtle
@prefix afr:  <http://purl.allotrope.org/ontologies/result#> .
@prefix afre: <http://purl.allotrope.org/ontologies/realizable#> .
@prefix obo:  <http://purl.obolibrary.org/obo/> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix ct:   <https://id.stocks-hayward.com/ns/ct#> .
@prefix r:    <https://data.example/ct/doc/9f3c…/covalidation/dissolution_results_table/> .

<https://data.example/ct/doc/9f3c…> obo:BFO_0000051 r:2 .

r:2 a afre:AFRE_0000021 ;
    obo:OBI_0000299 <…/2/time_point_min>, <…/2/mean_percent>, <…/2/min_percent>, <…/2/max_percent> ;
    <https://data.example/ct/def/covalidation/dissolution_results_table.storage_condition> "25 °C/60% RH" .

<…/2/time_point_min> a afr:AFR_0002050 ; qudt:numericValue 30 ; qudt:unit unit:MIN ;
    ct:output "dissolution_results_table.time_point_min" .
<…/2/mean_percent> a afr:AFR_0003173 ; qudt:numericValue 98.2 ; qudt:unit unit:PERCENT ;
    ct:output "dissolution_results_table.mean_percent" .
<…/2/min_percent> a afr:AFR_0003173 ; qudt:numericValue 96.0 ; qudt:unit unit:PERCENT ;
    ct:output "dissolution_results_table.min_percent" .
<…/2/max_percent> a afr:AFR_0003173 ; qudt:numericValue 99.5 ; qudt:unit unit:PERCENT ;
    ct:output "dissolution_results_table.max_percent" .
```

(`<…/2/x>` abbreviates `r:2/x`; the batch number's entity triples and the evidence node are left
out.) A SPARQL consumer asks for dissolved percentages by class and joins to the batch through the
row, without knowing CT Studio's column names.

## 10. Compatibility

- **Additive.** New keys are `.optional()` with no `.default()` in Zod and `None` in Pydantic, so
  parsing a recipe without them gives back the same object. Everything that hashes or compares a
  definition is therefore unchanged for existing recipes: the publish gate's snapshot comparison
  (`stableJson`), the GitHub sync's `definitionSha256` (`definitionCanonical`), the change log's
  "nothing changed" (`describeDefinitionChange` count 0), the Workbench list fingerprints.
- **The step cache** never sees `semantics` (its key covers rendered prompts, schema, models; ADR
  0011: a mapping never changes extraction prompts), so it is untouched by construction.
- **Graphs of existing recipes are byte-identical**: the node branch runs only for a `node`
  mapping. A golden-Turtle test pins it (§11).
- **Older deployments refuse** a recipe, bundle or `ct-recipe` file that uses `node` or
  `valueNodes` (strict schemas), as with earlier additive keys (`completedStages`, `seenIn`). The
  `ct-recipe` `formatVersion` stays 1.
- **Moving a published type to nodes** is a new recipe version. Its next publish of a document
  replaces the graph (a new graph version); the old literal triples go with the old version.
  Shapes written for the old properties need updating in the same version.
- **Retirement, withdrawal, republish, rebuild**: value nodes live only in their document's named
  graph, and nothing about them is stored elsewhere.

## 11. Test plan (tests first)

Each item is written and seen failing before the code it covers (CLAUDE.md, TDD).

**Shared fixtures (both suites read them):**
- `template-semantics.json` cases: valid node with defaults; valid node with its own terms and no
  defaults; `valueNodes` alone; invalid: node + object, node + concepts, node without link,
  without value property, unit without unit property, node on a list, non-node without property,
  an unknown key in `node` and in `valueNodes`.
- `value-nodes.json`: per output, the resolution (`resolveNode` / `Semantics.resolve_node`),
  including an output overriding one default.
- `draft-changes.json`: `setDocumentMapping` with `valueNodes`; one without it leaving existing
  defaults; a `putTableMapping` whose column is a node.

**TypeScript** (`packages/shared/test/template.test.ts`, `drafting.test.ts`; `apps/api/test/semantics.test.ts`; `apps/web/test/MappingEditor.test.tsx`):
- parse(old definition) deep-equals the input for every fixture recipe with semantics, and the
  `definitionCanonical` hash of one pinned recipe is unchanged;
- `semanticsIssues`: node class not a class; link a datatype property; value an object property;
  unit property a datatype property; unit with an undeclared prefix; issues on `valueNodes.*` paths
  reported once; range warning for a date output on an `xsd:double` value property;
- the editor: Node segment shows Class, Value property, Unit; empty value property shows the
  default; switching to Node keeps the property and drops `object`; Value nodes in Setup saves
  `semantics.valueNodes`; the outline shows the node's class; a proposal card describes a node.

**Python** (`worker/tests/`):
- `test_template.py`: the fixture cases; `resolve_node`;
- `test_rdf.py` (table-driven): a decimal, integer, date, boolean and text column as nodes; unit
  present and absent; empty value → no node and no link; normalisation failure → raw literal on
  the node plus the evidence issue; a field node's IRI and evidence `ct:value`; a row with a
  readable IRI still scopes its nodes under `doc/{sha256}`; `ct:output`; node IRIs follow the base;
  the golden Turtle of an existing recipe's graph is unchanged;
- `test_shacl.py`: a class-targeted shape on a value node; a result names the column via the focus
  node when two columns share the link and value properties;
- `test_mapping_stage.py`: `MAPPING_SCHEMA` still has no unions; `valueAs: node` with `""` property
  and `valueLink` set converts; without a link it is refused with the schema's message; a node class
  that is a property is refused; a unit outside the QUDT namespace is refused, inside it is kept at
  most medium; numeric columns get class candidates; `#valueNodes` candidates exist; the prompt
  mentions node;
- `test_draft_changes.py`: the fixture; `test_mapping_match.py`: defaults asked once; mixed options;
  a class pick becomes `node` with `entity_class`; the subclass rule on node classes;
- `test_mapping_eval.py`: `as: node` and `as: [node, entity]` in a gold; a node pick scores value-as
  and class; `gold_template` prints a node.
- `test_rdf_rebuild.py`: a remint moves node IRIs to the new base.

`npm run check` green, and both contract suites (`spec-registry.test.ts`, `test_specs.py`) load
every spec as before.

## 12. Open questions

1. **Several classes per node.** Mean, minimum and maximum dissolved percentage share one class;
   AFO also has *minimum value* and *maximum value*. `class` could take a list
   (`a afr:DissolvedPercentage, afr:MaximumValue`). Until then `ct:output` tells them apart.
   Worth it now, or after the gold run shows how often it matters?
2. **Qualifiers.** Covalidation's `*_below_threshold` columns qualify a value ("<0.05"). A
   `node.qualifier` (a property and the column it reads) would put them on the same node. Later,
   with units from another column (decision 4), since both read a sibling column.
3. **Lists.** Refused for now. One node per item (`…/{c}/{k}`) is easy if a real recipe needs it.
4. **A concept as the node's value** (an enum result such as pass/fail linked to a concept, on a
   node of class *conformance assessment*). The node form could later accept `concepts` beside it.
5. **Indexing individuals** (a term kind `individual`), so QUDT units can be searched, picked and
   checked like terms, and the stage's unit rule (§6.3) becomes the shortlist rule.
6. **Per-cell evidence.** A row has one evidence node; a value node could carry its own page and
   quote. Not needed for the mapping, but nodes make it natural.
7. **Value properties declared as plain `rdf:Property`** are indexed as object properties when they
   name no literal range (§5.1). Fix the indexer (no range: kind unknown) or accept any property as
   a value property with a warning?
8. **AFO's text value property.** The example uses `afx:AFX_0000690` for a text result, the generic
   literal property the per-output matcher chose in PR #239; its label and range need looking up
   before the gold relies on it.
