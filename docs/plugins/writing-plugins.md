# Writing a recipe plugin

A **recipe plugin** is a capability that a recipe's `plugin` step runs instead of a model call:
- a deterministic extractor;
- a value normaliser;
- a lookup that needs no model.

CT Studio ships `text.pattern@1`. This guide is for adding your own as a Python package that is
installed into the worker image. The design and the decisions behind it are in
[docs/design/recipe-plugins.md](../design/recipe-plugins.md) and
[ADR 0018](../adr/0018-capabilities-as-nodes.md).

The worked example is [`worker/plugins/example`](../../worker/plugins/example), a complete
package with tests. Copy it to start your own.

## When a plugin is the right tool

- **Use a plugin** when the rule is known and the same input should always give the same output.
  For example, the value after a label, a pattern, a checksum, or a table read from a fixed
  layout.
- **Use an extract step** (a model) when the document's wording varies.
- **Use a remote agent** (A2A, a later phase) for someone else's service, or anything that should
  not run inside CT Studio's worker.

A plugin runs **inside the worker process, with the worker's privileges.** Python cannot stop it
from reading what the worker can, so install only packages you have reviewed, just as you would
review a change to the worker itself.

## How a plugin step looks in a recipe

```yaml
pipeline:
  - type: plugin
    id: labels
    uses: example.label_value@1     # <plugin id>@<major>
    fields: [reference, dated]      # or `table: <id>`, as for an extract step
    sections: [head]                # the text it reads
    context: {}                     # earlier values it may read (optional)
    with:                           # the plugin's own settings
      labels:
        reference: Our ref
        dated: Date
```

Designers do not write this YAML by hand. The recipe editor offers every plugin the workers have
under *Add plugin step*, and lays out a form from your settings model (see
[Settings and the editor's form](#settings-and-the-editors-form)).

## The contract

A plugin is a `Plugin` object (`ingest_worker.plugins`):

```python
LABEL_VALUE = Plugin(
    spec=NodeSpec(
        id="example.label_value",   # lower-case, dotted: <owner>.<name>
        version=1,                  # the major version a recipe pins
        fn=run,
        output=StepData,
        effects="pure",             # "pure", "cacheable" or "effectful"
        egress="none",              # "none", or "model" for a plugin that asks one
        cancels_inside=False,
        summary="Fill fields from labelled lines (Label: value); no model call.",
    ),
    settings=LabelSettings,         # a pydantic model of the step's `with`
    check=check,                    # rules beyond the schema -> list of messages
    run_settings=run,               # (PluginContext, settings) -> StepData
)
```

### `run`: what a plugin answers

`run(ctx, settings)` returns what an extract step's model would answer:

- **A field step** returns `{field_id: {"value": …, "evidence": …, "page": …}}` for each of
  `ctx.step.fields`.
  - `value` is None when nothing was found.
  - `evidence` is the text the value came from.
  - `page` is the page number, from the nearest `[page N]` marker before the match, or None.
- **A table step** returns `{"rows": [{column_id: value, …}, …]}`.

Return values as you read them, usually strings. The worker types them against the recipe's
outputs (dates, numbers, choices), and lists a value that cannot be read as its type as an issue
for review, exactly as for a model's reply. Do not convert types yourself.

A plugin that raises fails the job's attempt, and the job is retried like any other failure. For
a problem with the document itself, rather than a bug, raise `ingest_worker.errors.DocumentError`
with a message for the reviewer; the job then goes to review instead of being retried.

### `PluginContext`: what a plugin reads

| Field | What it is |
| --- | --- |
| `ctx.step` | the plugin step: `fields` or `table`, `sections`, `with_` (raw) |
| `ctx.template` | the whole recipe, for example `template.table(id).columns` |
| `ctx.sections` | `{section id: text}` for the step's sections, page markers included |
| `ctx.text()` | the step's sections joined, in the step's order |
| `ctx.context` | the step's `context` values: `{name, path, text}` each, as a prompt shows them |
| `ctx.job` | the job, read-only (`ctx.job.filename` is the uploaded file's name) |
| `ctx.event(message, data)` | an advisory job event, shown on the job's timeline |
| `ctx.model` | the step's model, for a plugin whose egress is `"model"` (None otherwise) |
| `ctx.instructions` | the reviewer's guidance, when the step is re-run from review with some (None otherwise) |
| `ctx.rows` | for a step enriching a table, the table's rows so far without the step's own columns (None for any other step) |
| `ctx.occurrence` | for a table step reading a repeating section, the occurrence being read: `index` and `count` (1-based), `key` (None when none was found) and `section` (None for any other step) |

Read only these.

**Repeating sections.** A table step may read one repeating section, as an extract step does.
The worker then runs the plugin once per occurrence: `ctx.sections` holds that occurrence's text
alone under the section's id, and `ctx.occurrence` says which one it is. Each run answers
`{rows: [...]}` for its occurrence only; the worker joins the rows in order, and, when the step
names a `keyColumn`, sets that column on every row to the occurrence's key (whatever the plugin
put there; a row without a key is an issue for the reviewer). No occurrence: the plugin is not
run and the table is empty. A reply without a `rows` list is an error naming the occurrence.
The Workbench preview runs the same way.

**Enriching a table.** A table step that names `columns` enriches the rows an earlier step
created: say one step finds the batches and a plugin looks up each batch's expiry date. The
plugin gets the rows so far as `ctx.rows` and answers `{rows: [...]}` with **the same number of
rows, in the same order**, each holding only its columns (anything else in a row is ignored).
Another number of rows is an error naming the step, and the job goes to review. Re-running the
step that creates the rows runs the enriching steps again too. The Workbench preview cannot run
an enriching step on its own (it has no rows); try it in a test run.

```python
def run(ctx: PluginContext, settings: Settings) -> dict[str, Any]:
    assert ctx.rows is not None
    return {"rows": [{"expiry": lookup(row["batch"])} for row in ctx.rows]}
```

**Re-runs from review.** A reviewer may re-run a plugin step from the Review page's Steps tab, as
an extract step: only that step runs again, on the same text and the values before it, and its
outputs and issues are replaced. Guidance arrives as `ctx.instructions` (a plugin may ignore it);
a plugin whose egress is `"model"` gets the model the reviewer picked as `ctx.model`, else the
step's as usual. Page images are for extract steps only. A plugin gets no bucket, database or queue, and must not write anywhere: the
worker records the step's run and delivers the outputs.

### Asking a model

A plugin whose `egress` is `"model"` gets the step's model as `ctx.model`, and asks it with
`ask`:

```python
reply = ctx.model.ask(
    f"Which batch number is printed on this label?\n\n{ctx.text()}",
    {"type": "object", "properties": {"batch": {"type": "string"}}, "required": ["batch"]},
)
```

- **The reply** is a dict valid against the JSON Schema you pass. A reply that does not fit is
  sent back with the errors, as for an extract step (`max_attempts`, 2 by default; `check` adds
  rules beyond the schema). `system` replaces the default system prompt and `max_tokens` (16,000)
  is the output budget.
- **The model** is the job's override, else the step's `model` (a model choice the recipe editor
  offers for such a plugin), else the document type's model. It is resolved before the job calls
  any model, and a local-only project never sends a plugin's prompt to an external model.
- **Failures.** A reply that never fits, a refusal, a model its server does not have, or a prompt
  too long for it sends the job to review naming the step. Other failures, such as a server that
  does not answer, retry the job.
- **The audit trail.** Every attempt is kept in the runs bucket as
  `{job}/{step}.ask-{n}/attempt-{k}.json`. The step run records the model, the attempts and the
  tokens, so model costs and per-step statistics count it like an extract step.
- **The Workbench preview** runs only plugins whose egress is `none`, so a model plugin is tried
  with a dev test run instead.

### `check`: rules the schema cannot say

`check(template, step, settings)` returns messages. An empty list means the settings are fine.
Use it for anything that depends on the step or the recipe, for example:
- a field id that is not one of the step's fields;
- a pattern that does not compile;
- a column the table does not have.

The worker runs `check` before the job calls any model. A message stops the job as a document
problem (needs review) naming the step, and the Workbench preview shows the same message.

### Check plugins

A **check plugin** judges values another step collected instead of filling outputs. A recipe uses
it in a check step, in place of a reference:

```yaml
pipeline:
  - type: check
    id: product_names
    values: products.name           # what to judge: a field or table.column
    uses: list.lookup@1             # instead of `reference`
    with:
      values: [Paracetamol, Ibuprofen]
```

A check names `reference` (with optional `aliases`, `maxDistance`) **or** `uses` (with optional
`with`), never both. The editor's check step has a *Compares with* choice, A reference or A plugin,
and offers only check plugins.

Build one as a `Plugin` with `kind="check"`, and a `judge` in place of what a step plugin does with
`run_settings` (a check plugin is refused in a plugin step, and a step plugin in a check):

```python
def judge(ctx: CheckContext, settings: MySettings) -> list[dict[str, Any]]: ...
```

`CheckContext` (frozen) holds:
- `job`, `template`, `step`: the job, the recipe and the check step;
- `values`: the values the step's `values` path names, as text. Each **distinct** value appears
  once (compared ignoring case and spaces), in the order first seen;
- `rows`: for a table column, the table's rows those values come from; `None` for a field.

`judge` returns one verdict per value, a dict with:
- `value`: the value as given;
- `status`: one of `match`, `alias`, `near` or `unmatched`;
- `matched`: what it matched (only kept when the status is not `unmatched`), for a reviewer to
  apply;
- `message` (optional): a short reason, shown on the Review page and in the Results check view.

The worker turns the verdicts into the check's rows,
`{value, status, matched, distance, count, message?}` (`count` is how often the value was
collected), the same rows a reference check gives, so review reasons, the Review and Results
views and later checks all work unchanged. **Every collected value must get exactly one
verdict.** A value left out, judged twice, given a status outside the four, or a value that was
not given makes the job go to review (`DocumentError`, naming the check and the plugin).

A check plugin sends no data out: its egress must be `"none"` (`check_plugin` leaves one out
otherwise), so a check is deterministic, cacheable and gives the same answer in a regression run
months later. It never writes outputs. The built-in `list.lookup@1` is a worked example
(`LIST_LOOKUP` in `worker/src/ingest_worker/plugins.py`): `values`, `aliases` and `maxDistance`, with the
same matching as a reference check.

### Versions

`uses` pins a **major** version, and a published recipe runs that major for as long as a worker
has it.
- **A minor change** must keep the output for the same input, so a bug fix that changes values is
  a new major.
- **A new major** is a second `Plugin` with `version=2`. Keep the old one in the package as long
  as any published recipe uses it; an entry point may load a list of plugins (see below).

### The rules a plugin must keep

`check_plugin(plugin)` returns why the worker would leave a plugin out (empty: none):
- **Its `<id>@<major>` must be a valid ref**: a lower-case dotted id (`acme.invoice_no`) and a
  major from 1.
- **Its settings model must refuse unknown keys** (`model_config = ConfigDict(extra="forbid")`),
  so a mistyped setting is refused when the recipe is published instead of being ignored.
- **Its settings model must have a JSON Schema**, which the catalogue publishes to the API and
  the editor. Plain types, lists, dicts of strings, literals and nested models all have one.
- **Its `egress` must be `"none"` or `"model"`.** `"remote"` belongs behind A2A.

The worker also leaves out a plugin whose id is a built-in one (no package can replace or extend
`text.pattern`). When two packages provide one ref, the first entry point by name keeps it. Each
plugin left out is logged with its reason when the worker starts, and the rest still load.

## Settings and the editor's form

The recipe editor lays out a form from the settings model's JSON Schema. It shows each
setting's `title` as the label and its `description` as the hint, so give both:

```python
class LabelSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", title="Label settings")

    labels: dict[str, str] = Field(
        title="Labels",
        description="Field id to the label its value follows, at the start of a line.",
    )
    separator: str = Field(default=":", title="Separator", description="…")
```

| Setting type | Form control |
| --- | --- |
| `str` | text box |
| `bool` | switch |
| `int`, `float` | number box |
| `Literal["a", "b"]` | choice |
| `list[str]` | list of text boxes |
| `dict[str, str]` | key and value pairs, offering the step's fields as keys |
| anything else (an `Enum` class, a nested model, a union) | JSON |

A setting with a default is optional. A setting left at its default, or empty, is left out of
the recipe's `with`. Use an `alias` for a camel-case name in YAML (`ignoreCase`), and set
`populate_by_name=True`.

## The package

Plugins are found through the entry point group **`ct_studio.plugins`**. Each entry point loads
a `Plugin`, or a list of them:

```toml
# pyproject.toml
[project]
name = "ct-plugin-example"
version = "1.0.0"
requires-python = ">=3.13"
dependencies = []   # the worker provides ingest_worker and pydantic

[project.entry-points."ct_studio.plugins"]
label_value = "ct_plugin_example:LABEL_VALUE"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

Do not list `ingest-worker` as a dependency: it is not on an index, and the worker image already
has it. List only what your plugin needs beyond the worker. Any dependency the worker also uses
is held at the worker's locked version when the image is built.

## Testing

A plugin is tested without a worker, a database or a model. `plugin_context` builds the context a
job would give, and `Plugin.settings_for` runs the settings model and `check` as the worker does.
From [the example's tests](../../worker/plugins/example/tests/test_label_value.py):

```python
from ct_plugin_example import LABEL_VALUE
from ingest_worker.plugins import check_plugin, plugin_context

def test_the_plugin_keeps_the_contract() -> None:
    assert check_plugin(LABEL_VALUE) == []

def run(text: str) -> dict:
    settings = LABEL_VALUE.settings_for(RECIPE, STEP)   # raises ValueError with the reasons
    return LABEL_VALUE.run(plugin_context(RECIPE, STEP, {"head": text}), settings)

def test_each_field_takes_the_rest_of_its_labelled_line() -> None:
    out = run("[page 1]\nOur ref: INV-4021\n")
    assert out["reference"] == {"value": "INV-4021", "evidence": "Our ref: INV-4021", "page": 1}
```

To run your tests and the worker on your machine, install your package into the worker's
environment:

```bash
cd worker && uv pip install -e ../path/to/your-plugin && uv run --no-sync pytest ../path/to/your-plugin/tests
```

`uv sync` removes a package the lock does not list, so pass `--no-sync` to `uv run` while you try
it (`uv run --no-sync ingest-worker`). The worker logs `plugins: …` with every plugin it loaded.

## Deploying

1. **Make the package available to the image build** in one of three ways:
   - keep it in this repository under `worker/plugins/<folder>`;
   - publish it to a package index the build can reach;
   - push it to a git repository.
2. **Name it in `WORKER_PLUGINS`** in `deploy/.env`, in any form `uv pip install` takes, separated
   by spaces. For example: `WORKER_PLUGINS=plugins/example acme-ct-plugins==2.1 git+https://github.com/acme/ct-dates@v1.0`.
3. **Deploy** (`deploy/scripts/deploy.sh` or `.ps1`), which builds the worker image with them.

Once deployed:
- When the worker starts, it logs its plugins and publishes them in the plugin catalogue.
- The recipe editor then offers them, and the API checks recipes against them before publishing.
- The Workbench can preview a step on the dev samples (plugins with egress `none`, capped at 20
  seconds).

**Removing a plugin.** Drop it from `WORKER_PLUGINS` and deploy.
- A recipe that uses it can no longer be published (*no plugin X on this deployment's workers*).
- A job of a published recipe that uses it goes to review (*no plugin X on this worker*) before
  any model call.
- Keep a plugin as long as a published recipe runs it.
