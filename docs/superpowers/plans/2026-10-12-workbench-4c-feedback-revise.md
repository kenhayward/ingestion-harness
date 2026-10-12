# Workbench 4c/6: Feedback and Revise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the improvement loop.
- **Feedback.** The user leaves comments on a field, table, step or section, optionally tied to a dev sample and an evaluation.
- **Revise.** The drafting model reads the open feedback and the dev failures from the latest evaluation, and proposes changes to the template. The changes can touch outputs, sections or steps, and are accepted per change as in 3b.
- **Resolving.** Accepting a revision resolves the feedback it answered.

**Architecture:** `revise` is a fifth change stage. It reuses everything 3b built:
- document-less `draft` jobs, typed change ops and `applyChanges`;
- per-change accept with conflict checks;
- `StagePanel` in the web.

What is new:
- **The revise stage.** It accepts every op. Its model schema nests each change's payload under `field`, `table`, `section` or `step`, which avoids a key clash between a field's `type` and a step's `type`. The worker converts each item with the existing stage converters, then validates the whole template.
- **Feedback.** Stored in `workbench_feedback` (migration `0015`). A proposal records the `feedbackIds` it was made from, and accepting it, fully or partly, resolves them.
- **Failure diffs.** Built by one pure function, `failureDiffs`, from the latest complete dev iteration. They only include samples that are dev *now*.
- **The holdout rule** is enforced at feedback creation, because feedback can only name dev samples, and at revise time, because failures and feedback are filtered to current dev samples.

**Tech Stack:** Python 3.13 + pytest + mypy strict (worker), Fastify + Zod (API), React + Testing Library (web), Postgres migration.

**Spec:** [docs/design/workbench.md](../../design/workbench.md): "User journey" step 9 (feedback, `revise`), "Worker tasks" → `revise`, "Context assembly" (feedback and dev failure diffs; **holdout failure diffs never included**), "Data model" → `workbench_feedback`, "API (sketch)" (`/feedback`, `/revise`). Also [ADR 0007](../../adr/0007-workbench.md).

**Depends on:** 4b ([kenhayward/ingestion-harness#50](https://github.com/kenhayward/ingestion-harness/pull/50)), merged. Migration `0014` is the latest.

## Global Constraints

- **Feedback.**
  - `target` is `'field' | 'table' | 'step' | 'section'`, and `targetId` is a lowercase id (`^[a-z][a-z0-9_-]*$`).
  - `body` is 1–2000 characters.
  - `sampleId` is optional, and when given must be a ready **dev** sample of the project. Otherwise 400: `feedback can only refer to dev samples`.
  - `iterationId` is optional and must be an iteration of the project (400 otherwise).
  - An item is **open** until a revise proposal containing it is accepted or partially accepted. Only open items can be deleted; deleting a resolved one gets 409.
- **Revise.** `POST /api/workbench/projects/:id/stages/revise`.
  - Needs an open draft: 409 `no open draft; start the next version on the Template tab`.
  - Needs at least one open feedback item: 409 `add feedback before asking for a revision`.
  - It is not part of the stage order. It never blocks other stages and is never blocked by them, and `POST /stages/revise/skip` gets 400.
  - The job params add:
    - `feedback`: the open items as `{ target, targetId, sample, body }`, where `sample` is the filename or null;
    - `failures`: `failureDiffs` of the latest **complete dev** iteration, restricted to samples whose current role is dev, or `[]`;
    - `feedbackIds`.
  - The proposal stores `feedbackIds`.
- **Failure diffs (`failureDiffs`).**
  - One entry per compared sample whose score is below 1.
  - Each entry has `{ sample, score, fields: [{ id, expected, actual }], tables: [{ id, missing, extra, changed }] }`.
  - At most `MAX_FIELD_DIFFS = 20` mismatched fields per sample.
  - At most `MAX_ROW_DIFFS = 5` example changed rows per table, each `{ expected, actual, columns }`.
  - `missing` and `extra` are counts.
- **Revise ops.** All nine ops are allowed. `STAGE_OPS.revise` is their union.
  - The worker checks the whole template after applying the changes, using the same checks as the outputs, sections and steps stages. It also checks regex validity and checks removes in sequence.
  - The anchor round does **not** run for revise. A revised anchor is checked on the Sections tab's preview.
- **Holdout.** Holdout text, holdout failure diffs and holdout feedback never reach the drafting model. `build_context` still refuses non-dev samples.
- **Migrations and process.** Migrations are forward-only: `db/migrations/0015_workbench_feedback.sql`. Zod at every boundary. Use `mypy --strict` and ruff. Never call real LLMs from tests. CI runs `npm run format:check`.

## Review Focus

1. **A sample switched from dev to holdout after an evaluation.** Its failure diffs and any feedback that names it must not be sent to revise. (Task 4 test.)
2. **Feedback that names a holdout sample.** It is refused when created, with 400. (Task 4 test.)
3. **Accepting only some changes of a revision.** It still resolves that revision's feedback, and rejecting resolves nothing. The user's comment was considered either way, and a rejected revision leaves the feedback open for another try. (Task 4 test.)
4. **A revision that removes a section a step still uses, or adds a field no step fills.** The full-template check feeds the errors back to the model, then the job goes to `needs_review`. (Task 2 test.)
5. **No complete evaluation yet.** Revise works from the feedback alone, with `failures: []`. (Task 4 test.)

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0015_workbench_feedback.sql`
- Modify: `packages/shared/src/workbench.ts` (`DRAFT_STAGES`, `AVAILABLE_STAGES`), `packages/shared/src/drafting.ts` (`CHANGE_STAGES`, `STAGE_OPS`), `packages/shared/src/evaluation.ts` (`failureDiffs`, feedback types)
- Test: `packages/shared/test/evaluation.test.ts`, `packages/shared/test/drafting.test.ts`

**Interfaces:**
- Produces:
  - `DRAFT_STAGES = ['survey', 'outputs', 'sections', 'steps', 'references', 'revise']`
  - `AVAILABLE_STAGES` adds `'revise'`
  - `CHANGE_STAGES = ['outputs', 'sections', 'steps', 'revise']`
  - `STAGE_OPS.revise`: all nine ops, in the order outputs, sections, steps
  - `STAGE_ORDER` is unchanged, so revise never appears in `stageStates` and never blocks
  - `FEEDBACK_TARGETS = ['field', 'table', 'step', 'section'] as const`, `type FeedbackTarget`
  - `FeedbackBodySchema`: Zod, strict, `{ target, targetId, body: string 1..2000, sampleId?: uuid, iterationId?: uuid }`
  - `interface FeedbackItem { id: string; projectId: string; target: FeedbackTarget; targetId: string; sampleId: string | null; iterationId: string | null; body: string; createdAt: string; resolvedBy: string | null }`
  - `MAX_FIELD_DIFFS = 20`, `MAX_ROW_DIFFS = 5`
  - `interface FailureDiff`, which has these fields:
    - `sample: string`
    - `score: number`
    - `fields: { id: string; expected: unknown; actual: unknown }[]`
    - `tables: { id: string; missing: number; extra: number; changed: { expected: Record<string, unknown>; actual: Record<string, unknown>; columns: string[] }[] }[]`
  - `failureDiffs(samples: SampleResult[], devSampleIds: ReadonlySet<string>): FailureDiff[]`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/evaluation.test.ts`:

```ts
import { FeedbackBodySchema, MAX_FIELD_DIFFS, failureDiffs } from '../src/index.js';

describe('failureDiffs', () => {
  const result = (sampleId: string, filename: string, score: number, mismatches: number): SampleResult => ({
    sampleId,
    filename,
    jobId: `j-${sampleId}`,
    status: 'succeeded',
    error: null,
    comparison: {
      score,
      fields: [
        { id: 'ok', expected: 'a', actual: 'a', match: true },
        ...Array.from({ length: mismatches }, (_, i) => ({ id: `f${i}`, expected: 'e', actual: 'x', match: false })),
      ],
      tables: [
        {
          id: 'items',
          expected: 2,
          actual: 2,
          matched: 1,
          missing: [{ name: 'Nut' }],
          extra: [],
          changed: Array.from({ length: 7 }, () => ({ expected: { qty: 1 }, actual: { qty: 2 }, columns: ['qty'] })),
          cells: 1,
          cellsTotal: 2,
          columns: {},
        },
      ],
    },
  });

  it('keeps only imperfect dev samples, capped', () => {
    const diffs = failureDiffs(
      [result('s1', 'a.pdf', 0.5, 25), result('s2', 'b.pdf', 1, 0), result('s3', 'c.pdf', 0.2, 1)],
      new Set(['s1', 's2']),
    );
    expect(diffs.map((d) => d.sample)).toEqual(['a.pdf']);
    expect(diffs[0]!.fields).toHaveLength(MAX_FIELD_DIFFS);
    expect(diffs[0]!.fields[0]).toEqual({ id: 'f0', expected: 'e', actual: 'x' });
    expect(diffs[0]!.tables).toEqual([
      expect.objectContaining({ id: 'items', missing: 1, extra: 0 }),
    ]);
    expect(diffs[0]!.tables[0]!.changed).toHaveLength(5);
  });

  it('skips samples without a comparison or a sample id', () => {
    expect(
      failureDiffs([{ ...result('s1', 'a.pdf', 0.5, 1), comparison: null }, { ...result('s1', 'a.pdf', 0.5, 1), sampleId: null }], new Set(['s1'])),
    ).toEqual([]);
  });
});

describe('FeedbackBodySchema', () => {
  it('accepts a targeted comment and rejects bad targets and empty bodies', () => {
    expect(FeedbackBodySchema.safeParse({ target: 'field', targetId: 'sent_on', body: 'Use the executed copy' }).success).toBe(true);
    expect(FeedbackBodySchema.safeParse({ target: 'page', targetId: 'x', body: 'b' }).success).toBe(false);
    expect(FeedbackBodySchema.safeParse({ target: 'field', targetId: 'Sent On', body: 'b' }).success).toBe(false);
    expect(FeedbackBodySchema.safeParse({ target: 'field', targetId: 'x', body: '' }).success).toBe(false);
    expect(FeedbackBodySchema.safeParse({ target: 'field', targetId: 'x', body: 'b', extra: 1 }).success).toBe(false);
  });
});
```

Append to `packages/shared/test/drafting.test.ts`:

```ts
describe('revise stage', () => {
  it('accepts every op and never blocks or is blocked', () => {
    const body = {
      notes: '',
      changes: [
        { op: 'putField', field: { id: 'a', type: 'text' }, reason: 'r' },
        { op: 'removeSection', id: 'sig', reason: 'r' },
        { op: 'setPreamble', preamble: 'x', reason: 'r' },
      ],
    };
    expect(parseChangeBody('revise', body)?.changes).toHaveLength(3);
    expect(blockingStage(stageStates([], []), 'revise')).toBeNull();
    expect(stageStates([], []).map((s) => s.stage)).not.toContain('revise');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared`
Expected: FAIL. `failureDiffs` is not exported, and `parseChangeBody('revise', …)` does not type-check or returns null.

- [ ] **Step 3: Implement**

`db/migrations/0015_workbench_feedback.sql`:

```sql
-- Workbench phase 4c (ADR 0007): user feedback on outputs, steps and sections, and the
-- `revise` drafting stage that answers it.

CREATE TABLE workbench_feedback (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    text        NOT NULL REFERENCES workbench_projects (id),
  target        text        NOT NULL CHECK (target IN ('field', 'table', 'step', 'section')),
  target_id     text        NOT NULL,
  sample_id     uuid,
  iteration_id  uuid        REFERENCES workbench_iterations (id) ON DELETE SET NULL,
  body          text        NOT NULL,
  resolved_by   uuid        REFERENCES workbench_proposals (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_feedback_project_idx ON workbench_feedback (project_id, created_at DESC);

ALTER TABLE workbench_proposals ADD COLUMN feedback_ids uuid[];

ALTER TABLE workbench_proposals DROP CONSTRAINT workbench_proposals_stage_check;
ALTER TABLE workbench_proposals ADD CONSTRAINT workbench_proposals_stage_check
  CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references', 'revise'));
```

(Check the stage constraint name created inline in 0011. Postgres names it `workbench_proposals_stage_check`. Also check the 0008 `workbench_samples` primary key column name before adding any foreign key on `sample_id`. The plan deliberately adds none, because samples can be removed.)

`workbench.ts`: extend `DRAFT_STAGES` and `AVAILABLE_STAGES`.

`drafting.ts`: `CHANGE_STAGES` adds `'revise'`, and `STAGE_OPS.revise = [...STAGE_OPS.outputs, ...STAGE_OPS.sections, ...STAGE_OPS.steps]`. Define the three arrays first and compose them, so the union never drifts.

`evaluation.ts`:

```ts
export const FEEDBACK_TARGETS = ['field', 'table', 'step', 'section'] as const;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

export const FeedbackBodySchema = z
  .object({
    target: z.enum(FEEDBACK_TARGETS),
    targetId: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    body: z.string().trim().min(1).max(2000),
    sampleId: z.string().uuid().optional(),
    iterationId: z.string().uuid().optional(),
  })
  .strict();

export interface FeedbackItem {
  id: string;
  projectId: string;
  target: FeedbackTarget;
  targetId: string;
  sampleId: string | null;
  iterationId: string | null;
  body: string;
  createdAt: string;
  /** The revise proposal that answered it (accepted or partly accepted); null while open. */
  resolvedBy: string | null;
}

export const MAX_FIELD_DIFFS = 20;
export const MAX_ROW_DIFFS = 5;

export interface FailureDiff {
  sample: string;
  score: number;
  fields: { id: string; expected: unknown; actual: unknown }[];
  tables: {
    id: string;
    missing: number;
    extra: number;
    changed: { expected: Record<string, unknown>; actual: Record<string, unknown>; columns: string[] }[];
  }[];
}

/** What a revise call sees of an evaluation: dev samples that scored below 1, trimmed. */
export function failureDiffs(samples: SampleResult[], devSampleIds: ReadonlySet<string>): FailureDiff[] {
  return samples.flatMap((s) => {
    const c = s.comparison;
    if (!c || c.score >= 1 || s.sampleId === null || !devSampleIds.has(s.sampleId)) return [];
    return [
      {
        sample: s.filename,
        score: c.score,
        fields: c.fields
          .filter((f) => !f.match)
          .slice(0, MAX_FIELD_DIFFS)
          .map(({ id, expected, actual }) => ({ id, expected, actual })),
        tables: c.tables
          .filter((t) => t.missing.length || t.extra.length || t.changed.length)
          .map((t) => ({
            id: t.id,
            missing: t.missing.length,
            extra: t.extra.length,
            changed: t.changed.slice(0, MAX_ROW_DIFFS),
          })),
      },
    ];
  });
}
```

(`evaluation.ts` needs `import { z } from 'zod'`.)

- [ ] **Step 4: Run tests, fix fallout**

Run: `npx vitest run packages/shared && npm run typecheck`. Check the **exit code**.
Expected: the shared tests PASS. Fix every switch or record over `ChangeStage` or `DraftStage` that the typecheck flags:
- the web `StagePanel` `PROPOSE` map: add `revise: 'Propose a revision'`;
- any `Record<DraftStage, …>`;
- the skip route, if it type-checks against the stage list.

Make the API skip route return 400 `stage revise cannot be skipped` for `revise`, and add that assertion to an existing skip test.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0015_workbench_feedback.sql packages/shared apps
git commit -m "Workbench: migration 0015, revise stage and feedback / failure-diff contracts"
```

---

### Task 2: Worker: the revise stage

**Files:**
- Modify: `worker/src/ingest_worker/draft_stages.py`, `worker/src/ingest_worker/drafting.py`
- Test: `worker/tests/test_draft_stages.py`, `worker/tests/test_drafting.py`

**Interfaces:**
- Consumes: the `OUTPUTS`, `SECTIONS` and `STEPS` stages and their converters and checks (3b); `apply_changes`.
- Produces:
  - `draft_stages.REVISE`: a `Stage` with `REVISE_SCHEMA`, `convert_revise` and `check_revise`
  - `drafting.STAGES` includes `revise`, and `CHANGE_STAGE_IDS` includes `"revise"`
  - `DraftParams` gains `feedback: list[dict[str, Any]] = []`, `failures: list[dict[str, Any]] = []` and `feedback_ids: list[str] = Field(default_factory=list, alias="feedbackIds")`
  - `build_context(..., feedback=None, failures=None)` adds `<feedback>` and `<evaluation_failures>` blocks when they are non-empty

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_draft_stages.py` (reuse that file's `run`, `DRAFT`, `output_item`, `step_item` and `section_item` helpers):

```python
from ingest_worker.draft_stages import REVISE


def nested(op: str, key: str, item: dict[str, Any]) -> dict[str, Any]:
    payload = {k: v for k, v in item.items() if k not in ("op", "reason")}
    change: dict[str, Any] = {"op": op, "field": None, "table": None, "section": None, "step": None, "reason": "r"}
    change[key] = payload
    return change


def test_revise_converts_mixed_ops_in_order_and_validates_the_whole_template() -> None:
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}], "tables": []}, "pipeline": [
        {"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}
    ]}
    changes = [
        nested("putField", "field", output_item(id="ref", description="Reference")),
        nested("putStep", "step", step_item(id="tail", fields=["ref"])),
        nested("putSection", "section", section_item(id="approval", anchor="^APPROVAL")),
    ]
    body, errors = run(REVISE, {"notes": "n", "changes": changes}, draft)
    assert errors == []
    assert [c["op"] for c in body["changes"]] == ["putField", "putStep", "putSection"]
    assert body["changes"][0]["field"] == {"id": "ref", "description": "Reference"}


def test_revise_reports_template_breakage_and_missing_payloads() -> None:
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}], "tables": []}, "pipeline": [
        {"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}
    ]}
    _, errors = run(REVISE, {"notes": "", "changes": [nested("putField", "field", output_item(id="orphan"))]}, draft)
    assert any("not filled by any step" in e for e in errors)
    _, errors = run(REVISE, {"notes": "", "changes": [{"op": "putField", "field": None, "table": None, "section": None, "step": None, "reason": "r"}]}, draft)
    assert any("changes[0]" in e and "field" in e for e in errors)
```

Append to `worker/tests/test_drafting.py`:

```python
def test_revise_job_sees_feedback_and_dev_failures(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    draft = {
        **DRAFT,
        "outputs": {"fields": [{"id": "sender"}], "tables": []},
        "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
    }
    provider.responses = [
        {
            "notes": "",
            "changes": [
                {
                    "op": "putStep", "field": None, "table": None, "section": None, "reason": "feedback",
                    "step": {
                        "id": "head", "type": "extract", "fields": ["sender"], "table": None, "sections": ["all"],
                        "instructions": "Use the letterhead", "pageImages": None, "chunkPages": None, "context": None,
                        "description": None, "values": None, "reference": None, "aliases": None, "preamble": None,
                    },
                }
            ],
        }
    ]
    feedback = [{"target": "field", "targetId": "sender", "sample": "a.pdf", "body": "Take the letterhead name"}]
    failures = [{"sample": "a.pdf", "score": 0.5, "fields": [{"id": "sender", "expected": "Acme", "actual": "Bob"}], "tables": []}]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=draft, feedback=feedback, failures=failures, feedbackIds=["f1"])])
    run_once(queue, deps, "w1")
    assert queue.completed
    [(_, request)] = provider.calls
    assert "<feedback>" in request.prompt and "Take the letterhead name" in request.prompt
    assert "<evaluation_failures>" in request.prompt and '"actual": "Bob"' in request.prompt
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert body["changes"][0]["step"]["instructions"] == "Use the letterhead"
    assert "anchorCheck" not in body
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_draft_stages.py tests/test_drafting.py -q`
Expected: FAIL. `REVISE` cannot be imported.

- [ ] **Step 3: Implement**

`draft_stages.py`, appended after `SECTIONS`:

```python
def _item_schema(stage_schema: dict[str, Any]) -> dict[str, Any]:
    """A stage's flat change item without op/reason, nullable: the revise payload."""
    item = stage_schema["properties"]["changes"]["items"]
    props = {k: v for k, v in item["properties"].items() if k not in ("op", "reason")}
    return {"type": ["object", "null"], "additionalProperties": False, "required": list(props), "properties": props}


_OUTPUT_ITEM = _item_schema(OUTPUTS_SCHEMA)
_SECTION_ITEM = _item_schema(SECTIONS_SCHEMA)
_STEP_ITEM = _item_schema(STEPS_SCHEMA)

#: op -> (stage whose converter handles it, key of its payload in a revise change)
_REVISE_GROUPS: dict[str, tuple[Stage, str]] = {
    **{op: (OUTPUTS, "field") for op in ("putField", "removeOutput")},
    "putTable": (OUTPUTS, "table"),
    **{op: (SECTIONS, "section") for op in ("putSection", "removeSection", "setCopies")},
    **{op: (STEPS, "step") for op in ("putStep", "removeStep", "setPreamble")},
}

REVISE_SCHEMA = _body(
    _object(
        {
            "op": _ops(*_REVISE_GROUPS),
            "field": _OUTPUT_ITEM,
            "table": _OUTPUT_ITEM,
            "section": _SECTION_ITEM,
            "step": _STEP_ITEM,
            "reason": _S,
        }
    )
)


def convert_revise(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    changes: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, c in enumerate(data["changes"]):
        stage, key = _REVISE_GROUPS[c["op"]]
        payload = c.get(key)
        if not isinstance(payload, dict):
            errors.append(f"changes[{i}]: {c['op']} needs its {key} object")
            continue
        assert stage.convert is not None
        body, errs = stage.convert({"notes": "", "changes": [{**payload, "op": c["op"], "reason": c["reason"]}]})
        errors += [e.replace("changes[0]", f"changes[{i}]", 1) for e in errs]
        changes += body["changes"]
    return {"notes": data["notes"], "changes": changes}, errors


def check_revise(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    """Every op's checks over the whole revision (each check inspects only its own ops and
    applies earlier changes in sequence), then the complete template."""
    errors: list[str] = []
    for check in (check_outputs, check_sections, check_steps):
        errors += [e for e in check(body, draft) if e not in errors]
    return errors


REVISE = Stage(
    "revise",
    """\
Task: revise the current draft so it answers the user's feedback and fixes the evaluation
failures (expected vs actual values on the dev samples).
- Propose only the changes needed; each change has op and exactly one payload object:
  - field (putField, removeOutput): id, name, type, description, enum, columns as for outputs;
  - table (putTable): id, name, description, columns;
  - section (putSection, removeSection, setCopies): id, anchor, required, description,
    copiesSelect;
  - step (putStep, removeStep, setPreamble): id, type, fields, table, sections, instructions,
    pageImages, chunkPages, context, description, values, reference, aliases, preamble.
  Set the other payload objects to null, and null for keys that do not apply.
- The template must stay valid: every field and table filled by exactly one step; steps only
  use existing sections; context only from earlier steps.
- Prefer clearer instructions, better anchors or more precise field descriptions over adding
  outputs. reason: which feedback item or failure the change addresses.
- notes: anything you could not fix and why.
Return JSON only.""",
    REVISE_SCHEMA,
    convert_revise,
    check_revise,
)
```

(`check_outputs` errors "propose at least one field or table" when nothing remains, which is fine for a revision. Check the exact check-function names in the file. Prefix `removeOutput`'s payload key with `field`, as the brief shows: a remove carries only `id`, so either payload works.)

`drafting.py`:
- Register `REVISE` in `STAGES` and add `"revise"` to `CHANGE_STAGE_IDS`.
- `DraftParams`: add `feedback: list[dict[str, Any]] = Field(default_factory=list)`, `failures: list[dict[str, Any]] = Field(default_factory=list)` and `feedback_ids: list[str] = Field(default_factory=list, alias="feedbackIds")`.
- `build_context`: add keywords `feedback: list[dict[str, Any]] | None = None` and `failures: list[dict[str, Any]] | None = None`. After the survey block:

```python
    if feedback:
        lines = [
            f"- [{f.get('target')} {f.get('targetId')}]"
            + (f" (sample {f['sample']})" if f.get("sample") else "")
            + f": {f.get('body', '')}"
            for f in feedback
        ]
        blocks.append("<feedback>\n" + "\n".join(lines) + "\n</feedback>")
    if failures:
        blocks.append(
            f"<evaluation_failures>\n{json.dumps(failures, indent=1, ensure_ascii=False)}\n</evaluation_failures>"
        )
```

- `run_draft`: pass `feedback=params.feedback, failures=params.failures` to `build_context`. The sections anchor round stays `if stage.id == "sections"`, so revise skips it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "Worker: revise drafting stage (feedback and dev failures in, any change op out)"
```

---

### Task 3: API repo: feedback and proposal feedback ids

**Files:**
- Modify: `apps/api/src/workbench/repo.ts`, `apps/api/test/integration/workbench-pg.test.ts`
- Test: `apps/api/test/workbench-feedback-repo.test.ts` (new)

**Interfaces:**
- Produces (`WorkbenchRepo`):
  - `createFeedback(input: Omit<FeedbackItem, 'id' | 'createdAt' | 'resolvedBy'>): Promise<FeedbackItem>`
  - `listFeedback(projectId: string): Promise<FeedbackItem[]>`, newest first
  - `deleteFeedback(projectId: string, id: string): Promise<'deleted' | 'resolved' | 'not-found'>`. Only open items are deleted.
  - `resolveFeedback(projectId: string, ids: string[], proposalId: string): Promise<void>`. It sets `resolvedBy` on the open items among `ids`.
  - `ProposalRecord.feedbackIds: string[] | null`; `createProposal` accepts `feedbackIds?: string[] | null`.
  - Memory timestamps use the monotonic clock.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-feedback-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

const item = { projectId: 'letter', target: 'field' as const, targetId: 'sender', sampleId: null, iterationId: null, body: 'Use the letterhead' };

describe('feedback persistence', () => {
  it('lists newest first, resolves once and only deletes open items', async () => {
    const { workbench, repo } = await setup();
    const a = await workbench.createFeedback(item);
    const b = await workbench.createFeedback({ ...item, targetId: 'date' });
    expect((await workbench.listFeedback('letter')).map((f) => f.id)).toEqual([b.id, a.id]);
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({ id: job.id, projectId: 'letter', stage: 'revise', briefVersion: null, feedbackIds: [a.id] });
    await workbench.resolveFeedback('letter', [a.id], job.id);
    expect((await workbench.listFeedback('letter')).find((f) => f.id === a.id)?.resolvedBy).toBe(job.id);
    expect(await workbench.deleteFeedback('letter', a.id)).toBe('resolved');
    expect(await workbench.deleteFeedback('letter', b.id)).toBe('deleted');
    expect(await workbench.deleteFeedback('letter', b.id)).toBe('not-found');
    expect(await workbench.deleteFeedback('other', a.id)).toBe('not-found');
  });

  it('records the feedback a proposal was made from', async () => {
    const { workbench, repo } = await setup();
    const job = await repo.createDraftJob('letter', {});
    const p = await workbench.createProposal({ id: job.id, projectId: 'letter', stage: 'revise', briefVersion: null, feedbackIds: ['00000000-0000-4000-8000-000000000001'] });
    expect(p.feedbackIds).toEqual(['00000000-0000-4000-8000-000000000001']);
    const q = await workbench.createProposal({ id: (await repo.createDraftJob('letter', {})).id, projectId: 'letter', stage: 'outputs', briefVersion: null });
    expect(q.feedbackIds).toBeNull();
  });
});
```

Extend the opt-in Pg integration test with the same behaviour. Use a real draft job for `resolved_by` (it is a foreign key to proposals).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-feedback-repo.test.ts`
Expected: FAIL. `workbench.createFeedback` is not a function.

- [ ] **Step 3: Implement**

Memory: `feedback: FeedbackItem[]`, using the monotonic clock and `randomUUID()`.

Pg, following the existing style:

```ts
  async createFeedback(f: Omit<FeedbackItem, 'id' | 'createdAt' | 'resolvedBy'>) {
    const { rows } = await this.pool.query<FeedbackRow>(
      `INSERT INTO workbench_feedback (project_id, target, target_id, sample_id, iteration_id, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [f.projectId, f.target, f.targetId, f.sampleId, f.iterationId, f.body],
    );
    return toFeedback(rows[0]!);
  }

  async listFeedback(projectId: string) {
    const { rows } = await this.pool.query<FeedbackRow>(
      'SELECT * FROM workbench_feedback WHERE project_id = $1 ORDER BY created_at DESC, id DESC',
      [projectId],
    );
    return rows.map(toFeedback);
  }

  async deleteFeedback(projectId: string, id: string) {
    const { rows } = await this.pool.query<{ resolved_by: string | null }>(
      'SELECT resolved_by FROM workbench_feedback WHERE project_id = $1 AND id = $2',
      [projectId, id],
    );
    if (!rows[0]) return 'not-found' as const;
    if (rows[0].resolved_by) return 'resolved' as const;
    await this.pool.query(
      'DELETE FROM workbench_feedback WHERE project_id = $1 AND id = $2 AND resolved_by IS NULL',
      [projectId, id],
    );
    return 'deleted' as const;
  }

  async resolveFeedback(projectId: string, ids: string[], proposalId: string) {
    if (!ids.length) return;
    await this.pool.query(
      `UPDATE workbench_feedback SET resolved_by = $3
        WHERE project_id = $1 AND id = ANY($2::uuid[]) AND resolved_by IS NULL`,
      [projectId, ids, proposalId],
    );
  }
```

Proposals: `createProposal` inserts `feedback_ids` (`p.feedbackIds ?? null`), and `toProposal` maps `feedback_ids` to `feedbackIds`. Callers validate ids as uuids before querying (Task 4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`. Check the typecheck **exit code**.
Expected: PASS. If Docker is available, run the opt-in `workbench-pg` test on a **throwaway** container and record the result.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: feedback persistence and the feedback a proposal answers"
```

---

### Task 4: API routes: feedback, revise, resolving

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-revise.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1 and 3; `sampleViews`, `iterationView`, the 3b stage start and decision routes.
- Produces:
  - `GET /api/workbench/projects/:id/feedback` returns `FeedbackItem[]`
  - `POST /api/workbench/projects/:id/feedback` with `FeedbackBodySchema` returns 201 `FeedbackItem`. It returns 400 for a non-dev or unknown sample (`feedback can only refer to dev samples`) and 400 for an unknown iteration.
  - `DELETE /api/workbench/projects/:id/feedback/:fid` returns 204. It returns 409 `resolved feedback cannot be deleted` and 404 for an unknown id.
  - `POST /stages/revise` follows the Global Constraints.
  - The decision route: accepting (or partly accepting) a `revise` proposal calls `resolveFeedback(projectId, record.feedbackIds ?? [], pid)` after the draft is updated. Rejecting resolves nothing.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-revise.test.ts`. Build its scaffolding from `apps/api/test/workbench-evaluation.test.ts`, the 4a helpers that create a project, add ready samples, verify references, evaluate and finish jobs. Add a `finishDraft` helper like the 3b stage tests use, which marks a draft job succeeded with a body in the runs bucket.

```ts
describe('feedback', () => {
  it('only refers to dev samples', async () => {
    const { app, add, setRole } = await project();
    const dev = await add(1);
    const hold = await add(2);
    await setRole(hold.id, 'holdout');
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/workbench/projects/letter/feedback', payload });
    expect((await post({ target: 'field', targetId: 'sender', body: 'Letterhead', sampleId: dev.id })).statusCode).toBe(201);
    const refused = await post({ target: 'field', targetId: 'sender', body: 'x', sampleId: hold.id });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('feedback can only refer to dev samples');
    expect((await post({ target: 'field', targetId: 'sender', body: 'x', iterationId: crypto.randomUUID() })).statusCode).toBe(400);
  });

  it('deletes open feedback only', async () => {
    const { app, feedback, workbench, repo } = await project();
    const f = await feedback({ target: 'step', targetId: 'head', body: 'Read the letterhead' });
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({ id: job.id, projectId: 'letter', stage: 'revise', briefVersion: null, feedbackIds: [f.id] });
    await workbench.resolveFeedback('letter', [f.id], job.id);
    const res = await app.inject({ method: 'DELETE', url: `/api/workbench/projects/letter/feedback/${f.id}` });
    expect(res.statusCode).toBe(409);
  });
});

describe('revise', () => {
  it('needs open feedback and an open draft, and is never blocked by the stage order', async () => {
    const { start, feedback } = await project();
    const none = await start('revise');
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('add feedback before asking for a revision');
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    expect((await start('revise')).statusCode).toBe(202); // survey not done: revise is outside the order
  });

  it('sends open feedback and dev-only failures from the latest complete evaluation', async () => {
    const { start, feedback, repo, add, verify, evaluate, finish, setRole } = await project();
    const a = await add(1);
    const b = await add(2);
    await verify(a, 'Acme');
    await verify(b, 'Globex');
    await evaluate();
    const runs = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId).map((r) => r.job);
    for (const job of runs) await finish(job.id, 'Wrong');
    await setRole(b.id, 'holdout'); // switched after the evaluation: must not be sent
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead', sampleId: a.id });
    const res = await start('revise');
    const params = repo.draftJobs.get(res.json().id)!.params as Record<string, unknown>;
    expect(params.feedback).toEqual([{ target: 'field', targetId: 'sender', sample: 's1.pdf', body: 'Letterhead' }]);
    expect((params.failures as { sample: string }[]).map((f) => f.sample)).toEqual(['s1.pdf']);
    expect(params.feedbackIds).toHaveLength(1);
  });

  it('works from feedback alone before any evaluation', async () => {
    const { start, feedback, repo } = await project();
    await feedback({ target: 'section', targetId: 'all', body: 'Split the approvals off' });
    const res = await start('revise');
    expect((repo.draftJobs.get(res.json().id)!.params as Record<string, unknown>).failures).toEqual([]);
  });

  it('resolves its feedback when accepted, even partly, and not when rejected', async () => {
    const { app, start, feedback, finishDraft, decide } = await project();
    const f = await feedback({ target: 'field', targetId: 'sender', body: 'Describe it' });
    const first = (await start('revise')).json();
    await finishDraft(first.id, 'revise', {
      notes: '',
      changes: [
        { op: 'putField', field: { id: 'sender', type: 'text', description: 'Who' }, reason: 'feedback' },
        { op: 'setPreamble', preamble: 'Letters.', reason: 'feedback' },
      ],
    });
    await decide(first.id, { decision: 'rejected' });
    const open = async () => (await app.inject('/api/workbench/projects/letter/feedback')).json().find((x: { id: string }) => x.id === f.id);
    expect((await open()).resolvedBy).toBeNull();
    const second = (await start('revise')).json();
    await finishDraft(second.id, 'revise', {
      notes: '',
      changes: [{ op: 'putField', field: { id: 'sender', type: 'text', description: 'Who' }, reason: 'feedback' }, { op: 'setPreamble', preamble: 'x', reason: 'r' }],
    });
    expect((await decide(second.id, { decision: 'accepted', changes: [0] })).statusCode).toBe(200);
    expect((await open()).resolvedBy).toBe(second.id);
  });

  it('cannot be skipped', async () => {
    const { app } = await project();
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/revise/skip' });
    expect(res.statusCode).toBe(400);
  });
});
```

(These helpers come from the earlier 3b/4a test files: `project`, `add`, `setRole` via `PATCH /samples/:sid`, `verify`, `evaluate`, `finish`, `start`, `finishDraft`, `decide`, and `feedback`, which POSTs `/feedback` and returns the JSON. Copy them, keep the assertions, and name locals other than `it`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-revise.test.ts`
Expected: FAIL. `/feedback` returns 404.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/workbench.ts`:
- **Feedback routes:**
  - `POST` parses `FeedbackBodySchema`.
  - If `sampleId` is set, the sample must be in `sampleViews(app, projectId)` with `view.role === 'dev'`; otherwise 400 `feedback can only refer to dev samples`.
  - If `iterationId` is set, `workbench.getIteration(projectId, iterationId)` must exist; otherwise 400 `unknown iteration`.
  - `DELETE` validates `fid` as a uuid (404 otherwise) and maps `deleteFeedback` results to 204 / 409 / 404.
- **Revise start.** In the stage start route, `revise` goes through the change-stage path, which already requires an open draft and records the base. `blockingStage` returns null for revise because it is not in `STAGE_ORDER`. Before creating the job:
  1. Load the open feedback: `(await workbench.listFeedback(projectId)).filter((f) => f.resolvedBy === null)`. If there is none, 409 `add feedback before asking for a revision`.
  2. Find the current ready dev samples and their ids, `dev`.
  3. Drop any feedback whose `sampleId` is set but not in `dev`.
  4. `feedback` = each item as `{ target, targetId, sample: filename or null, body }`.
  5. `failures`: take the newest iteration with `set === 'dev'` whose view `status === 'complete'`, and compute `failureDiffs(view.samples, new Set(devIds))`. With no such iteration, use `[]`.
  6. Add `{ feedback, failures, feedbackIds: open.map((f) => f.id) }` to the job params, and pass `feedbackIds` to `createProposal`.
- **Skip.** For `revise`, return 400 `stage revise cannot be skipped` (Task 1 may already have done this; keep a single implementation).
- **Decision.** After `templates.updateDraft` succeeds, for `record.stage === 'revise'` (accepted or partially accepted), call `await workbench.resolveFeedback(projectId, record.feedbackIds ?? [], pid)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`. Check the typecheck **exit code**.
Expected: PASS, including the `access.test.ts` sweep.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: feedback routes, the revise stage (dev-only failures) and resolving feedback"
```

---

### Task 5: Web: the Revise tab and commenting from the scorecard

**Files:**
- Create: `apps/web/src/workbench/ReviseTab.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/workbench/EvaluateTab.tsx`, `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/router.ts`
- Test: `apps/web/test/ReviseTab.test.tsx` (new), `apps/web/test/EvaluateTab.test.tsx`, `apps/web/test/client.test.ts`, `apps/web/test/router.test.ts`

**Interfaces:**
- Produces:
  - Api:
    - `listFeedback(projectId): Promise<FeedbackItem[]>`
    - `addFeedback(projectId, body: { target; targetId; body; sampleId?; iterationId? }): Promise<FeedbackItem>`
    - `deleteFeedback(projectId, feedbackId): Promise<void>`
    - fake-api defaults: `listFeedback` returns `[]`; the others throw "not stubbed". Builder `feedbackItem(overrides?)`.
  - `PROJECT_TABS` adds `'revise'` after `'evaluate'`, with the label "Revise".
  - `ReviseTab({ api, projectId, dataPolicy, hasDraft, pollMs, onApplied })`:
    - **Add form:** a select labelled "About", with the options field, table, step and section; an input labelled "Id"; a textarea labelled "Feedback"; and an **Add feedback** button.
    - **Feedback table:** labelled "Feedback", with target, id, sample, body and status ("open", or "resolved"). Open items have **Delete**.
    - **Revision panel:** below the table, `StagePanel` with `stage="revise"`, whose button is "Propose a revision". Applying a revision reloads the feedback list.
  - EvaluateTab drill-down: each field row in `Fields in <file>` gets a **Comment** button. It opens an inline form labelled `Comment on <field>`, with a textarea and a **Save comment** button. That calls `addFeedback(projectId, { target: 'field', targetId, body, sampleId, iterationId })`, then shows "Comment saved; see the Revise tab".

- [ ] **Step 1: Write the failing tests**

`client.test.ts`:

```ts
describe('http api: feedback', () => {
  it('lists, adds and deletes feedback', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : respond(200, []),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listFeedback('letter');
    await api.addFeedback('letter', { target: 'field', targetId: 'sender', body: 'Letterhead' });
    await api.deleteFeedback('letter', 'f1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [init?.method ?? 'GET', url, init?.body ? JSON.parse(String(init.body)) : undefined]);
    expect(calls).toEqual([
      ['GET', '/api/workbench/projects/letter/feedback', undefined],
      ['POST', '/api/workbench/projects/letter/feedback', { target: 'field', targetId: 'sender', body: 'Letterhead' }],
      ['DELETE', '/api/workbench/projects/letter/feedback/f1', undefined],
    ]);
  });
});
```

`router.test.ts` row: `['#/workbench/letter/revise', { name: 'project', projectId: 'letter', tab: 'revise' }]`.

`apps/web/test/ReviseTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviseTab } from '../src/workbench/ReviseTab.js';
import { fakeApi, feedbackItem } from './fake-api.js';

function tab(overrides = {}) {
  const api = fakeApi(overrides);
  render(<ReviseTab api={api} projectId="letter" dataPolicy="local" hasDraft pollMs={1} onApplied={vi.fn()} />);
  return api;
}

describe('ReviseTab', () => {
  it('adds feedback', async () => {
    const added = feedbackItem({ targetId: 'sender', body: 'Use the letterhead' });
    const listFeedback = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([added]);
    const api = tab({ listFeedback, addFeedback: vi.fn(async () => added) });
    await userEvent.selectOptions(await screen.findByLabelText('About'), 'field');
    await userEvent.type(screen.getByLabelText('Id'), 'sender');
    await userEvent.type(screen.getByLabelText('Feedback'), 'Use the letterhead');
    await userEvent.click(screen.getByRole('button', { name: 'Add feedback' }));
    expect(api.addFeedback).toHaveBeenCalledWith('letter', { target: 'field', targetId: 'sender', body: 'Use the letterhead' });
    const table = await screen.findByRole('table', { name: 'Feedback' });
    expect(within(table).getByText('Use the letterhead')).toBeInTheDocument();
  });

  it('shows resolved feedback without Delete and deletes open feedback', async () => {
    const open = feedbackItem({ body: 'Open one' });
    const done = feedbackItem({ body: 'Done one', resolvedBy: 'p1' });
    const api = tab({ listFeedback: vi.fn(async () => [open, done]), deleteFeedback: vi.fn(async () => undefined) });
    const table = await screen.findByRole('table', { name: 'Feedback' });
    const doneRow = within(table).getByText('Done one').closest('tr')!;
    expect(within(doneRow).getByText('resolved')).toBeInTheDocument();
    expect(within(doneRow).queryByRole('button', { name: 'Delete' })).toBeNull();
    await userEvent.click(within(within(table).getByText('Open one').closest('tr')!).getByRole('button', { name: 'Delete' }));
    expect(api.deleteFeedback).toHaveBeenCalledWith('letter', open.id);
  });

  it('offers a revision', async () => {
    tab({ listFeedback: vi.fn(async () => [feedbackItem()]) });
    expect(await screen.findByRole('button', { name: 'Propose a revision' })).toBeInTheDocument();
  });
});
```

`EvaluateTab.test.tsx`:

```tsx
  it('comments on a field from the drill-down', async () => {
    const latest = iterationView();
    const { api } = tab({
      listIterations: vi.fn(async () => [latest]),
      getIteration: vi.fn(async () => latest),
      addFeedback: vi.fn(async () => feedbackItem()),
    });
    const samples = await screen.findByRole('table', { name: 'Samples' });
    await userEvent.click(within(within(samples).getByText('a.pdf').closest('tr')!).getByRole('button', { name: 'Details' }));
    const detail = screen.getByRole('table', { name: 'Fields in a.pdf' });
    await userEvent.click(within(within(detail).getByText('sent_on').closest('tr')!).getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByLabelText('Comment on sent_on'), 'Dates are DMY');
    await userEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'sent_on',
      body: 'Dates are DMY',
      sampleId: 's1',
      iterationId: latest.id,
    });
    expect(await screen.findByText('Comment saved; see the Revise tab')).toBeInTheDocument();
  });
```

(Import `feedbackItem` in that test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/client.test.ts apps/web/test/router.test.ts apps/web/test/ReviseTab.test.tsx apps/web/test/EvaluateTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `client.ts`: the three methods, following the existing patterns. `deleteFeedback` uses `apiFetch(…, { method: 'DELETE' })` and checks `ok` the way other deletes do.
- `fake-api.ts`: the defaults and this builder:

```ts
export function feedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    target: 'field',
    targetId: 'sender',
    sampleId: null,
    iterationId: null,
    body: 'Use the letterhead name',
    createdAt: '2026-10-12T10:00:00.000Z',
    resolvedBy: null,
    ...overrides,
  };
}
```

- `ReviseTab.tsx`:
  - Load `listFeedback` on mount.
  - Form state: `target` (default 'field'), `targetId` and `body`. Add sends `{ target, targetId, body }`, clears the form and reloads.
  - Busy guard and `role="alert"` errors, following `StagePanel`'s conventions.
  - The table rows show `f.target`, `f.targetId`, `f.sampleId ? 'sample' : ''`, `f.body` and `f.resolvedBy ? 'resolved' : 'open'`, with **Delete** only on open items.
  - Below: `<StagePanel api={api} projectId={projectId} stage="revise" dataPolicy={dataPolicy} hasDraft={hasDraft} pollMs={pollMs} onApplied={() => { onApplied(); void reload(); }} onSkipped={() => undefined} />`. `StagePanel` shows a Skip button, which the API refuses for revise. Add a `canSkip?: boolean` prop to `StagePanel` (default true), pass `canSkip={false}`, and hide Skip when it is false. Update the `StagePanel` tests accordingly.
- `EvaluateTab.tsx`, in the drill-down field rows:
  - A **Comment** button sets `commenting = { targetId: f.id, sampleId: opened.sampleId }`.
  - When `commenting` matches the row, render `<label>Comment on {f.id}<textarea …/></label>` and a **Save comment** button.
  - **Save comment** calls `api.addFeedback(projectId, { target: 'field', targetId, body, ...(sampleId ? { sampleId } : {}), iterationId: current.id })`, then sets the message `Comment saved; see the Revise tab` (`role="status"`).
- `router.ts`: add `'revise'` after `'evaluate'`.
- `ProjectPage.tsx`: add the label and render `ReviseTab` with `onApplied={changed}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`. Check the typecheck **exit code**. No U+FFFD in any file.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: Revise tab (feedback and revisions) and commenting from the scorecard"
```

---

### Task 6: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

- [ ] **Step 1: Document it**

`CLAUDE.md`:
- **Contracts table:** add `revise` to the drafting-changes row. TS: `STAGE_OPS.revise`, `failureDiffs`, `FeedbackBodySchema`. Python: `draft_stages.REVISE`, nested payloads.
- **Workbench bullet:**
  - Feedback lives in `workbench_feedback` (migration 0015) and can only name dev samples.
  - `revise` is a change stage outside the stage order and cannot be skipped. Its job params add open `feedback`, dev-only `failures` from the latest complete dev iteration, and `feedbackIds`.
  - Accepting a revise proposal, fully or partly, resolves its feedback.
  - Revise skips the anchor round.

`docs/architecture.md`: one paragraph on feedback and revise.

`docs/design/workbench.md`, Phasing:
- Mark 4c done: feedback, `revise`, comment from the drill-down.
- Phase 4 is complete.
- Phase 5 (holdout and publish) is next.

- [ ] **Step 2: Full check**

Run `npm run check` and `npm run format:check`, checking the exit codes. If `uv` is not on PATH, add its directory first.

- [ ] **Step 3: Smoke test (throwaway infra only)**

1. Apply migrations 0001–0015 via the opt-in `workbench-pg` test on a throwaway Postgres, then remove the container.
2. If a full stack with a local model is available:
   - Evaluate.
   - Comment on a failing field.
   - Propose a revision.
   - Apply part of it, and check the feedback shows resolved.
   - Evaluate again.
3. No external LLM calls. Record what you couldn't run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Workbench: document phase 4c (feedback and revise)"
```
