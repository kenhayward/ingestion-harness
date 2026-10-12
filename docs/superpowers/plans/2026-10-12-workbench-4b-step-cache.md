# Workbench 4b/6: Step Cache, Model Comparison and Uncached Re-runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the evaluation loop fast and informative.
- **Step cache.** A Workbench test run reuses an extract step's stored output when the step's full input is unchanged. Editing one step or the preamble only re-runs the steps whose input actually changed.
- **Fresh model calls (skip the cache).** Forces new calls, so you can check how much results vary.
- **Compare models.** Runs the same evaluation on `default`, `fast` and `draft` and shows the scorecards side by side.

**Architecture:**
- **Cache key.** The cache lives in the worker, around `run_step_extraction`. The step's prompts are rendered first (one per chunk). Each prompt already contains the preamble, the instructions, the section text and the context values from earlier steps. The key is the sha256 of a canonical JSON of:
  - those prompts;
  - the output schema, the system prompt and the page-image hashes;
  - the resolved model reference;
  - the provider options that change outputs;
  - `maxTokens` and `maxAttempts`.
- **Storage.** A hit reuses the stored output from the runs bucket (`step-cache/{key}.json`) and records a `step_runs` row with `cached = true` (migration `0014`). A miss calls the model and stores the result.
- **Who uses it.** Only Workbench test runs, meaning `process` jobs with a `project_id` and `test`. Production, regression and re-run jobs never touch it. A job with `params.uncached` skips reading the cache but still writes the fresh result.
- **API.** Evaluate gains `uncached`. A new compare route starts one iteration per model alias with a shared `groupId`, and the comparison view lines up their scorecards. Each iteration view reports how many of its step runs were served from the cache.

**Tech Stack:** Python 3.13 + pytest + mypy strict (worker), Fastify + Zod (API), React + Testing Library (web), Postgres migration.

**Spec:** [docs/design/workbench.md](../../design/workbench.md): "Evaluation" → "Step cache" (key, rules, "Re-run uncached") and "Scorecard" → model comparison. Also [ADR 0007](../../adr/0007-workbench.md).

**Depends on:** Workbench 4a ([kenhayward/ingestion-harness#49](https://github.com/kenhayward/ingestion-harness/pull/49)), merged. Migration `0013` is the latest.

## Global Constraints

- **Cache key.** It is computed by `step_cache.step_cache_key(...)`. It is the sha256 of canonical JSON (`sort_keys`, compact separators) over:
  - `v` (`CACHE_VERSION = 1`) and `model` (`provider/model-id`);
  - `options`: the provider's options **minus** the operational keys `timeoutS` and `maxRetries`;
  - `system` (the system prompt) and `schema` (the step's JSON Schema);
  - `prompts` (each rendered prompt, in chunk order);
  - `images` (sha256 of each page image);
  - `maxTokens` and `maxAttempts`.
- **Which jobs use the cache.** `job.project_id is not None and job.test and job.task == "process"`. Production jobs (no project), regression jobs (no project) and `rerun` / `publish` tasks never read or write it.
- **Uncached.** `params.uncached === true` means the job calls the model for every step and still **writes** the fresh results to the cache.
- **Storage.** Runs bucket `step-cache/{key}.json`, holding `{ "data", "modelRef", "inputTokens", "outputTokens", "createdAt" }`. Entries are keyed by content, not by project, so identical inputs share an entry. An unreadable entry counts as a miss.
- **Cache hit.**
  - No provider call is made and no prompt audit is written.
  - A `step_runs` row is recorded with `cached = true`, `attempts = 0` and null token counts.
  - An event `reused cached <step>` is logged.
- **Data policy** is unchanged. It is checked when models are resolved, which happens before any cache lookup.
- **Model comparison.** `POST /api/workbench/projects/:id/evaluations/compare` with `{ uncached?: boolean }` (strict) creates one iteration per alias in `EVALUATION_MODELS`, in that order, sharing a new `groupId`. Every precondition and error is the same as for `POST /evaluations`.
- **Comparison view.** `GET /api/workbench/projects/:id/comparisons/:groupId` returns `{ groupId, iterations: IterationView[] }` in `EVALUATION_MODELS` order. It returns 404 for an unknown group.
- **Cache statistics.** `IterationView.cache = { reused, total }` counts the iteration's jobs' **succeeded** step runs: `reused` is those with `cached = true`, and `total` is all succeeded step runs.
- **Migrations and process.** Migrations are forward-only: `db/migrations/0014_workbench_step_cache.sql`. Use `mypy --strict` and ruff. Never call real LLMs from tests. CI runs `npm run format:check`.

## Review Focus

1. **Changing one step's instructions.** That step and every step that uses its output as `context` are re-run. Every other step is a hit. (Task 3 test.)
2. **The cache must never serve a production, regression or re-run job, and never a job whose model or provider options differ.** A hit there would hide a real change. (Task 3 and Task 2 tests.)
3. **A chunked table step.** All chunk prompts form one key. A hit returns the merged rows exactly as stored. (Task 2 test.)
4. **A corrupt cache object.** It is treated as a miss and overwritten by the fresh result, never a crash. (Task 2 test.)
5. **A local-only project comparing models.** The `fast` iteration's jobs are refused by the data policy (`needs_review`). The comparison still completes and shows that column's samples as failed. (Task 4 test.)

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0014_workbench_step_cache.sql`
- Modify: `packages/shared/src/jobs.ts` (`StepRun.cached`), `packages/shared/src/evaluation.ts`
- Test: `packages/shared/test/evaluation.test.ts`

**Interfaces:**
- Produces:
  - `StepRun.cached: boolean`
  - `IterationSummary` gains `groupId: string | null` and `uncached: boolean`
  - `IterationView` gains `cache: { reused: number; total: number }`
  - `interface ComparisonView { groupId: string; iterations: IterationView[] }`
  - `interface ComparisonRow { id: string; byModel: Record<string, number | null> }`
  - `comparisonRows(iterations: IterationView[]): ComparisonRow[]`. The first row has id `score` (each iteration's overall score). It is followed by every field and `table.column` id in any iteration, sorted by id, each with that iteration's accuracy or null. Columns are keyed by `iteration.model ?? 'template'`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/evaluation.test.ts` (import `comparisonRows`, `type IterationView`):

```ts
describe('comparisonRows', () => {
  const view = (model: 'default' | 'fast' | null, score: number | null, fields: [string, number][]): IterationView => ({
    id: model ?? 'tmpl',
    projectId: 'letter',
    templateVersion: 2,
    briefVersion: null,
    set: 'dev',
    model,
    groupId: 'g1',
    uncached: false,
    createdAt: '2026-10-12T10:00:00.000Z',
    status: 'complete',
    score,
    completed: 1,
    total: 1,
    cache: { reused: 0, total: 0 },
    scorecard: {
      score,
      completed: 1,
      total: 1,
      fields: fields.map(([id, accuracy]) => ({ id, matched: 0, total: 1, accuracy })),
      columns: [],
    },
    samples: [],
  });

  it('lines up overall and per-field accuracy by model', () => {
    expect(
      comparisonRows([
        view('default', 0.5, [['sender', 1], ['date', 0]]),
        view('fast', null, [['sender', 0.5]]),
      ]),
    ).toEqual([
      { id: 'score', byModel: { default: 0.5, fast: null } },
      { id: 'date', byModel: { default: 0, fast: null } },
      { id: 'sender', byModel: { default: 1, fast: 0.5 } },
    ]);
  });

  it('labels the template-models iteration "template"', () => {
    expect(comparisonRows([view(null, 1, [])])).toEqual([{ id: 'score', byModel: { template: 1 } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/evaluation.test.ts`
Expected: FAIL. `comparisonRows` is not exported.

- [ ] **Step 3: Implement**

`db/migrations/0014_workbench_step_cache.sql`:

```sql
-- Workbench phase 4b (ADR 0007): step cache hits are recorded as step runs; iterations can be
-- grouped (model comparison) and forced to call the models again (uncached).

ALTER TABLE step_runs ADD COLUMN cached boolean NOT NULL DEFAULT false;

ALTER TABLE workbench_iterations
  ADD COLUMN group_id uuid,
  ADD COLUMN uncached boolean NOT NULL DEFAULT false;
CREATE INDEX workbench_iterations_group_idx ON workbench_iterations (group_id) WHERE group_id IS NOT NULL;
```

`jobs.ts`: add `/** Served from the workbench step cache (no model call). */ cached: boolean;` to `StepRun`.

`evaluation.ts`:

```ts
// IterationSummary gains:
  /** Shared by the iterations of one model comparison. */
  groupId: string | null;
  /** Every step called its model (the step cache was not read). */
  uncached: boolean;

// IterationView gains:
  /** Succeeded step runs of the iteration's jobs; `reused` were served from the step cache. */
  cache: { reused: number; total: number };

export interface ComparisonView {
  groupId: string;
  iterations: IterationView[];
}

export interface ComparisonRow {
  id: string;
  byModel: Record<string, number | null>;
}

/** One row per measure (overall score, then each field / table.column), one column per model. */
export function comparisonRows(iterations: IterationView[]): ComparisonRow[] {
  const label = (it: IterationView) => it.model ?? 'template';
  const ids = [
    ...new Set(
      iterations.flatMap((it) => [...it.scorecard.fields, ...it.scorecard.columns].map((a) => a.id)),
    ),
  ].sort();
  const accuracy = (it: IterationView, id: string) =>
    [...it.scorecard.fields, ...it.scorecard.columns].find((a) => a.id === id)?.accuracy ?? null;
  return [
    { id: 'score', byModel: Object.fromEntries(iterations.map((it) => [label(it), it.score])) },
    ...ids.map((id) => ({
      id,
      byModel: Object.fromEntries(iterations.map((it) => [label(it), accuracy(it, id)])),
    })),
  ];
}
```

- [ ] **Step 4: Run tests, fix fallout**

Run: `npx vitest run packages/shared && npm run typecheck` (check the **exit code**).
Expected: the shared tests PASS. The typecheck lists the places that need updating; set each new field to its neutral value. The Task 4 routes fill in the real values.
- `StepRun` literals: memory and Pg `listStepRuns` and `metricsData` mappings, plus test fakes. Set `cached`: Pg `r.cached`, Memory `false` by default.
- `IterationView` / `IterationSummary` literals: `iterationView()` in `apps/api/src/routes/workbench.ts` and the `iterationView()` builder in `apps/web/test/fake-api.ts`. Set `groupId: null`, `uncached: false`, `cache: { reused: 0, total: 0 }`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0014_workbench_step_cache.sql packages/shared apps
git commit -m "Workbench: migration 0014 and step-cache / model-comparison contracts"
```

---

### Task 2: Worker: the step cache and cached step extraction

**Files:**
- Create: `worker/src/ingest_worker/step_cache.py`, `worker/tests/test_step_cache.py`
- Modify: `worker/src/ingest_worker/extract.py` (`ExtractionResult.cached`), `worker/src/ingest_worker/llm/registry.py` (`ModelRegistry.options`), `worker/src/ingest_worker/storage.py` (`step_cache_object_key`), `worker/src/ingest_worker/pipeline.py` (`run_step_extraction(..., cache=)`)

**Interfaces:**
- Produces:
  - `step_cache.CACHE_VERSION = 1`
  - `step_cache.OPERATIONAL_OPTIONS = frozenset({"timeoutS", "maxRetries"})`
  - `step_cache.step_cache_key(*, model_ref: str, options: dict[str, Any], system: str, schema: dict[str, Any], prompts: list[str], images: tuple[bytes, ...], max_tokens: int, max_attempts: int) -> str`
  - `step_cache.CachedStep(data: dict[str, Any], model_ref: str, input_tokens: int | None, output_tokens: int | None)`, a frozen dataclass
  - `step_cache.StepCache(store: ObjectStore, bucket: str, *, read: bool = True)`, with:
    - `get(key) -> CachedStep | None`: returns None when `read` is false, the object is missing, or it is unreadable;
    - `put(key, entry: CachedStep) -> None`.
  - `storage.step_cache_object_key(key: str) -> str` returns `f"step-cache/{key}.json"`.
  - `ModelRegistry.options(provider_name: str) -> dict[str, Any]`: a copy of the provider's options without `OPERATIONAL_OPTIONS`, or `{}` for an unknown provider.
  - `ExtractionResult.cached: bool = False`
  - `pipeline.run_step_extraction(..., cache: StepCache | None = None)`. It renders every chunk's prompt first, computes the key, and on a hit returns `ExtractionResult(hit.data, hit.model_ref, [], cached=True)` without calling the provider. On a miss it runs as before, then `cache.put(...)`.

- [ ] **Step 1: Write the failing tests**

`worker/tests/test_step_cache.py`:

```python
"""Step cache (ADR 0007, phase 4b): keyed by the step's full input; reused by workbench runs."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.step_cache import CachedStep, StepCache, step_cache_key
from ingest_worker.storage import MemoryObjectStore, step_cache_object_key

BASE: dict[str, Any] = dict(
    model_ref="local/qwen",
    options={"temperature": 0},
    system="sys",
    schema={"type": "object"},
    prompts=["prompt one"],
    images=(b"img",),
    max_tokens=1000,
    max_attempts=2,
)


@pytest.mark.parametrize(
    "change",
    [
        {"model_ref": "local/other"},
        {"options": {"temperature": 0.2}},
        {"system": "other system"},
        {"schema": {"type": "object", "required": ["a"]}},
        {"prompts": ["prompt one (edited)"]},
        {"prompts": ["prompt one", "chunk two"]},
        {"images": (b"other",)},
        {"images": ()},
        {"max_tokens": 2000},
        {"max_attempts": 3},
    ],
)
def test_every_input_changes_the_key(change: dict[str, Any]) -> None:
    assert step_cache_key(**{**BASE, **change}) != step_cache_key(**BASE)


def test_the_key_is_stable_and_ignores_option_order() -> None:
    a = step_cache_key(**{**BASE, "options": {"temperature": 0, "strict": False}})
    b = step_cache_key(**{**BASE, "options": {"strict": False, "temperature": 0}})
    assert a == b and len(a) == 64


def test_registry_options_drop_operational_settings() -> None:
    registry = ModelRegistry(
        {},
        {"local": ProviderConfig(name="local", kind="openai-chat", options={"temperature": 0, "timeoutS": 900, "maxRetries": 1})},
        {},
    )
    assert registry.options("local") == {"temperature": 0}
    assert registry.options("nope") == {}


def test_cache_round_trip_and_unreadable_entries_are_misses() -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    entry = CachedStep(data={"a": 1}, model_ref="local/qwen", input_tokens=10, output_tokens=5)
    cache.put("k1", entry)
    assert cache.get("k1") == entry
    assert cache.get("missing") is None
    store.put("runs", step_cache_object_key("bad"), b"{not json", "application/json")
    assert cache.get("bad") is None
    assert StepCache(store, "runs", read=False).get("k1") is None
```

Also add tests of `run_step_extraction` with a cache to `worker/tests/test_step_cache.py`. Reuse the fixtures in `tests/test_template_pipeline.py` (`TEMPLATE`, `JOB`, `PAGES`, `RESPONSES`) and the `make()` helper in `tests/test_step_context.py`. Drive `run_step_extraction` directly for the `data` step, which is chunked. These are the behaviours to pin:

```python
def test_a_cached_chunked_step_returns_the_merged_rows_without_calling_the_model(tmp_path: Path) -> None:
    # Run the chunked `data` step once with StepCache(store, "runs"): the provider is called once
    # per chunk and the merged rows are stored. Run it again with the same inputs: no provider
    # call, result.cached is True, result.attempts == [], result.data equals the first result's.


def test_a_corrupt_cache_entry_is_a_miss_and_is_overwritten(tmp_path: Path) -> None:
    # Pre-store garbage at step_cache_object_key(<the key the step will compute>); run the step:
    # the provider IS called and the entry now parses as the fresh CachedStep.
```

To find the key in the second test, run the step once with a cache, list the store's `step-cache/` keys, overwrite that object with garbage, then run again with fresh responses.

Write both as real tests, with concrete assertions on `providers["local"].calls` counts and `result.data`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_step_cache.py -q`
Expected: FAIL. `ingest_worker.step_cache` does not exist.

- [ ] **Step 3: Implement**

`worker/src/ingest_worker/step_cache.py`:

```python
"""Workbench step cache (ADR 0007, phase 4b).

An extract step's output is reused when its full input is unchanged: the rendered prompts
(preamble, instructions, section text and context values are all inside them), the output
schema, the system prompt, the page images, the resolved model and its output-affecting
options. Entries live in the runs bucket keyed by content, so identical inputs share one."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from .storage import ObjectStore, step_cache_object_key

CACHE_VERSION = 1
#: Provider options that never change what a model answers.
OPERATIONAL_OPTIONS = frozenset({"timeoutS", "maxRetries"})


def step_cache_key(
    *,
    model_ref: str,
    options: dict[str, Any],
    system: str,
    schema: dict[str, Any],
    prompts: list[str],
    images: tuple[bytes, ...],
    max_tokens: int,
    max_attempts: int,
) -> str:
    payload = {
        "v": CACHE_VERSION,
        "model": model_ref,
        "options": options,
        "system": system,
        "schema": schema,
        "prompts": prompts,
        "images": [hashlib.sha256(image).hexdigest() for image in images],
        "maxTokens": max_tokens,
        "maxAttempts": max_attempts,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CachedStep:
    data: dict[str, Any]
    model_ref: str
    input_tokens: int | None
    output_tokens: int | None


class StepCache:
    def __init__(self, store: ObjectStore, bucket: str, *, read: bool = True) -> None:
        self._store = store
        self._bucket = bucket
        self._read = read

    def get(self, key: str) -> CachedStep | None:
        if not self._read:
            return None
        raw = self._store.get_optional(self._bucket, step_cache_object_key(key))
        if raw is None:
            return None
        try:
            entry = json.loads(raw)
            return CachedStep(
                data=dict(entry["data"]),
                model_ref=str(entry["modelRef"]),
                input_tokens=entry.get("inputTokens"),
                output_tokens=entry.get("outputTokens"),
            )
        except (ValueError, KeyError, TypeError):
            return None  # unreadable: a miss; the fresh result overwrites it

    def put(self, key: str, entry: CachedStep) -> None:
        body = {
            "data": entry.data,
            "modelRef": entry.model_ref,
            "inputTokens": entry.input_tokens,
            "outputTokens": entry.output_tokens,
            "createdAt": datetime.now(UTC).isoformat(),
        }
        self._store.put(
            self._bucket, step_cache_object_key(key), json.dumps(body).encode(), "application/json"
        )
```

(`asdict` is unused unless you choose it; remove the unused import. Use the store protocol name `storage.py` actually exports, which may be `ObjectStore`.)

- `storage.py`: `def step_cache_object_key(key: str) -> str: return f"step-cache/{key}.json"`.
- `registry.py`: add `def options(self, provider_name: str) -> dict[str, Any]` that returns `{k: v for k, v in cfg.options.items() if k not in OPERATIONAL_OPTIONS}`, or `{}`. To avoid an import cycle, define the operational set in `registry.py` and import it into `step_cache.py`, or keep a copy in sync with a test.
- `extract.py`: `ExtractionResult` gains `cached: bool = False`.
- `pipeline.run_step_extraction`: add a keyword `cache: StepCache | None = None`.
  1. Build `plan` as today, then render every prompt up front: `rendered = [(audit_id, render_prompt(...), chunk) for audit_id, chunk_sections, chunk in plan]`.
  2. If `cache` is set, compute `key = step_cache_key(model_ref=f"{provider.name}/{model_id}", options=deps.models.options(provider.name), system=SYSTEM_PROMPT, schema=ex.schema_, prompts=[p for _, p, _ in rendered], images=images, max_tokens=ex.max_tokens, max_attempts=ex.max_attempts)`. If `(hit := cache.get(key))` exists, return `ExtractionResult(hit.data, hit.model_ref, [], cached=True)`.
  3. Run the existing loop over `rendered`.
  4. After merging, if `cache` is set, `cache.put(key, CachedStep(merged.data, merged.model_ref, <sum of input tokens or None>, <sum of output tokens or None>))`.
  5. Import `SYSTEM_PROMPT` from `.extract`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS. No existing test changes, because `cache` defaults to None.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "Worker: content-keyed step cache and cached step extraction"
```

---

### Task 3: Worker: who uses the cache, and recording hits

**Files:**
- Modify: `worker/src/ingest_worker/template_pipeline.py`, `worker/src/ingest_worker/queue.py` (Pg `record_step_run` writes `cached`)
- Test: `worker/tests/test_step_cache.py`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `template_pipeline.workbench_step_cache(job: ClaimedJob, deps: PipelineDeps) -> StepCache | None`, which follows the Global Constraints.
  - `_run_step(..., cache: StepCache | None = None)`:
    - On a hit it records the step run with `"cached": True` and `"attempts": 0`, and the event `reused cached <step>`.
    - On a miss it records `"cached": False`.
  - `process_template_job` passes the cache.
  - `rerun_template_job` never does.
  - `PgJobQueue.record_step_run` inserts `cached` (default False).

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_step_cache.py`. Reuse `make`, `CONTEXT_TEMPLATE`, `CONTEXT_RESPONSES` from `tests/test_step_context.py` and `JOB`, `TEMPLATE`, `RESPONSES` from `tests/test_template_pipeline.py`.

```python
from dataclasses import replace

from ingest_worker.main import run_once

from .fakes import FakeQueue
from .test_step_context import CONTEXT_RESPONSES, CONTEXT_TEMPLATE, make
from .test_template_pipeline import JOB, RESPONSES, TEMPLATE

WORKBENCH = replace(JOB, test=True, project_id="demo", params={"dataPolicy": "local"})


def run(deps, job, template):  # type: ignore[no-untyped-def]
    queue = FakeQueue(jobs=[job], templates={("demo", 1): template})
    run_once(queue, deps, "w1")
    return queue


def test_an_unchanged_workbench_run_reuses_every_step(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES)
    run(deps, WORKBENCH, TEMPLATE)
    calls = len(providers["local"].calls)
    queue = run(deps, replace(WORKBENCH, id="job-2"), TEMPLATE)
    assert len(providers["local"].calls) == calls
    runs = {r["step_id"]: r for r in queue.step_runs}
    assert all(r["cached"] and r["attempts"] == 0 for r in runs.values())
    assert any(msg == "reused cached header" for _, _, msg in queue.events)


def test_production_regression_and_rerun_jobs_never_use_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES * 2)
    run(deps, JOB, TEMPLATE)
    run(deps, replace(JOB, id="job-2"), TEMPLATE)
    assert len(providers["local"].calls) == 2 * 4  # four calls each (header, date, two data chunks)
    assert not deps.store.list_keys("runs", "step-cache/")  # nothing written


def test_uncached_calls_the_models_and_refreshes_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES * 2)
    run(deps, WORKBENCH, TEMPLATE)
    queue = run(deps, replace(WORKBENCH, id="job-2", params={"dataPolicy": "local", "uncached": True}), TEMPLATE)
    assert len(providers["local"].calls) == 8
    assert not any(r["cached"] for r in queue.step_runs)


def test_changing_one_step_reruns_it_and_the_steps_that_use_its_values(tmp_path: Path) -> None:
    # data (chunked) feeds the date step's context; header is independent.
    changed_rows = [
        {"rows": [{"batch": "G9", "value": "1.0", "aliases": []}]},
        {"rows": [{"batch": "G8", "value": "2.0", "aliases": []}]},
    ]
    deps, providers = make(tmp_path, [*CONTEXT_RESPONSES, *changed_rows, CONTEXT_RESPONSES[3]])
    run(deps, WORKBENCH, CONTEXT_TEMPLATE)
    first = len(providers["local"].calls)
    pipeline = [dict(s) for s in CONTEXT_TEMPLATE["pipeline"]]
    pipeline[1] = {**pipeline[1], "instructions": "Results are numeric."}  # the data step
    queue = run(deps, replace(WORKBENCH, id="job-2"), {**CONTEXT_TEMPLATE, "pipeline": pipeline})
    cached = {r["step_id"]: r["cached"] for r in queue.step_runs}
    assert cached == {"header": True, "data": False, "date": False}
    assert len(providers["local"].calls) == first + 3  # two data chunks + date
```

(Check the names the fake store and fixtures actually use, and adapt only the scaffolding:
- the store's key-listing method (`MemoryObjectStore` may expose `keys()` or `list` rather than `list_keys`);
- the step ids and the order of `CONTEXT_RESPONSES`;
- whether `JOB` already has `test=True`. If it does, build the production job with `test=False`, and add a separate case for a test job **without** a project, which is a regression run: it must also skip the cache.

Assertions on which steps hit and on call counts must stay as written.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_step_cache.py -q`
Expected: FAIL. The step runs have no `cached` key, and the second run calls the model.

- [ ] **Step 3: Implement**

In `template_pipeline.py`:

```python
def workbench_step_cache(job: ClaimedJob, deps: PipelineDeps) -> StepCache | None:
    """Only workbench test runs use the step cache: never production, regression or re-runs.
    `params.uncached` forces fresh calls but still stores their results."""
    if job.project_id is None or not job.test or job.task != "process":
        return None
    return StepCache(deps.store, deps.buckets.runs, read=not (job.params or {}).get("uncached"))
```

- `process_template_job`: `cache = workbench_step_cache(job, deps)`, passed to every `_run_step` call.
- `_run_step`:
  - Accept `cache: StepCache | None = None` and pass it to `run_step_extraction(..., cache=cache)`.
  - In the success `record_step_run`, add `"cached": result.cached`. In the failure one, add `"cached": False`.
  - The event message is `f"reused cached {step.id}"` when `result.cached`, otherwise unchanged.
- `queue.py` `PgJobQueue.record_step_run`: add `cached` to the column list and values, with `{"job_id": job_id, "error": None, "cached": False, **run}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run mypy`
Expected: PASS. If an existing test compares whole step-run dicts, it now sees `cached: False`. Add the key to its expectation and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "Worker: workbench test runs reuse cached steps; hits recorded as cached step runs"
```

---

### Task 4: API: cached step runs, uncached evaluations, model comparison

**Files:**
- Modify: `apps/api/src/repositories/{memory,pg}.ts` (`StepRun.cached`), `apps/api/src/workbench/repo.ts` (iteration `groupId`, `uncached`), `apps/api/src/routes/workbench.ts`, `apps/api/test/integration/workbench-pg.test.ts`
- Test: `apps/api/test/workbench-comparison.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 contracts; 4a's evaluation route and `iterationView`.
- Produces:
  - `IterationRecord` gains `groupId: string | null` and `uncached: boolean`. `createIteration` accepts both, defaulting to null and false.
  - `MemoryRepo` step runs: tests can seed them through the existing `stepRuns` map. Mapped runs carry `cached ?? false`.
  - `POST /evaluations` body: `{ model?, uncached? }`. With `uncached: true`, the jobs' `params` include `uncached: true` and the iteration records it.
  - `POST /evaluations/compare` with `{ uncached? }` returns 201 `ComparisonView`.
  - `GET /comparisons/:groupId` returns `ComparisonView`.
  - `IterationView.cache` is computed from `listStepRuns` of each job.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-comparison.test.ts`. Reuse the `project()` scaffolding from `apps/api/test/workbench-evaluation.test.ts` (copy its `add`, `verify`, `finish` and `evaluate` helpers into this file):

```ts
describe('model comparison and uncached evaluations', () => {
  it('marks uncached evaluations and passes the flag to the jobs', async () => {
    const { add, verify, evaluate, repo } = await project();
    await verify(await add(1), 'Acme');
    const iteration = (await evaluate({ uncached: true })).json() as IterationView;
    expect(iteration).toMatchObject({ uncached: true, groupId: null });
    const [run] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    expect(repo.jobParams.get(run!.job.id)).toEqual({ dataPolicy: 'local', uncached: true });
  });

  it('starts one iteration per model and lines them up', async () => {
    const { app, add, verify } = await project();
    await verify(await add(1), 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations/compare',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const comparison = res.json() as ComparisonView;
    expect(comparison.iterations.map((i) => i.model)).toEqual(['default', 'fast', 'draft']);
    expect(new Set(comparison.iterations.map((i) => i.groupId))).toEqual(new Set([comparison.groupId]));
    const again = (
      await app.inject(`/api/workbench/projects/letter/comparisons/${comparison.groupId}`)
    ).json() as ComparisonView;
    expect(again.iterations.map((i) => i.id)).toEqual(comparison.iterations.map((i) => i.id));
    expect(
      (await app.inject(`/api/workbench/projects/letter/comparisons/${crypto.randomUUID()}`)).statusCode,
    ).toBe(404);
  });

  it('still completes when one model is refused by the data policy', async () => {
    const { app, add, verify, finish, repo } = await project();
    await verify(await add(1), 'Acme');
    const comparison = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations/compare', payload: {} })
    ).json() as ComparisonView;
    const jobs = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId).map((r) => r.job);
    for (const job of jobs) {
      if (job.modelOverride === 'fast') {
        repo.jobs.set(job.id, { ...job, status: 'needs_review', error: 'data policy: project is local-only' });
      } else {
        await finish(job.id, 'Acme');
      }
    }
    const view = (
      await app.inject(`/api/workbench/projects/letter/comparisons/${comparison.groupId}`)
    ).json() as ComparisonView;
    expect(view.iterations.map((i) => [i.model, i.status, i.score])).toEqual([
      ['default', 'complete', 1],
      ['fast', 'complete', null],
      ['draft', 'complete', 1],
    ]);
  });

  it('counts step runs served from the cache', async () => {
    const { add, verify, finish, evaluate, view, repo } = await project();
    await verify(await add(1), 'Acme');
    const iteration = (await evaluate()).json() as IterationView;
    const [run] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    await finish(run!.job.id, 'Acme');
    const base = { trigger: 'process' as const, model: 'local/qwen', attempts: 0, inputTokens: null, outputTokens: null, error: null, startedAt: '', finishedAt: '' };
    repo.stepRuns.set(run!.job.id, [
      { ...base, id: 1, stepId: 'head', status: 'succeeded', cached: true },
      { ...base, id: 2, stepId: 'tail', status: 'succeeded', cached: false },
      { ...base, id: 3, stepId: 'oops', status: 'failed', cached: false },
    ]);
    expect((await view(iteration.id)).cache).toEqual({ reused: 1, total: 2 });
  });
});
```

(Check the `MemoryRepo.stepRuns` field name and the `StepRun` shape, and adapt only the scaffolding.)

Extend the opt-in `workbench-pg` integration test:
- an iteration created with `groupId` and `uncached: true` round-trips;
- a `step_runs` row inserted with `cached = true` comes back from `listStepRuns` with `cached: true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-comparison.test.ts`
Expected: FAIL. `/evaluations/compare` returns 404.

- [ ] **Step 3: Implement**

- `workbench/repo.ts`:
  - `IterationRecord` and `createIteration` gain `groupId` and `uncached`, with Memory defaults `null` and `false`.
  - Pg: `INSERT ... (…, group_id, uncached)`, and map `group_id` / `uncached` in `toIteration`.
  - Add `listGroup(projectId: string, groupId: string): Promise<IterationRecord[]>`. In Pg: `WHERE project_id = $1 AND group_id = $2`. In Memory: filter by both.
- `repositories/pg.ts` `listStepRuns` and `metricsData`: map `cached: r.cached`. Memory `listStepRuns` returns `(runs ?? []).map((r) => ({ cached: false, ...r }))`.
- `routes/workbench.ts`:
  - `EvaluateBody = z.object({ model: z.enum(EVALUATION_MODELS).optional(), uncached: z.boolean().optional() }).strict()`. Add `CompareBody = z.object({ uncached: z.boolean().optional() }).strict()` and `ComparisonParams = z.object({ id: Id, groupId: z.string().uuid() })`.
  - Factor the body of `POST /evaluations` (after body parsing) into `async function startIteration(app, projectId, options: { model: EvaluationModel | null; uncached: boolean; groupId: string | null }, reply)`.
    - It does the 4a checks (project, open draft, valid draft, verified references) and either returns an error reply or the created `IterationRecord`.
    - Jobs get `params: { dataPolicy, ...(uncached ? { uncached: true } : {}) }`.
    - Both routes use it.
  - `POST /evaluations/compare`:
    - `const groupId = randomUUID();`
    - For each `model` of `EVALUATION_MODELS`, in order, call `startIteration(...)`. Return early with the first error.
    - Reply `201 { groupId, iterations: await Promise.all(records.map((r) => iterationView(app, r))) }`.
  - `GET /comparisons/:groupId`: parse the params, then `const records = await workbench.listGroup(projectId, groupId)`. Return 404 `comparison not found` if there are none. Otherwise return them sorted by `EVALUATION_MODELS.indexOf(r.model!)`, as views.
  - `iterationView` and `summaryOf` add `groupId`, `uncached` and `cache`. For `cache`: `const runs = (await Promise.all(it.jobIds.map((id) => app.deps.repo.listStepRuns(id)))).flat().filter((r) => r.status === 'succeeded');` then `cache = { reused: runs.filter((r) => r.cached).length, total: runs.length }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api` (check the typecheck **exit code**).
Expected: PASS. If Docker is available, run the opt-in `workbench-pg` test on a **throwaway** container and record the result.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: uncached evaluations, model comparison groups and cached step-run counts"
```

---

### Task 5: Web: fresh calls, Compare models, cache reuse

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/workbench/EvaluateTab.tsx`, `apps/web/src/jobs/JobDetailPanel.tsx`
- Test: `apps/web/test/EvaluateTab.test.tsx`, `apps/web/test/client.test.ts`, `apps/web/test/JobDetailPanel.test.tsx` (or wherever step runs are rendered; find it with grep)

**Interfaces:**
- Produces:
  - Api:
    - `startEvaluation(projectId, model, options?: { uncached?: boolean })`. The body is `{ model?, uncached? }`, with only the keys that are set.
    - `startComparison(projectId, options?: { uncached?: boolean }): Promise<ComparisonView>`
    - `getComparison(projectId, groupId): Promise<ComparisonView>`
    - fake-api defaults for both throw "not stubbed".
  - EvaluateTab:
    - **Uncached checkbox:** labelled "Fresh model calls (skip the step cache)". Its value is passed to both evaluate and compare.
    - **Compare models** button: calls `startComparison` and shows a table labelled "Model comparison". The header row is "Measure" followed by one column per iteration (`default`, `fast`, `draft`). The body comes from `comparisonRows`, as percentages or "–". It polls `getComparison` while any iteration is running.
    - **Cache line:** under the latest iteration, `Reused N of M steps from the cache`, shown only when `cache.total > 0`.
    - **History rows** show "fresh" for uncached iterations and "compare" for grouped ones.
  - JobDetailPanel: a cached step run shows "cached" instead of the attempts and tokens.

- [ ] **Step 1: Write the failing tests**

`client.test.ts`:

```ts
describe('http api: comparison', () => {
  it('sends the uncached flag and starts and opens comparisons', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.startEvaluation('letter', null, { uncached: true });
    await api.startComparison('letter', { uncached: true });
    await api.getComparison('letter', 'g1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['POST', '/api/workbench/projects/letter/evaluations', { uncached: true }],
      ['POST', '/api/workbench/projects/letter/evaluations/compare', { uncached: true }],
      ['GET', '/api/workbench/projects/letter/comparisons/g1', undefined],
    ]);
  });
});
```

`EvaluateTab.test.tsx`:

```tsx
  it('passes "fresh model calls" to evaluate', async () => {
    const it0 = iterationView({ status: 'running', score: null });
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => it0),
      getIteration: vi.fn(async () => it0),
    });
    await userEvent.click(await screen.findByLabelText('Fresh model calls (skip the step cache)'));
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', null, { uncached: true });
  });

  it('compares models side by side', async () => {
    const group = 'g1';
    const views = [
      iterationView({ model: 'default', groupId: group, score: 0.75 }),
      iterationView({ model: 'fast', groupId: group, score: 0.5 }),
      iterationView({ model: 'draft', groupId: group, score: 1 }),
    ];
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
      getComparison: vi.fn(async () => ({ groupId: group, iterations: views })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Compare models' }));
    expect(api.startComparison).toHaveBeenCalledWith('letter', { uncached: false });
    const table = await screen.findByRole('table', { name: 'Model comparison' });
    const score = within(table).getByText('score').closest('tr')!;
    expect(score).toHaveTextContent('75%');
    expect(score).toHaveTextContent('50%');
    expect(score).toHaveTextContent('100%');
  });

  it('says how many steps came from the cache', async () => {
    const latest = iterationView({ cache: { reused: 5, total: 8 } });
    tab({ listIterations: vi.fn(async () => [latest]), getIteration: vi.fn(async () => latest) });
    expect(await screen.findByText('Reused 5 of 8 steps from the cache')).toBeInTheDocument();
  });
```

(The 4a tests call `startEvaluation` with `('letter', 'fast')`. That assertion becomes `('letter', 'fast', { uncached: false })` because the tab now always passes options. This is a deliberate signature change; note it in the report.)

Step-run test for JobDetailPanel: a run with `cached: true` shows the text "cached".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/client.test.ts apps/web/test/EvaluateTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `client.ts`:
  - `startEvaluation: (id, model, options) => post<IterationView>(\`${base}/workbench/projects/${id}/evaluations\`, { ...(model ? { model } : {}), ...(options?.uncached ? { uncached: true } : {}) })`
  - `startComparison: (id, options) => post<ComparisonView>(\`${base}/workbench/projects/${id}/evaluations/compare\`, options?.uncached ? { uncached: true } : {})`
  - `getComparison: (id, groupId) => apiFetch(\`${base}/workbench/projects/${id}/comparisons/${groupId}\`).then(json<ComparisonView>)`
- `fake-api.ts`: defaults. The `iterationView` builder gets `groupId: null`, `uncached: false` and `cache: { reused: 0, total: 0 }`, which Task 1 already added.
- `EvaluateTab.tsx`:
  - `const [uncached, setUncached] = useState(false);` with a checkbox `<label><input type="checkbox" checked={uncached} onChange={(e) => setUncached(e.target.checked)} /> Fresh model calls (skip the step cache)</label>`.
  - `evaluate` calls `api.startEvaluation(projectId, model || null, { uncached })`.
  - `const [comparison, setComparison] = useState<ComparisonView | null>(null);`
  - A **Compare models** button (`disabled={!hasDraft || busy || running}`) runs ``act(async () => { setComparison(await api.startComparison(projectId, { uncached })); })``.
  - A poll effect: while `comparison?.iterations.some((i) => i.status === 'running')`, call `getComparison` every `pollMs` (cleared on unmount), then refresh History when everything is complete.
  - Render:

```tsx
      {comparison && (
        <table aria-label="Model comparison">
          <thead>
            <tr>
              <th>Measure</th>
              {comparison.iterations.map((i) => (
                <th key={i.id}>
                  {i.model ?? 'template'}
                  {i.status === 'running' && ' (running)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparisonRows(comparison.iterations).map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                {comparison.iterations.map((i) => (
                  <td key={i.id}>{pct(row.byModel[i.model ?? 'template'] ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
```

  - Under the latest-iteration summary: `{current.cache.total > 0 && <p className="muted">Reused {current.cache.reused} of {current.cache.total} steps from the cache</p>}`.
  - In History, after the model cell: `{h.uncached && ' · fresh'}{h.groupId && ' · compare'}`. Use the existing separator constant for "·" (the 4a code has a `DOT` constant). Never write a raw "·" that could be mangled, and keep the file free of U+FFFD.
- `JobDetailPanel.tsx` (and the Review step-run list, if it shows attempts): render `cached` for `run.cached` instead of the attempts and tokens.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web` (check the typecheck **exit code**).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: fresh model calls, model comparison table and step-cache reuse"
```

---

### Task 6: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

- [ ] **Step 1: Document it**

`CLAUDE.md`:
- **Contracts table:** add a **Step cache** row.
  - TS: `StepRun.cached`, `IterationView.cache`, `ComparisonView` and `comparisonRows`.
  - Python: `step_cache.step_cache_key`, `StepCache` and the runs-bucket key `step-cache/{key}.json`.
  - Note: `storage.step_cache_object_key`; no TS reader.
- **Workbench bullet:**
  - Workbench test runs (`process` jobs with a project and `test`) reuse a step's stored output when its full input is unchanged. The input is the rendered prompts, schema, system prompt, page-image hashes, model ref, the options that change outputs, `maxTokens` and `maxAttempts`.
  - Hits are recorded as `step_runs.cached`, migration `0014`.
  - `params.uncached` forces fresh calls and still writes the cache.
  - `POST /evaluations/compare` runs `default`, `fast` and `draft` as one group, viewed via `GET /comparisons/:groupId`.
- **Worker rule:** production, regression and re-run jobs never touch the cache.

`docs/architecture.md`: one paragraph on the step cache.

`docs/design/workbench.md`, Phasing:
- Mark 4b done: step cache, uncached re-runs, model comparison.
- 4c (feedback, `revise`) is next.
- Under Risks, update the 4a snapshot-drift limitation. The cache does not remove it, because jobs still load the draft when they are claimed. Say so plainly.

- [ ] **Step 2: Full check**

Run `npm run check` and `npm run format:check`, checking the exit codes. If `uv` is not on PATH, add its directory first.

- [ ] **Step 3: Smoke test (throwaway infra only)**

1. Apply migrations 0001–0014 to a throwaway Postgres via the opt-in `workbench-pg` test, then remove the container.
2. If a full stack with a local model is available:
   - Evaluate twice without changes. The second run should be near-instant, with "Reused N of N steps".
   - Edit one step's instructions and Evaluate again. Only that step and its dependants should re-run.
   - Run a "Fresh model calls" evaluation.
   - Run Compare models.
3. No external LLM calls. Record what you couldn't run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Workbench: document phase 4b (step cache, uncached re-runs, model comparison)"
```
