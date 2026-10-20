# Output roles: constraints, check plugins and transforms

Status: **§1 built** (column constraints), 2026-10-20; §2 and §3 are still a brainstorm. Plan:
[2026-10-20-output-roles.md](../superpowers/plans/2026-10-20-output-roles.md). It follows
[recipe-plugins.md](recipe-plugins.md), whose P4 made table ownership per column: each column has
exactly one step filling it.

## Why this note

P4 answered one question: a later step filling a column the rows lack. Since then, other cases
have come up that are **not** "fill this column":

| # | Use case | What it really is |
| --- | --- | --- |
| A | A model fills `batch`; a code plugin rewrites it to a canonical form (`b 1234-a` to `B1234A`) | a **transform** of a value another step filled |
| B | Look up each product name in a product master list to make sure it is right (no model, deterministic) | a **check** against a reference outside the document |
| C | Range-check the values in a column (an assay between 90 and 110) | a **constraint** on the column |
| D | Split one column holding `95%-100%` into two columns, `95` and `100` | a **derivation**: filling new columns from an existing one |

Case D works today (below). Cases A to C need something new. This note proposes treating them as
three roles distinct from filling, rather than relaxing the one-writer rule.

## Why one writer per column

The rule is an invariant the codebase leans on, not a law of nature. Each value has exactly one
step behind it, which several parts assume:

- **Provenance.** The step run, the document's `models` map, the RDF evidence (`ct:step`,
  `ct:section`) and the References tab's corrected/entered counts name one step and one model per
  value.
- **Evaluation.** `gateHints` sends a low-accuracy column to the step that fills it (or says no step
  does); right first time counts per output. With two writers, who got it wrong?
- **Check paths.** A check on `lines.batch` reads one step's result.
- **Re-runs and review.** Re-running a step replaces its columns. If a second step had rewritten
  them, the re-run silently undoes the rewrite unless the second step runs again too. The
  reviewer-edit guard needs to know whose value an edit overrides.
- **Context order.** A later step reading `lines.batch` must know whether it sees the value before
  or after a rewrite.

Every one of these problems comes from treating a second step as a **peer writer**. Giving it a
different role (it judges, or it constrains, or it rewrites after the author with the raw value
kept) keeps the guarantees.

## The roles

| Role | Writes outputs? | Lives in | Examples | Today |
| --- | --- | --- | --- | --- |
| **Fill** (create or enrich) | yes: its own columns, one writer each | an extract or plugin step | the model extracts batches; a plugin splits a range (D) | yes (P4) |
| **Constraint** | no: raises issues | the output's definition | range (C), pattern, length | `enum` and the type only |
| **Check** | no: judges values | a check step | product master lookup (B), cross-column rules | checks between outputs only |
| **Transform** | rewrites a value in place, keeping the raw value | a step after the filler | canonical batch numbers (A) | no |

Suggested order: constraints, then check plugins, then transforms (only if the first two and
derived columns prove too limiting).

---

## 1. Column constraints

### Idea

Declare limits on a field or column next to its type, as `enum` already is:

```yaml
outputs:
  tables:
    - id: results
      columns:
        - id: assay
          type: decimal
          range: { min: 90, max: 110 }       # inclusive; either bound optional
        - id: batch
          type: text
          pattern: '^[A-Z]{2}\d{4}$'         # whole value
          length: { max: 12 }
```

`normalise_step` already turns a value into its type and reports an issue when it cannot (an
unreadable number, a value not in the enum). A constraint is one more check in the same place:
the value is kept as captured, and an issue on that row and column says why
(`assay 87.5 is below 90`). Issues already send the job to review.

### Why on the output, not a step

- It holds whichever step fills the output, and survives re-runs and step changes.
- It is declarative: the editor's Outputs tab can offer it as a form, the Workbench can draft it,
  and it needs no plugin or catalogue.
- Review shows it like any normalisation issue, so reviewers learn one thing.

### Not in the model's schema

Do **not** compile a range into the JSON Schema sent to the model (`minimum`/`maximum`). The model
would be retried until it produced an in-range number, which invites it to bend a value the
document really states. The point is to capture the true value and flag it.

### Built

- `ValueDef.range` (`{min?, max?}`, decimal and integer), `pattern` (text, the whole value,
  Python `re` syntax), `length` (`{min?, max?}` in characters, text), on both sides
  (`ValueDefSchema.superRefine`, `ValueDef._constraints`). TS checks a pattern with
  `patternCompiles` (`python-pattern.ts`): compiled without the `u` flag, whose lax parsing takes
  what Python takes, after refusing what JavaScript takes and Python does not (unknown letter
  escapes, short hex escapes, `(?<name>`, backreferences to groups not yet opened, `[]`, `[^]`,
  lookbehinds of no fixed width), with `(?P<`, `(?P=` and a leading `(?ims)` translated. When in
  doubt it refuses, so a pattern that saves always runs. Shared fixture `packages/shared/test/fixtures/value-constraints.json`.
- `normalize.check_value(raw, definition, date_order)`: the type first, then the first constraint
  broken (`87.5 is below 90`, `87.5 is above 110`, `'ab12' does not match …`,
  `'ab' is shorter than 3 characters`, `'abcd' is longer than 3 characters`); none when the type
  failed or the value is empty. Used by `normalise_step` and `review.apply_edits` (step `review`).
- Every constraint issue is a review reason (no warning level), nothing goes into the model's
  schema or into SHACL shapes. Editor: the Outputs tab's *Allowed values* column (min and max;
  pattern and max length).

### Questions (open)

- **Severity.** Is every constraint a review reason, or can a recipe mark one as a warning (shown,
  not blocking auto-delivery)? Normalisation issues are all review reasons today.
- **Pattern scope.** Should `pattern` stay a constraint, or also canonicalise (see transforms)?
  Keep them apart: a constraint never changes a value.
- **Units.** A range on a value whose unit varies (`mg` vs `g`) needs the unit first. Out of scope
  until values carry units outside RDF value nodes.
- **SHACL overlap.** Recipes delivering RDF can already state ranges as SHACL shapes on the graph.
  Constraints work for every recipe, before any graph exists. Should a constraint also emit its
  SHACL equivalent, or should the two stay separate?
- **Both sides.** The format change touches `ValueDefSchema` and `ValueDef`, a shared fixture,
  `normalize_value`, and the editor.

---

## 2. Check plugins

### Idea

A check step may name a plugin, as a plugin step does:

```yaml
pipeline:
  - type: check
    id: product_names
    uses: acme.product_master@1
    values: products.name          # what to judge
    with:
      list: products-2026-10       # the plugin's settings
```

The plugin receives the values (and, for a table, the rows they sit in) and returns what a check
returns today, per value: `status` (`match`, `alias`, `near`, `unmatched`), `matched` (what it
matched) and a `message`. It never writes outputs. Its result goes through the same code as a check's
result: review reasons (`check product_names: 2 unmatched`), the Review screen's check view, the
Results check view, and the check-path results later checks read.

### Why a check, not a step

- It changes nothing, so it has none of the provenance, re-run or evaluation problems above.
- The check result format already exists, and the UI already shows it.
- Cross-column and cross-row rules (`end >= start`, totals that add up, a value inside limits
  printed elsewhere in the document) fit the same contract with a `rows` input.

### Where the reference data lives

- **Small and stable:** in the step's `with` (checked against the plugin's settings schema).
- **Large:** shipped with the plugin package, versioned with it (a new list is a new release of
  the plugin; a recipe pins the major).
- **Live lookup** against another system: that is egress `remote`, refused today and meant for A2A
  (ADR 0018). Keep "deterministic, no network" explicit for now: such checks are pure, cacheable,
  previewable, and give the same answer in a regression run months later.

### Suggestions, not corrections

A lookup may know the right name (`Paracetamol 500mg Tablets` for `Paracetamol 500 mg tabs`). Return
it as `matched` on a `near` result, so the reviewer can apply it with one click. If the check
writes it into the output itself, it has become a transform (section 3).

### Questions

- **Contract.** The input and output schema of a check plugin (`values`, `rows`, statuses,
  messages) and its catalogue entry: a plugin's `kind` (`step` or `check`) in the catalogue, so a
  check step can only name a check plugin.
- **Data policy.** A check plugin with egress `model` (asking a model "is this a real product
  name?") is possible under P1's rules, but makes a check nondeterministic. Allow it, or keep
  checks to egress `none`?
- **Re-runs.** Checks already re-run after every step re-run, and that stays the same.
- **Preview.** The Workbench preview of a check needs the values, so it runs on a test run's
  output, not on prepared text.
- **Built-ins.** Worth shipping two with CT Studio: `list.lookup@1` (values against a list in
  `with`, with aliases and edit distance, the same matching as today's check) and `rule.compare@1`
  (column against column or constant).

---

## 3. Transforms

### Idea

A step that rewrites the values of a column another step filled, after that step, keeping the raw
value:

```yaml
pipeline:
  - type: extract
    id: batches
    table: batches
    sections: [summary]
  - type: plugin
    id: canonical_batch
    uses: acme.batch_canonical@1
    transforms: [batches.batch]      # not `columns`: it does not own the column
```

The rules would be:

- A column still has **one filler** (P4's rule), plus **zero or more transforms**, which run after
  it in pipeline order.
- A transform receives the column's values (and the rows) and returns the same number of values,
  in order. As for enriching, another count is an error naming the step.
- **The raw value is kept.** Each transformed cell records what the filler wrote (a `raw` beside
  the value, or a per-step history), so evidence quotes, audits and the review screen can show
  "`b 1234-a` became `B1234A` (canonical_batch)".
- Everything downstream sees the **final** value: checks, constraints, later steps' context,
  delivery, RDF and scores.

### Rules the rest of the system needs

| Concern | Rule |
| --- | --- |
| Re-run the filler | re-runs its transforms after it (the same mechanism P4 uses for enriching steps) |
| Re-run a transform | runs it on the filler's stored raw values, not on its own output (so it is idempotent) |
| Reviewer edits | apply to the final value; a re-run is refused while the column has edits, as today |
| Provenance | "filled by `batches` (model M), transformed by `canonical_batch`" in the step runs, the document, and the RDF evidence |
| Evaluation | a score compares the final value; the gate hint of a low-accuracy column names the filler first and lists its transforms |
| Corrections | a reviewer edit counts against the final value; whether it was the filler or the transform that erred is not knowable from one edit |
| Context order | a later step sees the final value; a transform reading a column another transform rewrites runs after it |
| Constraints | checked on the final value |

### Why last

Transforms touch the most: the document format (a raw value per cell), review, provenance, RDF
evidence and evaluation. Most canonicalisation does not need them:

- a deterministic, per-value rule (strip spaces, upper case, zero-pad) can be a **declared
  normaliser** on the column (a sibling of `pattern` in section 1, but one that rewrites), run
  inside `normalise_step` like today's date and number normalisation, with the raw value kept in
  the issue when it cannot apply;
- a rule needing code or a lookup can write a **second column** (`batch_canonical`) through P4's
  enriching steps, which works today and keeps both values.

Build transforms when several recipes need code-based rewrites of columns another step fills, and
the second column is getting in the way (in the outputs, in mappings, in consumers).

### Questions

- **Where the raw value lives.** In the cell (`{value, raw}`, a format change for every consumer)
  or in a side record of the step (`transforms: {step: [{row, column, from, to}]}`), which keeps
  the values as they are and costs a lookup to show history.
- **Declared normalisers vs plugin transforms.** One concept or two? A declared normaliser is a
  transform with no step; it could share the raw-value record.
- **Transforms on fields** as well as columns: the same rules with one value.
- **Failure.** A transform that cannot rewrite a value: keep the raw value and raise an issue, or
  fail the step?

---

## Case D today: deriving columns

Splitting `95%-100%` into two columns needs nothing new.

- **Simplest:** the extract step asks the model for `min_pct` and `max_pct` directly instead of a
  `range` column. Models split ranges reliably, and no extra step runs. Prefer this when the raw
  text is not needed.
- **Keeping the raw text:** the model fills `range`; a plugin step with
  `columns: [min_pct, max_pct]` parses `ctx.rows[i]["range"]` (P4). It is deterministic, can be
  tried in a test run, and re-runs when the creating step re-runs. For a field, a plugin field step
  with `context: {r: "range"}` does the same.
- **Formats to handle:** `95-100%`, `95 % – 100 %`, `≥95%`, `NMT 100%`, a single value. A value the
  parser cannot read comes back `null` with an issue, never a guess.

A built-in `text.range@1` (one column into a low and a high, with the formats above) may be worth
shipping beside `text.pattern@1`.

## Out of scope

- Checks and transforms that call other systems (egress `remote`): A2A, phase 5.
- Units and unit conversion outside RDF value nodes.
- Changing the one-writer rule for filling steps.

## Next

Pick the first slice (suggested: column constraints `range`, `pattern`, `length`), then write
its design into this note before coding, as P4 did.
