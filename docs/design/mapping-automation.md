# Proposing ontology mappings automatically: research and spike

Mapping a recipe's outputs to ontology terms (the recipe's `semantics`, [ADR 0011](../adr/0011-rdf-publishing-and-ontologies.md))
is today a large manual task, and one people are unlikely to do well: a document type has tens of
fields and table columns, the pinned ontologies thousands of terms, and the editor's term picker
is a substring search. A reasonable automated mapping would probably beat a hand-made one. This
document records how mapping works now, what the research says works, what that means for CT
Studio, and the spike that tests it before anything is built. It is the justification for the
direction taken; the spike's results are added at the end.

## 1. How mapping works today

**What a mapping is** (`SemanticsSchema` in `packages/shared/src/template.ts`, `Semantics` in
`worker/src/ingest_worker/template.py`): a document class and IRI template; for each field or
column a property, and how its value is published: a literal, an entity (`object`: class plus an
IRI template such as `party/{value|slug}`) or a SKOS concept (`concepts`: explicit values or
`match: label` within a scheme); for each table a link property, a row class and a row IRI
template; prefixes, local terms and SHACL shape pins. `rdf.render_graph` turns it into one named
graph per document; an unmapped output falls back to the recipe's default vocabulary
(`{base}def/{type}/{id}`).

**How it is proposed** (Workbench mapping stage, `worker/src/ingest_worker/mapping_stage.py`):

1. The survey suggests which ontologies to pin (`ontology_suggest.py`: lexical and semantic best
   hits per survey candidate, then a greedy set cover).
2. For every output (the document, each field, each table, each column) a query
   `"{name}. {description}. {type}. values: …"` retrieves candidates: 15 properties and, for the
   document, tables, enums and text, 8 classes/concepts/schemes, by lexical (trigram + full text)
   and embedding (exact cosine) rankings fused by reciprocal rank fusion (`retrieval.py`). All
   candidates are capped at 300 terms in total.
3. **One** model call sees the brief, the outputs with up to 10 observed values each, every
   output's candidates and the current mapping, and answers the whole mapping at once as flat
   changes with a self-reported confidence. Since [ADR 0016](../adr/0016-tools-in-drafting.md) it may
   also call `search_terms` and `term_detail`.
4. `convert_mapping` checks the answer: every IRI must be a candidate, a searched term or a
   declared local term; IRI templates use only names in scope; columns follow their table.
   Errors go back to the model once.
5. A person reviews the proposal per change. The card shows the term, "Suggested · confidence",
   the seen values and alternatives' labels; the mapping editor's picker searches by substring.

**Gaps** found in the review (design promised or the store could support, but not built):

| Gap | Where |
| --- | --- |
| No end-to-end evaluation: nothing measures whether the chosen terms are right. The recall fixture has 10 cases, one expected IRI each, scored with a fake 16-dimension embedder | `worker/tests/fixtures/mapping-recall/`, `test_retrieval.py` |
| The whole mapping is one generative answer over up to 300 terms | `run_mapping` |
| No kind check: any shortlisted IRI is accepted in any slot (a class as a property, a datatype property for an entity) | `convert_mapping` |
| Domain and range are shown to the model as text but never used to rank or check; ValueType vs `rdfs:range` and domain-mismatch checks promised in the design are not implemented | `retrieval.py`, `apps/api/src/templates/semantics.ts` |
| Deprecated terms are not filtered from retrieval | `ontology.py` `lexical`/`semantic` |
| No per-value concept matching: enum values and observed values are not matched to a scheme's concepts before the model guesses | `mapping_stage.py` |
| Confidence is the model's own word; nothing is calibrated, nothing auto-accepted | `MAPPING_SCHEMA` |
| Accepted mappings are never reused (other published recipes map "batch number" too) | — |
| Reviewers see alternatives' labels only: no definitions, scores or one-click swap | `apps/web/src/workbench/mapping.ts` |
| Columns merged into a new table change lose their own confidence and alternatives | `convert_mapping` |

The store already holds what a better matcher needs: labels, alt labels, definitions, parents,
domains, ranges, schemes, `deprecated`, `child_count`, imports, and term embeddings
(`ontology_terms`, `ontology_term_embeddings`).

## 2. What the research says

Sources span ontology matching (OAEI), schema matching, table annotation (SemTab) and mapping
(RML) generation, 2023-2026.

### Pipeline shape

The best-supported design is **retrieve, then take the easy cases cheaply, then send only the
uncertain ones to an LLM as a narrow decision, then check structure, then route to people by
confidence.** Free LLM generation of mappings and all-pairs comparison both do worse and cost more.

- **OLaLa** (Hertling & Paulheim, K-CAP 2023): sentence-transformer candidates, then an open LLM
  decides yes/no per pair with confidence from token probabilities; on par with supervised
  matchers. <https://arxiv.org/abs/2311.03837>
- **MILA** (Information Fusion 2025): SBERT top-5, a pair that is each other's top-1 is accepted
  **without an LLM call**; only the rest are prompted. Best F1 in 5 of 7 OAEI 2024 tasks, and
  ~45 minutes against ~47 hours for plain retrieve-then-prompt on SNOMED-FMA.
  <https://arxiv.org/html/2501.11441v2>
- **LogMap-LLM / "LLMs as Oracles"** (OAEI 2025): the LLM validates only the mappings the matcher
  is unsure of; F 0.718 → 0.751. The LLM behaved like a reviewer making about 20% errors: better
  than a careless human, worse than a careful one. <https://arxiv.org/abs/2508.08500>
- **GenOM** (2025): an LLM writes a definition for each concept; a **7B** model judges top-10
  candidates; best average F1 on Bio-ML. <https://arxiv.org/html/2508.10703v1>
- **MapperGPT**: the LLM refines high-recall lexical candidates; precision 0.601 vs LogMap's 0.458.
  <https://arxiv.org/abs/2310.03666>
- **Agent-OM** (PVLDB 18): retrieval and matching agents over pgvector with RRF, an LLM validator
  and a found-from-both-sides filter; hallucinations mitigated but not eliminated.
  <https://arxiv.org/html/2312.00326v8>

### Schema matching and table annotation (closest to fields → properties)

- **ReMatch** (Microsoft): retrieve a small target set per attribute, then GPT-4 ranks.
  <https://arxiv.org/html/2403.01567v2>
- **Matchmaker** (ICML 2025): candidate generation, refinement, **confidence scoring**.
  <https://arxiv.org/abs/2410.24105>
- **Schemora** (2025): LLM-written alternative names per column, dense + BM25 retrieval, LLM rerank.
  <https://arxiv.org/pdf/2507.14376>
- **Magneto** (VLDB 2025): a small fine-tuned retriever, GPT-4o-mini reranks the top 20.
  <https://arxiv.org/html/2412.08194v1>
- **Column type annotation with ChatGPT** (Korini & Bizer): choosing the table's domain first, then
  only that domain's labels, raised micro-F1 85.3 → 89.5. <https://ar5iv.labs.arxiv.org/html/2306.00745>
- **SemTab 2024, table metadata to KG** (column labels → 2,881 DBpedia terms): the winner combined
  RAG, chain of thought, self-consistency and RRF; Hit@1 0.83, Hit@5 0.98.
  <https://ceur-ws.org/Vol-3889/paper0.pdf>
- **CHORUS / ArcheType**: snapping model output onto the allowed labels controls hallucination.
  <https://arxiv.org/abs/2306.09610>, <https://arxiv.org/abs/2310.18208>
- **RACOON**: knowledge-graph context about cell values lifts micro-F1 by up to 0.21.
  <https://arxiv.org/abs/2409.14556>

### Generating whole mappings (RML/YARRRML)

- Hofer, Frey & Rahm (KGCW 2024): only the strongest models produced usable RML; errors cluster in
  IRI generation, datatypes and class assignment. <https://ceur-ws.org/Vol-3718/paper6.pdf>
- Schmidt et al. (TGDK 2025, Bosch): mean F1 0.77 (YARRRML); few-shot examples gave the best
  precision (up to 0.95); IRI templates were the most common mismatch.
  <https://drops.dagstuhl.de/storage/08tgdk/tgdk-vol003/tgdk-vol003-issue003/html/TGDK.3.3.5/TGDK.3.3.5.html>
- BLINKG (TGDK 2026): class identification above 0.95, but related entities and joins below 0.60;
  open-weight models trailed. <https://www.alphaxiv.org/abs/2605.19518>

**Implication:** never have the model write the mapping as free text; keep structured operations
rendered by code, as CT Studio already does. The hard parts are entities (object properties,
classes, IRI templates) and table links.

### What moves accuracy

| Ingredient | Evidence |
| --- | --- |
| The right term in the shortlist (recall caps everything) | ReMatch: no retrieval Acc@1 0.31, a tight retrieved set 0.42; a big set adds noise |
| Descriptions | ReMatch: names only, Acc@5 0.73 → 0.50 |
| Generated alternative names / definitions | Schemora +5-15 points HitRate@5; GenOM Hit@1 0.54 → 0.83 at judging |
| Known mappings as examples | ReMatch: one known mapping per table, Acc@1 +20%; Bosch: few-shot gave the best precision |
| Sample values | Magneto: ~10 frequent values best; names only worst |
| Choosing in stages (domain/class first, then properties) | Korini & Bizer: 85.3 → 89.5 F1 |
| An LLM reranker over a non-LLM one | Magneto: MRR 0.55 → 0.61 |
| Hierarchy context | Mixed: helps some models and tasks, not others |

**Realistic expectation:** top-1 accuracy of 50-80% even for the best systems, top-5 of 80-98%.
A good system proposes its pick with ranked alternatives, and auto-accepts only a calibrated
high-confidence slice.

### Confidence and human review

- High-precision shortcuts (exact label match, both-ways top-1, agreement of independent signals)
  can be accepted with little or no review; GenOM accepts only YES-probability ≥ 0.99 and cosine
  ≥ 0.97.
- Confidence signals: token probability of the pick, agreement between retrieval top-1 and the
  model, self-consistency across samples. Verbalised confidence ("high") is poorly calibrated.
  Calibrate any signal on a gold set. <https://arxiv.org/html/2509.25532v1>
- Reviewers check faster against a ranked shortlist with definitions, parents, domain and range
  and the supporting values than against a single answer.
- Evaluate a review design offline with simulated reviewers at 0-30% error, as OAEI's interactive
  track does. <https://oaei.ontologymatching.org/2024/results/interactive/>

### Gotchas

- **Hallucinated IRIs**: fix by construction (the term is an enum of candidate ids plus `none` and
  `local`), which CT Studio's shortlist rule approximates.
- **Generic properties** (`rdfs:label`, `dcterms:description`, `skos:note`): down-rank unless the
  output really is a label or description.
- **Literal vs entity**: make it follow the chosen property's range (object property → entity of
  its range class; datatype property → literal), not a free choice.
- **Units and quantities** (QUDT, OM): no published LLM method; use a fixed pattern and let the
  model pick only unit and quantity kind.
- **Concept values**: match observed and enum values to a scheme's labels lexically first; the
  model only for leftovers.
- **Local vs frontier models**: 7-30B models are adequate for narrow decisions (verify, rerank a
  short list, write definitions) and weaker at whole multi-part answers (Qwen3-8B beat larger
  models on OAEI Anatomy; Jellyfish-13B scored 15% Hit@1 on MIMIC→OMOP). This matters because
  CT Studio's default drafting model is local.

### Evaluation

- Retrieval: recall@k of the gold term per output kind, and MRR.
- Decisions: Hit@1, and precision/recall/F1 counting "leave unmapped" and "local term" as answers;
  how the value is published (literal/entity/concept) as its own score.
- Errors classified as missing, too general, too specific, or wrong (OAEI-LLM).
  <https://arxiv.org/html/2409.14038v1>
- Cheap gold: accepted review decisions over time, plus 3-5 document types mapped by an expert;
  SSSOM-style rows (subject, predicate, object, justification, confidence, author).

## 3. What this means for CT Studio

CT Studio's skeleton (hybrid retrieval → LLM → structured changes → per-change review) is right.
What the research says to change:

1. **Measure first.** Nothing today says whether a proposed mapping is right. Build a gold set and
   an offline harness; fix retrieval recall before prompts.
2. **Decompose the answer.** One call mapping everything over 300 terms asks a local model for
   exactly the open, multi-part generation it is worst at. Instead: choose the document class (and
   each table's row class) first, then for each output a narrow choice among a few candidates.
3. **Use the structure the store has.** Rank properties by domain fit to the chosen class (and its
   ancestors), drop deprecated terms and classes in property slots, down-rank generic properties,
   check range against the output's type, and derive literal/entity/concept from the chosen
   property's range and the output (enum → concept).
4. **Do the deterministic parts in code**: concept values by label within a scheme, IRI templates
   from sensible defaults, prefixes.
5. **Score confidence from signals, not words**: retrieval top-1 agreeing with the model, an exact
   label or alt-label match, agreement across samples. Pre-select only the high tier in review;
   show the top alternatives with definitions for the rest.
6. **Mapping memory**: outputs already mapped in published recipes (same name, description and
   type) are direct candidates and few-shot examples for new types.

### A modelling gap the research does not cover

`rdf.render_graph` hangs every field off the document node (`doc → property → value`), and every
column off its row. Ontologies usually attach a property to the thing it describes: in the test
vocabulary `batchNumber` and `expiryDate` have domain `Batch`, not `BatchRecord`. So the *right*
property for a batch record's "lot number" breaks its domain in the graph CT Studio renders. A
matcher must therefore treat a fitting domain as a small boost and never sink a candidate for a
different one (the spike's matcher does), and SHACL shapes with `sh:targetClass` on the batch will
not see these values. Domain-correct graphs would need the mapping to group fields under an entity
(the document *describes* a batch, the batch *has* the lot number): a `semantics` extension worth
designing separately once the spike shows how often it matters.

### The measurement pattern: class-centric ontologies

Found while drafting a gold mapping for the covalidation project (a stability report) against the
deployment's library (AFO, OBI, GS1, QUDT, OWL-Time, DCMI, PROV-O): **AFO and OBI put the meaning
in classes, not properties.** Their properties are generic relations (`has data output`, `has
identifier`, `has value`, `has condition`, `has part`, `is about`); the specific vocabulary is the
classes: *batch identifier*, *water mass fraction*, *assay result*, *dissolved percentage*,
*elapsed time*, *count*, *conformance assessment*. The faithful graph for one result is a node of
the right class carrying the value:

```
row  --afx:has-data-output-->  [ a afr:AssayResult ;  afx:has-value 99.1 ;  qudt:unit unit:PERCENT ]
```

CT Studio's `semantics` cannot say this. A column maps to a property with a literal (`row →
property → 99.1`), or to an entity (`object`: a class and an IRI template, the value as its
`rdfs:label`), which mints one node per *distinct value*: every row whose assay reads 99.1 would
share one "99.1" entity. So:

- **Automated mapping quality is capped by the format before any matcher is involved.** For a
  class-centric library the best expressible answer is a generic property plus an entity class,
  and even that renders values as shared labelled entities.
- **Coverage is the library's limit**: about half of covalidation's 46 columns have a fitting AFO
  class (identifiers, water content, assay, dissolved percentage, elapsed time, counts, pass/fail
  as conformance assessment); storage conditions as a whole, appearance as such, degradation
  product amounts, solid-state form and microbial counts by organism have none and need local terms.
- **The fix is a measurement pattern in `semantics`**: a column (or field) mapped as `link` (the
  property from the row or document), `class` (the node's class), `value` (the property holding the
  literal on the node, e.g. `afx:has-value`, `qudt:numericValue`) and an optional `unit` (a QUDT
  unit, fixed or from another column), rendered as a fresh node per row. With it, a matcher's job
  becomes mostly choosing a class, which retrieval does well; the link and value properties are
  few and can default per ontology. This needs its own design (both sides of the contract,
  rendering, SHACL, the Mapping editor) and is the change the evaluation most supports so far.

The covalidation gold (`docs/design/mapping-gold/covalidation.yaml`) is written class-centric:
`term: any` (any link property) with the class that matters, `as: entity`, and `unmapped` where the
library has nothing. It was drafted by Claude from the library's own labels and definitions, not by
a domain expert, so it measures agreement with a careful reference rather than ground truth; its
16 judgment calls are marked `# CHECK` for a person to settle. The harness scores a field or
column's class (`class`, compared with the pick's entity class) as well as a table's row class.

## 4. The spike

**Question:** does a decomposed, structure-aware matcher choose better terms than today's single
answer, with a confidence that separates right from wrong well enough to pre-select?

**What it builds** (read-only research code, like `ingest_worker.detect`; nothing users see):

- `worker/src/ingest_worker/mapping_eval.py`: an evaluation harness. It reads a gold file (below),
  runs one or more matchers over the same outputs, observed values and pinned ontologies, and
  reports per output kind: retrieval recall@k and MRR, Hit@1, precision/recall/F1 with
  "unmapped" as an answer, value-as accuracy, and precision per confidence tier. `--json` for
  machine output.
- Matchers compared:
  - **current**: today's stage (one answer over the shortlists, `convert_mapping` rules);
  - **per-output** (`mapping_match.py`): class first; property candidates re-ranked by domain fit,
    kind, range vs type, deprecated and generic penalties; one narrow, enum-constrained model
    choice per output (small batches); literal/entity/concept derived from the range; concept
    values matched by label; confidence from signal agreement.
- **Gold file** (YAML, kept outside the repo when it names a customer's schema): the recipe id,
  the pinned ontology versions, and for each output the expected term(s) (several may be right),
  how the value is published, or `unmapped`.

**Runs:** a synthetic gold over the test pharma ontology (in the tests, with fake models, so the
harness is covered in CI), then a real gold over a real project and its pinned ontologies, with
the local drafting model and with a frontier model, run by hand against a deployment.

**Making a real gold cheaply:** the project needs one finished mapping run (the harness reuses that
job's exact inputs). Print a gold file pre-filled with the current stage's answer, then correct it
by hand (an expert's half hour, not a mapping from scratch):

```bash
docker exec ingestion-worker-1 python -m ingest_worker.mapping_eval --template <project> > gold.yaml
```

Each output is listed with its type and description; an answer is a term, a list of acceptable
terms, `unmapped`, or `{term, as: literal|entity|concept, class}`: `class` is a table's row class
or a field or column's entity class, and `term: any` accepts any link property (for class-centric
ontologies, where the class carries the meaning). Then:

```bash
docker cp gold.yaml ingestion-worker-1:/tmp/gold.yaml
docker exec ingestion-worker-1 python -m ingest_worker.mapping_eval --gold /tmp/gold.yaml
docker exec ingestion-worker-1 python -m ingest_worker.mapping_eval --gold /tmp/gold.yaml --model <choice>
```

`--model` takes a model choice id or `endpoint/model` (default: the drafting model); `--matcher`
picks `current`, `per-output` or both; `--json` for machine output. Nothing is written: the stage's
result and model log stay in memory. The report gives, per output kind, Hit@1, precision, recall,
F1, retrieval recall@1/5/10 and MRR of each matcher's candidates, value-as and row-class accuracy,
and precision per confidence tier, with model calls and time.

**Decision gate:** build the per-output matcher into the stage if, on the real gold, it beats the
current stage by **10 points of Hit@1** on the local model, and its high-confidence tier reaches
**95% precision** on at least a third of the outputs. Otherwise keep the stage and take only the
structural fixes (kind checks, deprecated filter, range checks, label-matched concepts), which help
either way.

## 5. Results

### Smoke run: synthetic gold (2026-10-18)

The test gold (`worker/tests/fixtures/mapping-gold/batch-record.yaml`: a batch record with 4
fields and a 2-column table over the test pharma vocabulary), lexical retrieval only, the local
drafting model `qwen3.8-27b-mtp` on LM Studio.

| Matcher | Hit@1 | Retrieval recall@1 / @5 | MRR | Model calls | Time |
| --- | --- | --- | --- | --- | --- |
| current (one answer) | 8/8 | 71% / 100% | 0.83 | 1 | 16 s |
| per-output | 8/8 | 86% / 100% | 0.90 | 4 | 14 s |

- **The synthetic gold cannot tell the matchers apart**: its vocabulary was written for these
  labels, so both are perfect. It proves the harness end to end against a real model, nothing
  more. The decision needs a real gold.
- **The re-ranking lifts the right term to first place more often** (recall@1 71% → 86%, MRR
  0.83 → 0.90), mainly for the document class: the exact label match moves `BatchRecord` above
  `Document`. A table's link stays a weak spot for both: "tests" retrieves `hasResult` third.
- **The "too general" error showed up at once**: on the first run the per-output matcher picked
  `Document` for the whole document although `BatchRecord` (its subclass, an exact label match)
  was offered first. The confidence signal had already marked it medium. Two changes fixed it:
  options now name their parent ("subclass of …") with the instruction that a subclass beats its
  parent, and a parent picked over an offered exact-match subclass is replaced by the subclass
  (at medium confidence). On the rerun the model picked `BatchRecord` itself.
- **Confidence**: the per-output tiers were high 3 (all right), medium 4 (all right), low 1 (the
  correctly unmapped `notes`). Too few outputs to calibrate anything.

### The stage on covalidation (2026-10-18, a deployment without a base IRI)

Before the gold could run, the Workbench mapping stage itself failed on covalidation (AFO and OBI
pinned, local `qwen3.8-27b-mtp`, tools on). Its model log showed the model working sensibly: it
searched the ontologies eight times for a class for the `batches` rows (the library has none, as
the gold also found) and looked candidate terms up. With nothing fitting it declared local terms,
which were refused because that deployment had no base IRI (a restore *as a copy* keeps the
target's own Linked data settings); its second answer left the table's row class empty, and the
two tries were spent. Two prompt faults, now fixed: the stage invited local terms where none can be
declared (the prompt now says when they are unavailable), and nothing said that a table whose rows
fit no class should stay unmapped (the instructions and the row-class error now say so). It is the
library gap again: a batch is a central thing in these documents and the library has no class for
it.

### Real gold

To be added: the covalidation gold, with the local model and a frontier model.
