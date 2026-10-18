# Mapping memory: reuse what reviewers accepted

Status: proposal, for review (2026-10-18). Follows the mapping spike
([mapping-automation.md](mapping-automation.md)), whose gap list notes that *accepted mappings are
never reused*.

## 1. The idea

Every time a recipe with an ontology mapping is published, a person has accepted an answer to
"what is this output?": *Batch number* is an entity of *batch identifier*, *Water content (KF)* is a
value node of *water mass fraction* in percent, *Storage condition* stays unmapped. Today that
answer stays inside the one recipe. The next recipe with a *Batch number* column starts from
nothing, and the matcher has to find the same class again, sometimes wrongly.

A **mapping memory** keeps those answers deployment-wide, in the database: what the output looked
like (its wording, type, unit and context) and what was accepted for it. The mapping stage and the
per-output matcher consult it before asking a model, and designers can see, confirm, correct and
reject entries on the Ontologies page.

It is cheap because the answers already exist (published recipes' `semantics`) and the machinery
to search them does too (pg_trgm and pgvector, used for ontology terms). It is meaningful because
it attacks the two things the spike could not fix with rules:

- **Retrieval misses.** The right class for the degradation products was never retrieved by label
  or embedding search. A remembered answer puts it on the short list regardless of its label.
- **Confidence.** The spike's high-confidence tier stayed at 15% of outputs. An output whose wording
  matches a confirmed answer exactly can be pre-selected with high confidence and no model call:
  agreement with an earlier human decision is a far better signal than the model's own word.

## 2. Why this works: what the research says

Reusing earlier match results is one of the oldest and most consistently useful ideas in schema
matching:

- **LSD** (Doan, Domingos and Halevy, SIGMOD 2001) learns from the mappings a user gave for the
  first few sources and applies them to new ones; accuracy rose with each source mapped.
- **COMA** (Do and Rahm, VLDB 2002) and COMA++ (Aumueller et al., SIGMOD 2005) treat *reuse of
  previous match results* as a matcher of its own, combined with name and structure matchers; it
  was among the strongest single matchers in their evaluations.
- **Corpus-based schema matching** (Madhavan, Bernstein, Doan and Halevy, ICDE 2005) uses a corpus
  of earlier schemas and mappings to match elements that have no direct evidence between them.
- Data catalogues work the same way in practice: business-glossary terms that stewards assigned
  before are suggested for new columns with similar names.

The common lessons: reuse is a *signal combined with others*, not a replacement for them; it needs
curation (wrong answers spread as easily as right ones); and it pays off more with every reviewed
mapping, starting from nothing.

## 3. What a remembered mapping is

One entry per distinct pair of *what the output is* and *the accepted answer*:

| Part | Holds | Example |
| --- | --- | --- |
| Signature | normalised output name, description, type, unit (from the name or description), kind (field, column, table, document), the table's name for a column, enum values | `water content kf` · "Water content by Karl Fischer (%)" · number · `%` · column of *Appearance and water content* |
| Answer | the form (literal, entity, concept, node, unmapped) and its terms: property, class, unit, concept scheme; for a table its link and row class | node · class *water mass fraction* (AFO) · unit `unit:PERCENT` |
| Ontologies | the ontology ids the terms come from (the version is a source detail, not part of the entry) | AFO |
| Sources | every published recipe version that used this answer for an output with this signature | `covalidation` v6, `stability-report` v2 |
| Status | `learned` (derived from published recipes), `confirmed` (a designer vouched for it), `rejected` (never suggest this answer for this signature), `stale` (a term is gone or deprecated in the newest ready ontology version) | |
| Review | who confirmed, rejected or edited it, when, and an optional note | |

Recipe-wide defaults are remembered too, keyed by the set of pinned ontologies rather than an
output: the document class and the value-node defaults (link, value and unit properties). The spike
found the default link was the worst single choice the matcher made; a remembered default fixes it
for every later recipe on the same ontologies.

**Never stored:** sample values, observed values or anything from a document. The memory holds
recipe structure only: output names, descriptions, types and the terms chosen.

## 4. How entries are captured

- **On publish.** When a recipe version with `semantics` is published (both publish routes), each of
  its outputs' mappings becomes a source of the matching entry, created as `learned` when new.
  Unmapped outputs count too: "the reviewer published this column unmapped" is an answer.
- **Backfill.** A one-off job reads every published version already in the database.
- **Reconcile, not append.** The sources of `learned` entries are recomputed from published recipes
  (idempotent, like the Workbench list cache): a newer published version that changed an answer
  moves its source, retiring a document type removes its sources, and an entry with no sources left
  and no review disappears. Confirmed, rejected and edited entries keep their review whatever the
  sources do.
- **Not from drafts or proposals.** Only published versions count at first: an accepted proposal in
  a draft can still be changed before publishing. (Accepted proposals could become a weaker
  `proposed` status later.)
- **By hand.** Designers can add an entry on the Ontologies page (for an output wording they expect),
  and every entry can be confirmed, edited or rejected there (section 6).

## 5. How the memory is used

Before any model call, the mapping stage and the per-output matcher look each output up in the
memory, restricted to entries whose terms exist in the project's pinned ontology versions:

1. **Lookup.** Exact match on the normalised signature first (name, type and unit), then fuzzy
   matches: trigram similarity on the name and description, and embedding similarity on the
   signature text (embedded with the deployment's embedding model, stored per model as
   `ontology_term_embeddings` is). The table's name is part of the text, so *Mean (%)* in a
   dissolution table matches other dissolution means, not any mean.
2. **Retrieval.** Remembered terms join the short list as a third ranking next to lexical and
   semantic search (`retrieval.fuse`, source `remembered`), so a class whose label search misses it
   is still offered.
3. **Hint.** The output's prompt line says what was accepted before:
   "Accepted for *Water content (KF)* in 2 recipes (confirmed): value node of *water mass
   fraction*, %". The model is still free to choose otherwise.
4. **Pre-select.** A `confirmed` entry whose signature matches exactly, whose terms are in the
   pinned versions and none deprecated, is picked without a model call, at high confidence, with
   the entry named as its evidence. A `learned` entry that two or more recipes agree on is
   pre-selected at medium confidence. Everything else goes to the model as today.
5. **Rejected answers** are removed from that signature's options.
6. **Conflicts.** When one signature has different answers, all are hinted with their counts and
   none is pre-selected unless exactly one is confirmed.

The reviewer sees the provenance on the proposal card and in the Mapping editor: *Remembered ·
2 recipes · confirmed by Ken Hayward*, with a link to the entry.

## 6. Maintaining it: the Ontologies page

A **Remembered mappings** view on the Ontologies page (a tab beside the library list):

- **List:** the output wording, the answer in words (form and term labels, never raw IRIs for
  people who are not admins), the ontology, *used by N recipes* (each a link to its recipe), status
  and last review. Filters: ontology, status (needs review: learned and stale; confirmed;
  rejected), search.
- **Actions** (designers and admins): *Confirm*, *Edit* (change the form, class, unit or property,
  through the same term pickers as the Mapping editor; an edited entry is confirmed), *Reject*
  (keeps the entry as a "never suggest" rule), *Delete* (admins; a learned entry comes back on the
  next reconcile while recipes still use it, so rejecting is the normal way to stop one).
- **Stale entries** say which term is missing or deprecated in which ontology version, with a
  suggested replacement when the newer version declares one.
- **Term detail panel:** an ontology term's panel lists the entries that use it ("Remembered for
  *Batch number* in 4 recipes").
- Operators reach none of it (the operator allow-list stays as it is). A help topic explains the
  view, listed under Ontologies in the Help panel.

## 7. Rules that keep it safe

- **Data policy.** An entry remembers whether its sources include local-only projects. The text of
  an entry whose sources are all local-only (its output names and descriptions) is never put in a
  prompt sent to an external model, the same rule that keeps local samples local; its signature is
  embedded only with a local embedding model, as the survey's ontology suggestions do. Entries
  confirmed or added by hand follow the policy of the project they were made from.
- **Access.** Deployment-wide sharing matches the access model: designers can already read every
  recipe, so the memory shows them nothing new.
- **Retired ontologies** hide their entries; **retired document types** stop counting as sources.
- **Ontology upgrades** turn entries stale rather than wrong: a stale entry is still hinted, never
  pre-selected.
- **Backup and restore** carry the memory (it travels with the recipes it was learned from); a copy
  restore keeps the backup's entries. Workbench bundles and GitHub sync do not carry it: it is the
  deployment's knowledge, not the recipe's.

## 8. Measuring it

The evaluation harness (`mapping_eval`) gets a `--memory` option: seed the memory from the
deployment's published recipes, or from a gold file, always leaving out the gold's own recipe
(leave-one-out), and score with and without it. Two cheap first measurements:

- **Leave one table out on covalidation.** Its six results tables repeat *Batch number*, *Study id*
  and *Storage time*; remembering five tables' answers and scoring the sixth shows the effect on
  repeated columns today.
- **A second document type** seeded with covalidation's answers, the real test: how much of a new
  recipe the memory answers, and how often it is right.

Report exactly-right, the high tier's precision and coverage, and the model calls saved.

## 9. What it touches

| Area | Change |
| --- | --- |
| Database | a migration: `mapping_memory` (signature, answer, status, review), `mapping_memory_sources` (template id, version, output path), `mapping_memory_embeddings` (per embedding model) |
| Shared | `MappingMemoryEntrySchema`, the signature normaliser (held in step with the worker by a shared fixture, as other contracts are) |
| API | capture on publish and the reconcile; routes `GET /api/ontologies/memory`, `POST`, `PATCH|DELETE /api/ontologies/memory/:id` (documented, designers and admins) |
| Worker | `OntologyStore.remembered(...)`; `retrieval` third ranking; hints and pre-selection in `mapping_stage` and `mapping_match`; the data-policy filter |
| Web | the Remembered mappings view, the term panel list, provenance badges on proposal cards and in the Mapping editor, a help topic |
| Harness | `--memory`, leave-one-out |

**Phasing.** It can ship as one PR (CI time favours it) or two: capture, use and the harness first
(useful at once, invisible to users apart from the hints), then the Ontologies view. The second is
what makes it trustworthy over time, so it should not lag far behind.

## 10. Open questions

1. **Signature granularity:** should a column's signature include its table's name always, or only
   when the name alone is ambiguous (*Mean*, *Result*)?
2. **Who confirms:** any designer, or admins only? Confirmation drives pre-selection, so it is the
   step that matters.
3. **Pre-selecting learned entries:** is agreement between two published recipes enough for medium
   confidence, or should only confirmed entries ever pre-select?
4. **Accepted proposals in drafts:** count them as weak evidence, or wait for publish?
5. **Several deployments:** a customer with staging and production may want to share a memory; out
   of scope here, but the entry format should not prevent an export and import later.
