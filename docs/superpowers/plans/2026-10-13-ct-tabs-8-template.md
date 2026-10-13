# Workbench tabs 8/8: Template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Workbench Template tab (handoff §10: the embedded `TemplateEditor`) and land **TP1**, the draft change log: every write to a draft (hand save, applied proposal, restore, the draft's start, import) records what changed, and `GET /api/workbench/projects/:id/draft/changes` lists the open draft's entries newest first. The embedded editor gets a tab header with *Try on [dev sample] → Test run* (TR1's `sampleIds`, from PR 7), Export YAML and *More → Delete draft*; sub-tabs General, Sections, Outputs, Pipeline (default), YAML (Quality removed); a Pipeline list + step form with section toggle chips, output chips and last-run figures; a **Checks** panel and a **Changes since vN** panel on the right; and a sticky **unsaved bar** (*Discard* / *Save draft vN*). The Templates page keeps its own editor design.

**Architecture:**

- *Shared* (`packages/shared/src/definition-diff.ts`, new): `diffDefinitions` moves here from `apps/api/src/regression/diff.ts` (which re-exports it), plus `describeDefinitionChange(before, after)` → `{ subjects, summary, diff, count }` (one wording for the API's change log and the web's unsaved bar) and the DTO `TemplateChangeSchema` / `TemplateChangeInput` / `TEMPLATE_CHANGE_SOURCES`.
- *Migration 0029* (`db/migrations/0029_template_changes.sql`): append-only `template_changes` keyed to `templates (id, version)` with `ON DELETE CASCADE`. Published `templates` rows are never written: the log is a separate table and the 0003 immutability triggers are untouched.
- *TemplateRepo* (Memory + Pg): `create(…, change?)` and `updateDraft(…, { change?, expectedUpdatedAt? })` write the log row **in the same statement** as the draft (a data-modifying CTE), `listChanges(id, version)`. `expectedUpdatedAt` makes a save from a stale editor a no-op (compared to the millisecond: timestamptz keeps microseconds). `deleteDraft` takes the version's rows; `WorkbenchRepo.deleteProject` deletes the type's rows explicitly.
- *API*: every draft write passes a change (`apps/api/src/templates/changes.ts`: `draftChange`, `startedChange`, `handEditedAt`); `PUT /api/templates/:id/versions/:version` takes optional `baseUpdatedAt` (409 `the draft changed since you opened it; reload it to see the changes`); new `GET /api/workbench/projects/:id/draft/changes`; the overview's *Hand edit* figure reads the newest `hand` change (drafts from before 0029 fall back to `updatedAt`). The worker never reads the log: TS only.
- *Web*: client `listDraftChanges`, `saveTemplate(…, baseUpdatedAt?)`; small moves out of the 1,155-line `TemplateEditor.tsx` (`fields.tsx`, `StepForms.tsx`, `DraftMenu.tsx`); pure helpers (`templates/checks.ts`, `editor-derive.ts`); new `EmbeddedHeader`, `TryOn`, `UnsavedBar`, `PipelineEditor`, `ChecksPanel`, `DraftChangesPanel`; `ProjectPage` passes the overview stages, data policy and published version; `ProjectHeader`'s *Publish vN* now opens Evaluate (the gate card publishes); CSS in `styles/stages.css`.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, PostgreSQL 17, CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §10 Template, row **TP1** of "New API" (TP2 already landed with the Steps tab: `outputCoverage` in `packages/shared/src/template.ts`), "Tests to add" (Template); screens `docs/design/workbench-tabs/screenshots/light/10-template.png`, `screenshots/states/10b-template-unsaved.png`, `screenshots/states/10c-template-outputs.png`.

## Global Constraints

- **Card CSS gotcha:** `.card` has **no padding**. The new padded blocks (`.checks-panel`, `.changes-panel`, `.step-detail`) are added to the shared padding rule in `apps/web/src/styles/stages.css` (the block that starts `/* Workbench tab cards: .card itself has no padding …`, `padding: 12px 16px`) and their `h3` (`.checks-panel h3`, `.changes-panel h3`, `.step-detail h3`) to the `font-weight: 600` rule below it — extend those two selector lists, do not duplicate them.
- **Grids never overflow:** `.template-embedded .editor-layout` is `grid-template-columns: minmax(0, 1fr) 320px` and `.pipeline-editor` `minmax(0, 240px) minmax(0, 1fr)`, every grid child `min-width: 0`; ids, summaries and diff chips wrap with `overflow-wrap: anywhere`. Below 1100 px the side panels drop under the editor; below 760 px the step list stacks above the step form.
- **Wide tables in `.table-scroll`:** the editor's existing row tables already scroll inside `.row-table`; nothing new is a wide table.
- **Side panels sticky, height-capped, scrollable:** `.template-side` (Checks + Changes) is `position: sticky; top: calc(var(--ih-topbar-h, 0px) + 12px); max-height: calc(100vh - var(--ih-topbar-h, 0px) - 24px); overflow: auto` (static below 1100 px).
- **Disabled buttons carry a `title` reason (tested):** *Test run* ("Save the draft first: a test run uses the saved draft", "No prepared dev samples: add or prepare some on the Samples tab", "Loading the dev samples…"), *Move step N up/down* ("Already the first step" / "Already the last step"), the *Add output* select ("A table step fills one table: remove it to fill fields instead", "This step already fills every output").
- **Selectable rows are `aria-pressed` buttons:** the Pipeline step list. Section toggles are native checkboxes inside chip labels (multi-select). *Full diff* and *More actions* carry `aria-expanded`.
- **Charts:** none on this tab (the last-run figures are a `dl`).
- **Status in text, not only colour:** each Checks item has a visually hidden tone word ("Needs you:", "Error:", "Stale:", "OK:"); a sub-tab's warn dot is `aria-hidden` with a visually hidden " (needs attention)" in the tab name.
- **Stale responses and polling:** `DraftChangesPanel` numbers its requests with a sequence ref (an older response, or one after unmount, is dropped); `TryOn` and the metrics load ignore responses after unmount. Nothing on this tab polls (nothing here runs; a queued test run shows on Test runs). After a save or a queued test run the editor calls `embedded.onSaved` and `ProjectPage` reloads the page overview.
- **Model pickers follow main (#90/#91/#93):** the step *Model* is the shared `ModelPicker` whose empty option is "Document type's model (…)" / "Default choice (…)" as on main; *Test run* opens the shared `ReprocessDialog` (`emptyLabel="Document type's model"`, the project's `dataPolicy`).
- **The Templates page must not regress:** standalone mode keeps `EditorHeader` (back link, H1, Publish, Save draft), the tab order General, Sections, Pipeline, Outputs, YAML, Quality, the collapsible `StepCard`s, the validation list and `TestRail`. Its existing tests stay green and new tests cover both modes.
- **Migration** is `0029_template_changes.sql` (highest existing is 0028). Forward-only.
- **Cross-language contracts:** none change. The change log is TS only (the worker never reads `template_changes`); the CLAUDE.md contract table records that.
- **Never call a real LLM.** Pg integration: `docker run --rm -d --name ih-test-pg-template -e POSTGRES_PASSWORD=test -p 55448:5432 postgres:17-alpine`, then `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55448/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`, then `docker rm -f ih-test-pg-template`.
- Tests first (red, then green); `npm run check` green at the end; never `git add -A` (stage the files each task names); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A stale editor must not silently undo a proposal applied elsewhere.** A second browser tab, or an editor left open while a Steps proposal is applied, saves with `baseUpdatedAt`: the Pg `UPDATE … AND date_trunc('milliseconds', updated_at) = $4` writes nothing and the route answers 409; the editor offers *Reload the draft* (Task 2 Pg test, Task 3 route test, Task 8 web test). The JS ISO string has milliseconds and `updated_at` has microseconds, hence the truncation (node-postgres truncates to the millisecond too).
2. **No-op writes do not flood the log.** An unchanged save, or the idempotent re-apply of a proposal after a lost race, describes `count: 0` and writes no row (Task 3 test).
3. **Published versions stay immutable.** `updateDraft` on a published version returns null and logs nothing; a published import or seed logs nothing; the FK cascade can only ever fire for drafts (published rows cannot be deleted) (Task 2 Pg test).
4. **Deleting a draft or a project removes its log.** `deleteDraft` (cascade, and Memory emulates it) and `deleteProject` (explicit `DELETE FROM template_changes`) (Task 2 Memory + Pg tests, the Pg counts check).
5. **Drafts from before migration 0029 have no log.** The Changes panel says "No changes recorded for this draft yet" instead of an error, and the overview's *Hand edit* falls back to the template's `updatedAt` when a version has no rows at all (Task 4 and Task 10 tests).

## Deviations from the handoff (follow main; recorded here and in the report)

- **Publish stays on the Template tab (user decision, overrides the handoff and any task text below that removes it).** The embedded editor's tab header keeps a **Publish vN** button that calls the Workbench publish route (`api.publish`, as today: never locked by the gate, refusals shown in the editor's message), beside *Try on*, Export and More. The project header's *Publish vN* keeps linking to the **Template** tab (unchanged; `ProjectHeader` and its test are not edited). Evaluate's gate card also publishes. So in Task 8 keep (do not replace) the existing "publishes through the Workbench … and reports it" test and do not assert that Publish is absent; in Task 11 skip the ProjectHeader link change.
- **TP1 shape:** `TemplateChange = { id, version, at, source: 'hand' | 'proposal' | 'restore' | 'started' | 'import', stage, proposalId, summary, diff: string[], by }` instead of `source: 'hand' | Stage`. Tags: BY HAND, `<STAGE> PROPOSAL`, RESTORED, STARTED, IMPORTED. The screenshot's **SURVEY** entry is left out: accepting a survey changes the brief, not the draft.
- **Unsaved bar** says "Saving marks the latest evaluation out of date" (no date: the overview carries no evaluation time).
- **Pipeline warning** is the Steps tab's retry warning (attempts from `getMetrics`), worded for this tab ("…add instructions below"); the handoff's cause ("Reading payment makes this step retry") needs per-section statistics nobody records.
- **Outputs sub-tab** keeps the existing editable forms (the handoff text) rather than the read-only list with STEP tags drawn in 10c; each sub-tab ends with a link to the stage that drafts it (General → Revise, which proposes the preamble).
- **"+ Add step"** keeps the two existing buttons, *Add extract step* and *Add check step*.
- **Additions:** `baseUpdatedAt` on draft saves (Review Focus 1), and the overview's *Hand edit* figure now reads the log (it counted proposal applies as hand edits).
- The change log is recorded for every document type (also Templates-page types), though only the Workbench shows it: one rule for every draft write.

---

## File map

| File | Change |
| --- | --- |
| `packages/shared/src/definition-diff.ts` | Create: `diffDefinitions` (moved), `changeSubject`, `describeDefinitionChange`, `TemplateChangeSchema` |
| `packages/shared/src/index.ts` | export it |
| `packages/shared/test/definition-diff.test.ts` | Create |
| `apps/api/src/regression/diff.ts` | re-export from `@ih/shared` |
| `db/migrations/0029_template_changes.sql` | Create |
| `apps/api/src/templates/repo.ts` | `create(…, change?)`, `updateDraft(…, write?)`, `listChanges`, monotonic Memory clock |
| `apps/api/src/workbench/repo.ts` | `deleteProject` deletes `template_changes` (Pg); doc comment |
| `apps/api/src/templates/changes.ts` | Create: `draftChange`, `startedChange`, `handEditedAt` |
| `apps/api/src/templates/drafts.ts` | `createNextDraft(…, by)` logs `started` |
| `apps/api/src/routes/templates.ts` | save (`baseUpdatedAt`, hand change), create, drafts, import |
| `apps/api/src/routes/workbench.ts` | create project, proposal decision, restore; `GET …/draft/changes` |
| `apps/api/src/routes/workbench-bundle.ts` | import logs `import` |
| `apps/api/src/routes/workbench-overview.ts` | *Hand edit* from the log |
| `apps/api/test/template-changes.test.ts` | Create |
| `apps/api/test/workbench-delete.test.ts`, `apps/api/test/workbench-overview.test.ts`, `apps/api/test/workbench-bundle.test.ts`, `apps/api/test/integration/workbench-pg.test.ts` | tests |
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts` | client |
| `apps/web/src/templates/fields.tsx`, `StepForms.tsx`, `DraftMenu.tsx` | Create (moved code) |
| `apps/web/src/templates/EditorHeader.tsx`, `apps/web/src/workbench/StepsView.tsx`, `apps/web/src/workbench/steps.ts` | use the moved code; `StepFigures` export, `retryWarning(m, here)` |
| `apps/web/src/templates/checks.ts`, `apps/web/src/templates/editor-derive.ts` | pure helpers |
| `apps/web/test/template-checks.test.ts` (create), `apps/web/test/editor-derive.test.ts`, `apps/web/test/steps-derive.test.ts` | helper tests |
| `apps/web/src/templates/EmbeddedHeader.tsx`, `TryOn.tsx`, `UnsavedBar.tsx`, `PipelineEditor.tsx`, `ChecksPanel.tsx`, `DraftChangesPanel.tsx` | Create |
| `apps/web/src/templates/TemplateEditor.tsx`, `apps/web/test/TemplateEditor.test.tsx` | embedded mode |
| `apps/web/test/TemplateSide.test.tsx` | Create: Checks and Changes panels |
| `apps/web/src/workbench/ProjectPage.tsx`, `ProjectHeader.tsx`, `apps/web/test/ProjectPage.test.tsx`, `apps/web/test/ProjectHeader.test.tsx` | wiring |
| `apps/web/src/styles/stages.css` | Template tab CSS |
| `CLAUDE.md`, `docs/openapi.json` | docs |

---

### Task 1: Shared definition diff and change wording

**Files:**
- Create: `packages/shared/src/definition-diff.ts`, `packages/shared/test/definition-diff.test.ts`
- Modify: `packages/shared/src/index.ts`, `apps/api/src/regression/diff.ts`

**Interfaces:**
- Produces: `diffDefinitions(from: Record<string, unknown>, to: Record<string, unknown>): DefinitionChange[]`, `DefinitionChangeSchema`, `changeSubject(path: string): string`, `describeDefinitionChange(before: unknown, after: unknown): DefinitionChangeText` (`{ subjects: string[]; summary: string; diff: string[]; count: number }`), `MAX_CHANGE_CHIPS = 4`, `TEMPLATE_CHANGE_SOURCES`, `TemplateChangeSchema`, `TemplateChange`, `TemplateChangeInput = Omit<TemplateChange, 'id' | 'version' | 'at'>`.
- Consumed by: Task 2 (repo types), Task 3 (`draftChange`), Task 5 (client type), Task 7 (`unsavedText` subjects), Task 8 (unsaved bar), Task 10 (panel).

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/definition-diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  changeSubject,
  describeDefinitionChange,
  diffDefinitions,
  MAX_CHANGE_CHIPS,
  TemplateChangeSchema,
} from '../src/index.js';

const base = {
  id: 'invoice',
  version: 4,
  name: 'Invoice',
  document: {
    sections: [
      { id: 'header', anchor: '^INVOICE' },
      { id: 'supplier', anchor: '^(From|Supplier)\\b' },
    ],
  },
  outputs: {
    fields: [{ id: 'total', type: 'number' }],
    tables: [{ id: 'lines', columns: [{ id: 'item', type: 'text' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['total'], sections: ['header'] },
    { type: 'extract', id: 'totals', fields: [], sections: ['totals', 'payment'] },
  ],
};
type Def = typeof base;
const edit = (f: (d: Def) => void): Def => {
  const d = structuredClone(base);
  f(d);
  return d;
};

describe('changeSubject', () => {
  it.each([
    ['outputs.fields[due_date]', 'field due_date'],
    ['outputs.fields[due_date].type', 'field due_date'],
    ['outputs.tables[lines]', 'table lines'],
    ['outputs.tables[lines].columns[qty].type', 'column lines.qty'],
    ['outputs.fields order', 'the outputs'],
    ['document.sections[supplier].anchor', 'section supplier'],
    ['document.sections order', 'the sections'],
    ['document.copies.anchor', 'the copy selection'],
    ['document.ocr', 'the document settings'],
    ['pipeline[totals].sections', 'step totals'],
    ['pipeline order', 'the pipeline'],
    ['review.required', 'the review setting'],
    ['model', "the document type's model"],
    ['preamble', 'the preamble'],
    ['name', 'the name'],
  ])('%s -> %s', (path, subject) => expect(changeSubject(path)).toBe(subject));
});

describe('describeDefinitionChange', () => {
  it.each<[string, Def, Pick<ReturnType<typeof describeDefinitionChange>, 'summary' | 'diff'>]>([
    [
      'a new field',
      edit((d) => d.outputs.fields.push({ id: 'due_date', type: 'date' })),
      { summary: 'Added field due_date', diff: ['+ due_date'] },
    ],
    [
      'a widened anchor',
      edit((d) => (d.document.sections[1]!.anchor = '^(From|Supplier|Vendor)\\b')),
      {
        summary: 'Changed section supplier',
        diff: ['^(From|Supplier)\\b → ^(From|Supplier|Vendor)\\b'],
      },
    ],
    [
      'a section a step no longer reads',
      edit((d) => (d.pipeline[1]!.sections = ['totals'])),
      { summary: 'Changed step totals', diff: ['− payment'] },
    ],
    [
      'a removed table',
      edit((d) => (d.outputs.tables = [])),
      { summary: 'Removed table lines', diff: ['− lines'] },
    ],
    [
      'a new column',
      edit((d) => d.outputs.tables[0]!.columns.push({ id: 'qty', type: 'text' })),
      { summary: 'Added column lines.qty', diff: ['+ qty'] },
    ],
    [
      'two subjects',
      edit((d) => {
        d.outputs.fields.push({ id: 'due_date', type: 'date' });
        d.name = 'Supplier invoice';
      }),
      // Subjects in definition order: `name` comes before `outputs`.
      { summary: 'Changed the name and 1 more', diff: ['Invoice → Supplier invoice', '+ due_date'] },
    ],
    [
      'swapped steps',
      edit((d) => d.pipeline.reverse()),
      { summary: 'Changed the pipeline', diff: ['reordered'] },
    ],
  ])('%s', (_name, after, expected) => {
    expect(describeDefinitionChange(base, after)).toMatchObject(expected);
  });

  it('says a new preamble in words', () => {
    expect(describeDefinitionChange(base, { ...base, preamble: 'Invoices from UK suppliers.' })).toMatchObject({
      subjects: ['the preamble'],
      summary: 'Changed the preamble',
      diff: ['preamble added'],
    });
  });

  it('clips long values in a chip', () => {
    const after = { ...base, name: 'x'.repeat(61) };
    expect(describeDefinitionChange(base, after).diff).toEqual([`Invoice → ${'x'.repeat(39)}…`]);
  });

  it('counts nothing for an identical definition or a version bump', () => {
    for (const after of [structuredClone(base), { ...base, version: 5 }]) {
      expect(describeDefinitionChange(base, after)).toEqual({
        subjects: [],
        summary: 'No changes',
        diff: [],
        count: 0,
      });
    }
  });

  it(`keeps at most ${MAX_CHANGE_CHIPS} chips, the summary naming the rest`, () => {
    const after = edit((d) => {
      for (const n of [1, 2, 3, 4, 5, 6]) d.outputs.fields.push({ id: `f${n}`, type: 'text' });
    });
    const text = describeDefinitionChange(base, after);
    expect(text.diff).toEqual(['+ f1', '+ f2', '+ f3', '+ f4']);
    expect(text.summary).toBe('Added field f1 and 5 more');
    expect(text.count).toBe(6);
  });

  it('reads unfinished drafts (non-objects count as empty)', () => {
    expect(describeDefinitionChange(null, { name: 'A' }).summary).toBe('Changed the name');
  });
});

describe('diffDefinitions (moved from the API)', () => {
  it('matches items by id', () => {
    const after = edit((d) => d.outputs.fields.unshift({ id: 'due_date', type: 'date' }));
    expect(diffDefinitions(base, after)).toEqual([
      { kind: 'added', path: 'outputs.fields[due_date]', after: { id: 'due_date', type: 'date' } },
    ]);
  });
});

describe('TemplateChangeSchema', () => {
  const entry = {
    id: '7',
    version: 4,
    at: '2026-10-12T08:40:00.000Z',
    source: 'proposal',
    stage: 'outputs',
    proposalId: '6f1c2c1e-0000-4000-8000-000000000001',
    summary: 'Added field due_date',
    diff: ['+ due_date'],
    by: 'Ken',
  };
  it('parses a log entry', () => expect(TemplateChangeSchema.parse(entry)).toEqual(entry));
  it('refuses an unknown source', () =>
    expect(TemplateChangeSchema.safeParse({ ...entry, source: 'survey' }).success).toBe(false));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project shared packages/shared/test/definition-diff.test.ts`
Expected: FAIL — `describeDefinitionChange` (and the other imports) are not exported from `../src/index.js`.

- [ ] **Step 3: Implement**

Create `packages/shared/src/definition-diff.ts`:

```ts
import { z } from 'zod';
import { CHANGE_STAGES } from './drafting.js';

/**
 * Structural diff of two template definitions (moved from apps/api/src/regression/diff.ts so the
 * API's draft change log and the web's unsaved bar word a change the same way). Lists of objects
 * with an `id` (sections, fields, tables, columns, steps) are matched by id rather than position,
 * so moving or inserting an item reads as one change instead of a cascade.
 */
export const DefinitionChangeSchema = z.object({
  kind: z.enum(['added', 'removed', 'changed']),
  path: z
    .string()
    .describe('e.g. `outputs.fields[a].type`, `pipeline[s1].instructions`, `pipeline order`.'),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type DefinitionChange = z.infer<typeof DefinitionChangeSchema>;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKeyedList = (v: unknown): v is Obj[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function diff(a: unknown, b: unknown, path: string, out: DefinitionChange[]): void {
  if (same(a, b)) return;
  if ((isKeyedList(a) || isKeyedList(b)) && Array.isArray(a) && Array.isArray(b)) {
    const before = new Map((a as Obj[]).map((x) => [x.id as string, x]));
    const after = new Map((b as Obj[]).map((x) => [x.id as string, x]));
    for (const [id, item] of before) {
      if (!after.has(id)) out.push({ kind: 'removed', path: `${path}[${id}]`, before: item });
    }
    for (const [id, item] of after) {
      const old = before.get(id);
      if (old === undefined) out.push({ kind: 'added', path: `${path}[${id}]`, after: item });
      else diff(old, item, `${path}[${id}]`, out);
    }
    const order = (m: Map<string, Obj>, other: Map<string, Obj>) =>
      [...m.keys()].filter((id) => other.has(id));
    if (!same(order(before, after), order(after, before))) {
      out.push({
        kind: 'changed',
        path: `${path} order`,
        before: [...before.keys()],
        after: [...after.keys()],
      });
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in b)) out.push({ kind: 'removed', path: join(path, key), before: a[key] });
      else if (!(key in a)) out.push({ kind: 'added', path: join(path, key), after: b[key] });
      else diff(a[key], b[key], join(path, key), out);
    }
    return;
  }
  out.push({ kind: 'changed', path, before: a, after: b });
}

export function diffDefinitions(from: Obj, to: Obj): DefinitionChange[] {
  const strip = ({ version: _version, ...rest }: Obj) => rest;
  const out: DefinitionChange[] = [];
  diff(strip(from), strip(to), '', out);
  return out;
}

/** At most this many diff chips per change (the summary counts the subjects). */
export const MAX_CHANGE_CHIPS = 4;
const MINUS = '−';

/** What a diff path is about, in words: `field due_date`, `step totals`, `the preamble`. */
export function changeSubject(path: string): string {
  const item = (prefix: string) => new RegExp(`^${prefix}\\[([^\\]]+)\\]`).exec(path)?.[1];
  const column = /^outputs\.tables\[([^\]]+)\]\.columns\[([^\]]+)\]/.exec(path);
  if (column) return `column ${column[1]}.${column[2]}`;
  const table = item('outputs\\.tables');
  if (table !== undefined) return `table ${table}`;
  const field = item('outputs\\.fields');
  if (field !== undefined) return `field ${field}`;
  if (path.startsWith('outputs')) return 'the outputs';
  const section = item('document\\.sections');
  if (section !== undefined) return `section ${section}`;
  if (path.startsWith('document.sections')) return 'the sections';
  if (path.startsWith('document.copies')) return 'the copy selection';
  if (path.startsWith('document')) return 'the document settings';
  const step = item('pipeline');
  if (step !== undefined) return `step ${step}`;
  if (path.startsWith('pipeline')) return 'the pipeline';
  if (path.startsWith('review')) return 'the review setting';
  if (path === 'model') return "the document type's model";
  return `the ${path.split(/[.[ ]/)[0]}`;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/** The mono chips for one change: `+ due_date`, `− payment`, `^A → ^B`, `instructions edited`. */
function chips(c: DefinitionChange): string[] {
  const { before, after } = c;
  if (c.path.endsWith(' order')) return ['reordered'];
  const item = /\[([^\]]+)\]$/.exec(c.path);
  if (item && c.kind === 'added') return [`+ ${item[1]}`];
  if (item && c.kind === 'removed') return [`${MINUS} ${item[1]}`];
  if (c.kind === 'changed' && isStrings(before) && isStrings(after)) {
    const added = after.filter((x) => !before.includes(x)).map((x) => `+ ${x}`);
    const removed = before.filter((x) => !after.includes(x)).map((x) => `${MINUS} ${x}`);
    return added.length + removed.length > 0 ? [...added, ...removed] : ['reordered'];
  }
  if (c.kind === 'changed' && isScalar(before) && isScalar(after)) {
    return [`${clip(String(before))} → ${clip(String(after))}`];
  }
  const key = c.path.slice(c.path.lastIndexOf('.') + 1);
  return [`${key} ${c.kind === 'changed' ? 'edited' : c.kind}`];
}

export interface DefinitionChangeText {
  /** What changed, in order of first appearance: `field due_date`, `step totals`. */
  subjects: string[];
  /** One line: `Added field due_date`, `Changed step totals and 2 more`; `No changes`. */
  summary: string;
  /** Up to MAX_CHANGE_CHIPS chips: `+ due_date`, `^A → ^B`, `− payment`. */
  diff: string[];
  /** How many structural changes (0: nothing to record). */
  count: number;
}

/** A draft change in words, for the change log (TP1) and the unsaved bar. */
export function describeDefinitionChange(before: unknown, after: unknown): DefinitionChangeText {
  const obj = (v: unknown): Obj => (isObj(v) ? v : {});
  const changes = diffDefinitions(obj(before), obj(after));
  const subjects = [...new Set(changes.map((c) => changeSubject(c.path)))];
  const verb = (subject: string) => {
    const of = changes.filter((c) => changeSubject(c.path) === subject);
    const whole = of.length === 1 && of[0]!.path.endsWith(']');
    if (whole && of[0]!.kind === 'added') return 'Added';
    if (whole && of[0]!.kind === 'removed') return 'Removed';
    return 'Changed';
  };
  const [first] = subjects;
  const more = subjects.length > 1 ? ` and ${subjects.length - 1} more` : '';
  return {
    subjects,
    summary: first === undefined ? 'No changes' : `${verb(first)} ${first}${more}`,
    diff: changes.flatMap(chips).slice(0, MAX_CHANGE_CHIPS),
    count: changes.length,
  };
}

/** Where a draft change came from (Workbench tabs TP1, migration 0029). */
export const TEMPLATE_CHANGE_SOURCES = ['hand', 'proposal', 'restore', 'started', 'import'] as const;
export type TemplateChangeSource = (typeof TEMPLATE_CHANGE_SOURCES)[number];

/** One entry of a draft's change log, newest first in `GET …/draft/changes`. */
export const TemplateChangeSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  at: z.string(),
  source: z.enum(TEMPLATE_CHANGE_SOURCES),
  stage: z
    .enum(CHANGE_STAGES)
    .nullable()
    .describe('The drafting stage of an applied proposal; null for every other source.'),
  proposalId: z.string().nullable(),
  summary: z.string().describe('One line, e.g. `Added field due_date`.'),
  diff: z.array(z.string()).describe('Up to 4 short chips, e.g. `+ due_date`, `^A → ^B`.'),
  by: z.string().nullable().describe('The signed-in token label; null without access control.'),
});
export type TemplateChange = z.infer<typeof TemplateChangeSchema>;
export type TemplateChangeInput = Omit<TemplateChange, 'id' | 'version' | 'at'>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from './definition-diff.js';
```

Replace the whole of `apps/api/src/regression/diff.ts` with:

```ts
/** The structural diff lives in @ih/shared (the change log and the web use it too). */
export {
  DefinitionChangeSchema as ChangeSchema,
  diffDefinitions,
  type DefinitionChange as Change,
} from '@ih/shared';
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project shared packages/shared/test/definition-diff.test.ts` → PASS.
Run: `npx vitest run --project api apps/api/test/regression.test.ts apps/api/test/openapi.test.ts` → PASS (the moved diff and the `diffTemplates` docs are unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/definition-diff.ts packages/shared/src/index.ts packages/shared/test/definition-diff.test.ts apps/api/src/regression/diff.ts
git commit -m "Shared: definition diff in words and the draft change log schema (TP1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0029 and the TemplateRepo change log

**Files:**
- Create: `db/migrations/0029_template_changes.sql`, `apps/api/test/template-changes.test.ts`
- Modify: `apps/api/src/templates/repo.ts`, `apps/api/src/workbench/repo.ts`
- Test: `apps/api/test/template-changes.test.ts`, `apps/api/test/workbench-delete.test.ts`, `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- Consumes: `TemplateChange`, `TemplateChangeInput` (Task 1).
- Produces on `TemplateRepo`:
  - `create(id, version, definition, status, change?: TemplateChangeInput): Promise<TemplateRecord>` — logs `change` only when `status === 'draft'`.
  - `updateDraft(id, version, definition, write?: DraftWrite): Promise<TemplateRecord | null>` with `interface DraftWrite { change?: TemplateChangeInput; expectedUpdatedAt?: string }` — null when the version is not a draft **or** `expectedUpdatedAt` is given and is not its `updatedAt`; nothing is written then.
  - `listChanges(id, version): Promise<TemplateChange[]>` — newest first.
  - `MemoryTemplateRepo.updatedAt` strictly increases across writes (a monotonic clock), so a stale base is always detected in unit tests.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/template-changes.test.ts` (Task 3 and 4 extend it):

```ts
import { describe, expect, it } from 'vitest';
import type { TemplateChangeInput } from '@ih/shared';
import { MemoryTemplateRepo } from '../src/templates/repo.js';

const hand = (summary = 'Added field a'): TemplateChangeInput => ({
  source: 'hand',
  stage: null,
  proposalId: null,
  summary,
  diff: ['+ a'],
  by: 'Ken',
});
const started: TemplateChangeInput = {
  source: 'started',
  stage: null,
  proposalId: null,
  summary: 'Draft v1 created',
  diff: [],
  by: null,
};

describe('MemoryTemplateRepo change log (TP1)', () => {
  it('logs a draft write with the write, newest first', async () => {
    const repo = new MemoryTemplateRepo();
    await repo.create('letter', 1, { id: 'letter', version: 1 }, 'draft', started);
    await repo.updateDraft('letter', 1, { id: 'letter', version: 1, name: 'A' }, { change: hand() });
    await repo.updateDraft('letter', 1, { id: 'letter', version: 1, name: 'B' }); // no change given
    const changes = await repo.listChanges('letter', 1);
    expect(changes.map((c) => [c.source, c.summary, c.by])).toEqual([
      ['hand', 'Added field a', 'Ken'],
      ['started', 'Draft v1 created', null],
    ]);
    expect(changes[0]).toMatchObject({ version: 1, stage: null, proposalId: null, diff: ['+ a'] });
    expect(Date.parse(changes[0]!.at)).not.toBeNaN();
  });

  it('refuses a stale base: nothing is written or logged', async () => {
    const repo = new MemoryTemplateRepo();
    const v1 = await repo.create('letter', 1, { id: 'letter', version: 1 }, 'draft');
    const a = await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'A' },
      { expectedUpdatedAt: v1.updatedAt, change: hand() },
    );
    expect(a!.updatedAt > v1.updatedAt).toBe(true); // the clock always moves
    const stale = await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'B' },
      { expectedUpdatedAt: v1.updatedAt, change: hand('stale') },
    );
    expect(stale).toBeNull();
    expect((await repo.get('letter', 1))!.definition).toMatchObject({ name: 'A' });
    expect((await repo.listChanges('letter', 1)).map((c) => c.summary)).toEqual(['Added field a']);
  });

  it('never logs for a published version, and a deleted draft takes its log', async () => {
    const repo = new MemoryTemplateRepo();
    await repo.create('letter', 1, { id: 'letter', version: 1 }, 'published', started);
    expect(await repo.listChanges('letter', 1)).toEqual([]);
    expect(await repo.updateDraft('letter', 1, { name: 'x' }, { change: hand() })).toBeNull();
    expect(await repo.listChanges('letter', 1)).toEqual([]);
    await repo.create('letter', 2, { id: 'letter', version: 2 }, 'draft', started);
    await repo.create('other', 1, { id: 'other', version: 1 }, 'draft', started);
    expect(await repo.deleteDraft('letter', 2)).toBe(true);
    expect(await repo.listChanges('letter', 2)).toEqual([]);
    expect(await repo.listChanges('other', 1)).toHaveLength(1);
  });
});
```

In `apps/api/test/workbench-delete.test.ts`, extend `it('deletes the draft template rows with the project', …)` to:

```ts
  it('deletes the draft template rows and their change log with the project', async () => {
    const { templates, workbench } = await project();
    const change = {
      source: 'hand' as const,
      stage: null,
      proposalId: null,
      summary: 'Changed the name',
      diff: [],
      by: null,
    };
    await templates.create('letter', 2, letter(2), 'draft', change);
    await templates.create('other', 1, letter(1), 'draft', change);

    expect(await workbench.deleteProject('letter')).not.toBeNull();
    expect((await templates.list()).filter((t) => t.id === 'letter')).toEqual([]);
    expect(await templates.listChanges('letter', 2)).toEqual([]);
    expect(await templates.get('other', 1)).not.toBeNull();
    expect(await templates.listChanges('other', 1)).toHaveLength(1);
  });
```

In `apps/api/test/integration/workbench-pg.test.ts`:

1. Add the import `import { PgTemplateRepo } from '../../src/templates/repo.js';`.
2. Add `let templates: PgTemplateRepo;` and `let templatesPool: pg.Pool;` next to `let workbench`, create them at the end of `beforeAll` (`templatesPool = new pg.Pool({ connectionString: url, max: 3 }); templates = new PgTemplateRepo(templatesPool);`) and end the pool in `afterAll` (`await templatesPool?.end();`).
3. In the `deleteProject` test's `populate`, right after the `INSERT INTO templates …` query, add:

```ts
      await pool.query(
        `INSERT INTO template_changes (template_id, version, source, summary)
         VALUES ($1, 1, 'started', 'Draft v1 created')`,
        [projectId],
      );
```

   and add to the `counts` query, after the `templates` line (keep the comma rules):

```sql
           (SELECT count(*)::int FROM template_changes WHERE template_id = $1) AS changes,
```

   (put it before `(SELECT count(*)::int FROM templates …) AS templates` so the last line keeps no trailing comma).
4. Append inside the top-level `describe.skipIf(!url)(…)`:

```ts
  it('logs draft changes in the same statement, matching the base to the millisecond (TP1)', async () => {
    const id = `tc-${randomUUID().slice(0, 8)}`;
    const change = (source: 'hand' | 'started', summary: string) => ({
      source,
      stage: null,
      proposalId: null,
      summary,
      diff: source === 'hand' ? ['+ a'] : [],
      by: source === 'hand' ? 'Ken' : null,
    });
    const v1 = await templates.create(id, 1, { id, version: 1 }, 'draft', change('started', 'Draft v1 created'));
    // updated_at has microseconds, the ISO string milliseconds: the base still matches.
    const saved = await templates.updateDraft(
      id,
      1,
      { id, version: 1, name: 'A' },
      { change: change('hand', 'Changed the name'), expectedUpdatedAt: v1.updatedAt },
    );
    expect(saved).not.toBeNull();
    // A stale base writes nothing: neither the definition nor a change.
    expect(
      await templates.updateDraft(
        id,
        1,
        { id, version: 1, name: 'B' },
        { change: change('hand', 'stale'), expectedUpdatedAt: v1.updatedAt },
      ),
    ).toBeNull();
    expect((await templates.get(id, 1))!.definition).toMatchObject({ name: 'A' });
    const proposalId = randomUUID();
    await templates.updateDraft(id, 1, { id, version: 1, name: 'C' }, {
      change: { source: 'proposal', stage: 'outputs', proposalId, summary: 'Changed the name', diff: ['A → C'], by: null },
    });
    const changes = await templates.listChanges(id, 1);
    expect(changes.map((c) => c.source)).toEqual(['proposal', 'hand', 'started']);
    expect(changes[0]).toMatchObject({ version: 1, stage: 'outputs', proposalId, diff: ['A → C'], by: null });
    expect(changes[1]).toMatchObject({ summary: 'Changed the name', diff: ['+ a'], by: 'Ken' });
    expect(Date.parse(changes[2]!.at)).not.toBeNaN();

    // Published: nothing is written or logged; a published create logs nothing either.
    await templates.publish(id, 1);
    expect(await templates.updateDraft(id, 1, { id, version: 1, name: 'D' }, { change: change('hand', 'x') })).toBeNull();
    expect(await templates.listChanges(id, 1)).toHaveLength(3);
    await templates.create(id, 2, { id, version: 2 }, 'published', change('started', 'x'));
    expect(await templates.listChanges(id, 2)).toEqual([]);
    // A deleted draft takes its log (ON DELETE CASCADE).
    await templates.create(id, 3, { id, version: 3 }, 'draft', change('started', 'Draft v3 created'));
    expect(await templates.deleteDraft(id, 3)).toBe(true);
    const left = await pool.query('SELECT 1 FROM template_changes WHERE template_id = $1 AND version = 3', [id]);
    expect(left.rowCount).toBe(0);
    // A proposal entry needs its stage (and nothing else may carry one).
    await expect(
      pool.query(
        `INSERT INTO template_changes (template_id, version, source, summary) VALUES ($1, 1, 'proposal', 'x')`,
        [id],
      ),
    ).rejects.toThrow(/check constraint/);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project api apps/api/test/template-changes.test.ts apps/api/test/workbench-delete.test.ts`
Expected: FAIL — `listChanges` is not a function; `create` ignores its fifth argument.
Run the Pg test (Global Constraints container): FAIL — relation `template_changes` does not exist.

- [ ] **Step 3: Implement**

Create `db/migrations/0029_template_changes.sql`:

```sql
-- Draft change log (Workbench tabs TP1): one row per change written to a draft's definition —
-- a hand save, an applied drafting proposal, a restored iteration, the draft's start or an
-- import. Rows only describe what changed; definitions stay in `templates`, whose published
-- rows remain immutable (0003's triggers are untouched). Append-only: rows are never updated,
-- and a deleted draft takes its rows with it. Read by the API only (the worker never reads it).
CREATE TABLE template_changes (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id  text        NOT NULL,
  version      integer     NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  source       text        NOT NULL
               CHECK (source IN ('hand', 'proposal', 'restore', 'started', 'import')),
  stage        text        CHECK (stage IN ('outputs', 'sections', 'steps', 'revise')),
  proposal_id  uuid,
  summary      text        NOT NULL,
  diff         jsonb       NOT NULL DEFAULT '[]',
  created_by   text,
  CHECK ((source = 'proposal') = (stage IS NOT NULL)),
  FOREIGN KEY (template_id, version) REFERENCES templates (id, version) ON DELETE CASCADE
);

CREATE INDEX template_changes_version ON template_changes (template_id, version, id DESC);
```

In `apps/api/src/templates/repo.ts`:

1. Imports: add `import type { TemplateChange, TemplateChangeInput } from '@ih/shared';`.
2. Replace the `TemplateRepo` interface with:

```ts
/** What a draft write records besides the definition (TP1). */
export interface DraftWrite {
  /** The change log entry; nothing is logged without one. */
  change?: TemplateChangeInput;
  /** The `updatedAt` the edit started from: a draft written since is not overwritten (null). */
  expectedUpdatedAt?: string;
}

/** Persistence for document templates (source of truth; files are only seed/import input). */
export interface TemplateRepo {
  list(): Promise<TemplateRecord[]>;
  get(id: string, version: number): Promise<TemplateRecord | null>;
  latestPublished(id: string): Promise<TemplateRecord | null>;
  /** Throws TemplateConflictError when the version exists. `change` is logged for drafts only. */
  create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
    change?: TemplateChangeInput,
  ): Promise<TemplateRecord>;
  /**
   * Null unless the version exists, is a draft and (with `expectedUpdatedAt`) was not written
   * since; then nothing is written. The change is logged in the same write.
   */
  updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    write?: DraftWrite,
  ): Promise<TemplateRecord | null>;
  publish(id: string, version: number): Promise<TemplateRecord | null>;
  /** Deletes the draft and its change log. */
  deleteDraft(id: string, version: number): Promise<boolean>;
  /** The version's change log, newest first (migration 0029). */
  listChanges(id: string, version: number): Promise<TemplateChange[]>;
}
```

3. Replace `MemoryTemplateRepo` with:

```ts
export class MemoryTemplateRepo implements TemplateRepo {
  readonly records = new Map<string, TemplateRecord>();
  /** The change log (template_changes), oldest first. */
  readonly changes: (TemplateChange & { templateId: string })[] = [];
  private changeSeq = 0;
  private lastTime = 0;
  private key = (id: string, version: number) => `${id}@${version}`;

  /** Strictly increasing, so a stale `expectedUpdatedAt` is always detected. */
  private now(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }

  private log(id: string, version: number, at: string, change?: TemplateChangeInput) {
    if (change) {
      this.changes.push({ ...change, templateId: id, version, at, id: String(++this.changeSeq) });
    }
  }

  async list() {
    return [...this.records.values()].sort(byIdVersion);
  }

  async get(id: string, version: number) {
    return this.records.get(this.key(id, version)) ?? null;
  }

  async latestPublished(id: string) {
    const published = (await this.list()).filter((r) => r.id === id && r.status === 'published');
    return published.at(-1) ?? null;
  }

  async create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
    change?: TemplateChangeInput,
  ) {
    if (this.records.has(this.key(id, version))) {
      throw new TemplateConflictError(`${id} v${version} already exists`);
    }
    const now = this.now();
    const record: TemplateRecord = {
      id,
      version,
      status,
      definition,
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : null,
    };
    this.records.set(this.key(id, version), record);
    if (status === 'draft') this.log(id, version, now, change);
    return record;
  }

  async updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    write: DraftWrite = {},
  ) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    if (write.expectedUpdatedAt !== undefined && write.expectedUpdatedAt !== record.updatedAt) {
      return null;
    }
    const updated = { ...record, definition, updatedAt: this.now() };
    this.records.set(this.key(id, version), updated);
    this.log(id, version, updated.updatedAt, write.change);
    return updated;
  }

  async publish(id: string, version: number) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return null;
    const now = this.now();
    const updated: TemplateRecord = {
      ...record,
      status: 'published',
      updatedAt: now,
      publishedAt: now,
    };
    this.records.set(this.key(id, version), updated);
    return updated;
  }

  async deleteDraft(id: string, version: number) {
    const record = await this.get(id, version);
    if (record?.status !== 'draft') return false;
    // ON DELETE CASCADE (migration 0029).
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i]!;
      if (c.templateId === id && c.version === version) this.changes.splice(i, 1);
    }
    return this.records.delete(this.key(id, version));
  }

  async listChanges(id: string, version: number): Promise<TemplateChange[]> {
    return this.changes
      .filter((c) => c.templateId === id && c.version === version)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map(({ templateId: _templateId, ...change }) => change);
  }
}
```

(If lint rejects the `_templateId` binding, copy the entry and `delete` the key instead, as `ExtractStep` does with `rest.table`.)

4. In the Pg section add, above `PgTemplateRepo`:

```ts
interface ChangeRow {
  id: string; // bigint
  version: number;
  at: Date;
  source: TemplateChange['source'];
  stage: TemplateChange['stage'];
  proposal_id: string | null;
  summary: string;
  diff: string[];
  created_by: string | null;
}

const toChange = (r: ChangeRow): TemplateChange => ({
  id: String(r.id),
  version: r.version,
  at: r.at.toISOString(),
  source: r.source,
  stage: r.stage,
  proposalId: r.proposal_id,
  summary: r.summary,
  diff: r.diff,
  by: r.created_by,
});

/**
 * Logs `$5…$10` (source, stage, proposal id, summary, diff, by) for the row the CTE `from` wrote,
 * in the same statement; nothing when `$5` is null or the write matched no row.
 */
const LOG_CHANGE = (from: string) => `INSERT INTO template_changes
    (template_id, version, source, stage, proposal_id, summary, diff, created_by)
  SELECT ${from}.id, ${from}.version, $5, $6, $7, $8, $9::jsonb, $10
    FROM ${from} WHERE $5::text IS NOT NULL`;

const changeParams = (c: TemplateChangeInput | undefined) => [
  c?.source ?? null,
  c?.stage ?? null,
  c?.proposalId ?? null,
  c?.summary ?? null,
  JSON.stringify(c?.diff ?? []),
  c?.by ?? null,
];
```

5. In `PgTemplateRepo`, replace `create` and `updateDraft`, and add `listChanges`:

```ts
  async create(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    status: TemplateStatus,
    change?: TemplateChangeInput,
  ) {
    const record = await this.one(
      `WITH t AS (
         INSERT INTO templates (id, version, status, definition, published_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'published' THEN now() END)
         ON CONFLICT (id, version) DO NOTHING RETURNING *),
       c AS (${LOG_CHANGE('t')})
       SELECT * FROM t`,
      [
        id,
        version,
        status,
        JSON.stringify(definition),
        ...changeParams(status === 'draft' ? change : undefined),
      ],
    );
    if (!record) throw new TemplateConflictError(`${id} v${version} already exists`);
    return record;
  }

  async updateDraft(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    write: DraftWrite = {},
  ) {
    // updated_at keeps microseconds; the ISO strings the API hands out keep milliseconds
    // (node-postgres truncates), so the base is compared truncated to the millisecond.
    return this.one(
      `WITH u AS (
         UPDATE templates SET definition = $3, updated_at = now()
          WHERE id = $1 AND version = $2 AND status = 'draft'
            AND ($4::timestamptz IS NULL
                 OR date_trunc('milliseconds', updated_at) = $4::timestamptz)
         RETURNING *),
       c AS (${LOG_CHANGE('u')})
       SELECT * FROM u`,
      [
        id,
        version,
        JSON.stringify(definition),
        write.expectedUpdatedAt ?? null,
        ...changeParams(write.change),
      ],
    );
  }

  async listChanges(id: string, version: number) {
    const { rows } = await this.pool.query<ChangeRow>(
      `SELECT id, version, at, source, stage, proposal_id, summary, diff, created_by
         FROM template_changes WHERE template_id = $1 AND version = $2 ORDER BY id DESC`,
      [id, version],
    );
    return rows.map(toChange);
  }
```

(`deleteDraft` needs no change in Pg: the FK cascades.)

6. In `apps/api/src/workbench/repo.ts`:
   - In the `deleteProject` doc comment of `WorkbenchRepo`, change "…and the template's draft rows." to "…and the template's draft rows with their change log (migration 0029)."
   - In `PgWorkbenchRepo.deleteProject`, right before `await client.query(\`DELETE FROM templates WHERE id = $1 AND status = 'draft'\`, [id]);` add:

```ts
      // The cascade from templates would take them too; deleted explicitly as a child (TP1).
      await client.query('DELETE FROM template_changes WHERE template_id = $1', [id]);
```

   (`MemoryWorkbenchRepo.deleteProject` already calls `templates.deleteDraft` per version, which now drops the log.)

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project api apps/api/test/template-changes.test.ts apps/api/test/workbench-delete.test.ts` → PASS.
Run the Pg integration test (Global Constraints) → PASS, including the extended `deleteProject` counts.
Run: `npm run typecheck -w @ih/api` → PASS (no caller passes the new arguments yet).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0029_template_changes.sql apps/api/src/templates/repo.ts apps/api/src/workbench/repo.ts apps/api/test/template-changes.test.ts apps/api/test/workbench-delete.test.ts apps/api/test/integration/workbench-pg.test.ts
git commit -m "Templates: draft change log table and repository (TP1, migration 0029)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Record every draft write; refuse saves from a stale base

**Files:**
- Create: `apps/api/src/templates/changes.ts`
- Modify: `apps/api/src/templates/drafts.ts`, `apps/api/src/routes/templates.ts`, `apps/api/src/routes/workbench.ts`, `apps/api/src/routes/workbench-bundle.ts`
- Test: `apps/api/test/template-changes.test.ts`, `apps/api/test/workbench-bundle.test.ts`

**Interfaces:**
- Consumes: `describeDefinitionChange`, `TemplateChangeInput` (Task 1); `TemplateRepo.create/updateDraft/listChanges` (Task 2).
- Produces:
  - `draftChange(before: unknown, after: unknown, origin: ChangeOrigin, suffix?: string): TemplateChangeInput | undefined` (undefined when nothing changed) with `type ChangeOrigin = Pick<TemplateChangeInput, 'source' | 'stage' | 'proposalId' | 'by'>`.
  - `startedChange(summary: string, by: string | null, source?: 'started' | 'import'): TemplateChangeInput`.
  - `createNextDraft(repo, id, from?, by?: string | null)` logs `started` "Draft vN created from published vM".
  - `PUT /api/templates/:id/versions/:version` body `{ definition, baseUpdatedAt? }` (ISO datetime); 409 `the draft changed since you opened it; reload it to see the changes`.
- Summaries recorded: hand saves = `describeDefinitionChange` summary; proposals = summary + ` (n of m proposed changes)` when partly accepted; restores = summary + ` (from the dev|holdout evaluation of YYYY-MM-DD)`; `Draft v1 created`; `Draft vN created from published vM`; `Imported from YAML`; `Imported from a bundle`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/template-changes.test.ts` (add the imports at the top: `import { stringify as toYaml } from 'yaml';`, `import { draftingKey, preparedTriageKey, type ProposalView, type SampleView } from '@ih/shared';`, `import { letter, multipart, testApp } from './helpers.js';`):

```ts
const json = (method: 'POST' | 'PUT', url: string, payload: object) => ({ method, url, payload });
const rows = async (
  templates: { listChanges: MemoryTemplateRepo['listChanges'] },
  id: string,
  version: number,
) => (await templates.listChanges(id, version)).map((c) => [c.source, c.summary, c.diff]);

describe('the draft change log through the routes (TP1)', () => {
  it('logs a hand save with what changed; an unchanged save logs nothing', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const { record } = (await app.inject('/api/templates/letter/versions/1')).json();
    const definition = {
      ...record.definition,
      outputs: { fields: [{ id: 'due_date', type: 'date' }], tables: [] },
    };
    const put = () => app.inject(json('PUT', '/api/templates/letter/versions/1', { definition }));
    expect((await put()).statusCode).toBe(200);
    expect((await put()).statusCode).toBe(200);
    expect(await rows(templates, 'letter', 1)).toEqual([
      ['hand', 'Added field due_date', ['+ due_date']],
      ['started', 'Draft v1 created', []],
    ]);
    expect((await templates.listChanges('letter', 1))[0]!.by).toBeNull(); // no access control here
  });

  it('refuses a save from a stale base with 409 and writes nothing', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const first = (await app.inject('/api/templates/letter/versions/1')).json().record;
    const save = (name: string, baseUpdatedAt?: string) =>
      app.inject(
        json('PUT', '/api/templates/letter/versions/1', {
          definition: { ...first.definition, name },
          ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }),
        }),
      );
    expect((await save('A', first.updatedAt)).statusCode).toBe(200);
    const stale = await save('B', first.updatedAt);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe(
      'the draft changed since you opened it; reload it to see the changes',
    );
    expect((await templates.get('letter', 1))!.definition.name).toBe('A');
    expect((await rows(templates, 'letter', 1)).map(([, summary]) => summary)).toEqual([
      'Changed the name',
      'Draft v1 created',
    ]);
    expect((await save('C', 'yesterday')).statusCode).toBe(400);
    expect((await save('C')).statusCode).toBe(200); // no base: last write wins, as before
  });

  it('logs the start of a draft: a new type and the next version', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    await app.inject(json('PUT', '/api/templates/letter/versions/1', { definition: letter(1) }));
    await app.inject(json('POST', '/api/templates/letter/versions/1/publish', {}));
    expect((await app.inject(json('POST', '/api/templates/letter/drafts', {}))).statusCode).toBe(
      201,
    );
    expect(await rows(templates, 'letter', 2)).toEqual([
      ['started', 'Draft v2 created from published v1', []],
    ]);
  });

  it('logs an imported draft, never a published import', async () => {
    const { app, templates } = await testApp();
    const yaml = (version: number) => toYaml({ ...letter(version), id: 'memo' });
    await app.inject(json('POST', '/api/templates/import', { yaml: yaml(1) }));
    await app.inject(json('POST', '/api/templates/import', { yaml: yaml(2), publish: true }));
    expect(await rows(templates, 'memo', 1)).toEqual([['import', 'Imported from YAML', []]]);
    expect(await rows(templates, 'memo', 2)).toEqual([]);
  });

  it("logs a new Workbench project's draft, for a new and for an existing type", async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'memo', name: 'Memo' }));
    expect(await rows(templates, 'memo', 1)).toEqual([['started', 'Draft v1 created', []]]);
    await templates.create('letter', 1, letter(1), 'published');
    await app.inject(json('POST', '/api/workbench/projects', { id: 'letter' }));
    expect(await rows(templates, 'letter', 2)).toEqual([
      ['started', 'Draft v2 created from published v1', []],
    ]);
  });
});

/** A Workbench project with one prepared dev sample (as in workbench-stages.test.ts). */
async function project() {
  const ctx = await testApp();
  await ctx.app.inject(json('POST', '/api/workbench/projects', { id: 'letter', name: 'Letter' }));
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const pdf = Buffer.from('%PDF-1.7\n% sample\n%%EOF\n');
  const s = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/samples',
      ...multipart({ role: 'dev' }, { filename: 's1.pdf', content: pdf }),
    })
  ).json() as SampleView;
  const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
  ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
  const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
  await ctx.store.put(
    'runs',
    preparedTriageKey(s.sha256),
    Buffer.from(JSON.stringify(triage)),
    'application/json',
  );
  const finish = async (id: string, stage: string, body: unknown) => {
    ctx.repo.draftJobs.set(id, { ...ctx.repo.draftJobs.get(id)!, status: 'succeeded' });
    const result = { stage, model: 'local/big', body, usage: { inputTokens: 1, outputTokens: 1 } };
    await ctx.store.put(
      'runs',
      draftingKey('letter', id),
      Buffer.from(JSON.stringify(result)),
      'application/json',
    );
  };
  return { ...ctx, finish };
}

describe('Workbench writes to the draft (TP1)', () => {
  const putField = (id: string, description = 'd') => ({
    op: 'putField',
    field: { id, type: 'text', description },
    reason: 'r',
  });

  it('logs an applied proposal with its stage and id, and how much of it was applied', async () => {
    const { app, templates, finish } = await project();
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/survey/skip' });
    const p = (
      await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/outputs' })
    ).json() as ProposalView;
    await finish(p.id, 'outputs', { notes: '', changes: [putField('date'), putField('sender', 'Who')] });
    const res = await app.inject(
      json('POST', `/api/workbench/projects/letter/proposals/${p.id}/decision`, {
        decision: 'accepted',
        changes: [0],
      }),
    );
    expect(res.statusCode).toBe(200);
    const [entry] = await templates.listChanges('letter', 1);
    expect(entry).toMatchObject({
      source: 'proposal',
      stage: 'outputs',
      proposalId: p.id,
      summary: 'Added field date (1 of 2 proposed changes)',
      diff: ['+ date'],
    });
  });

  it('logs a restored iteration', async () => {
    const { app, templates, workbench } = await project();
    const iteration = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: { ...letter(1), name: 'Old letter' },
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/iterations/${iteration.id}/restore`,
    });
    expect(res.statusCode).toBe(200);
    const [entry] = await templates.listChanges('letter', 1);
    expect(entry).toMatchObject({
      source: 'restore',
      stage: null,
      summary: `Changed the name (from the dev evaluation of ${iteration.createdAt.slice(0, 10)})`,
      diff: ['Letter → Old letter'],
    });
  });
});
```

In `apps/api/test/workbench-bundle.test.ts`, at the end of `it('imports a bundle as a new project with a v1 draft, the brief and dev samples', …)` add:

```ts
    expect((await templates.listChanges('memo', 1)).map((c) => [c.source, c.summary])).toEqual([
      ['import', 'Imported from a bundle'],
    ]);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project api apps/api/test/template-changes.test.ts apps/api/test/workbench-bundle.test.ts`
Expected: FAIL — the logs are empty, and `baseUpdatedAt` is a 400 (`SaveBody` is strict).

- [ ] **Step 3: Implement**

Create `apps/api/src/templates/changes.ts`:

```ts
import {
  describeDefinitionChange,
  type TemplateChange,
  type TemplateChangeInput,
} from '@ih/shared';
import type { TemplateRecord } from './repo.js';

/** Who and what wrote a change, without the words (which come from the definitions). */
export type ChangeOrigin = Pick<TemplateChangeInput, 'source' | 'stage' | 'proposalId' | 'by'>;

export const byHand = (by: string | null): ChangeOrigin => ({
  source: 'hand',
  stage: null,
  proposalId: null,
  by,
});

/**
 * The change log entry for a write from `before` to `after` (TP1); undefined when nothing
 * changed, so an unchanged save or a re-applied proposal logs nothing.
 */
export function draftChange(
  before: unknown,
  after: unknown,
  origin: ChangeOrigin,
  suffix = '',
): TemplateChangeInput | undefined {
  const text = describeDefinitionChange(before, after);
  if (text.count === 0) return undefined;
  return { ...origin, summary: `${text.summary}${suffix}`, diff: text.diff };
}

/** A draft's first entry: started (a new type, the next version) or imported. */
export function startedChange(
  summary: string,
  by: string | null,
  source: 'started' | 'import' = 'started',
): TemplateChangeInput {
  return { source, stage: null, proposalId: null, summary, diff: [], by };
}

/**
 * The overview's "Hand edit" time: the newest hand change of the version. A version with no
 * log at all predates migration 0029, so its last write stands in.
 */
export function handEditedAt(
  changes: readonly TemplateChange[],
  record: Pick<TemplateRecord, 'updatedAt' | 'createdAt'> | null,
): string | null {
  if (changes.length === 0) return record?.updatedAt ?? record?.createdAt ?? null;
  return changes.find((c) => c.source === 'hand')?.at ?? null;
}
```

In `apps/api/src/templates/drafts.ts`, add `import { startedChange } from './changes.js';` and replace `createNextDraft` with:

```ts
/** The next version as a draft copied from `from` (default: the latest version). */
export async function createNextDraft(
  repo: TemplateRepo,
  id: string,
  from?: number,
  by: string | null = null,
): Promise<TemplateRecord | 'not-found' | 'draft-exists'> {
  const versions = (await repo.list()).filter((r) => r.id === id);
  if (!versions.length) return 'not-found';
  if (versions.some((v) => v.status === 'draft')) return 'draft-exists';
  const source = from ? versions.find((v) => v.version === from) : versions.at(-1);
  if (!source) return 'not-found';
  const next = versions.at(-1)!.version + 1;
  // No draft exists here, so the source is a published version.
  return repo.create(
    id,
    next,
    pinned(source.definition, id, next),
    'draft',
    startedChange(`Draft v${next} created from published v${source.version}`, by),
  );
}
```

In `apps/api/src/routes/templates.ts`:

1. Import `import { byHand, draftChange, startedChange } from '../templates/changes.js';`.
2. Replace `SaveBody` with:

```ts
const SaveBody = z
  .object({
    definition: z.record(z.unknown()).describe('The whole definition, as authored.'),
    baseUpdatedAt: z
      .string()
      .datetime()
      .optional()
      .describe(
        'The `updatedAt` the edit started from. When the draft was written since (a proposal ' +
          'applied, another tab saved), nothing is saved and the answer is a 409.',
      ),
  })
  .strict();
```

3. In the `saveDraft` route: change the 409 response doc to `error('`{id} v{version} is published; start a new draft`, or `the draft changed since you opened it; reload it to see the changes` when `baseUpdatedAt` is not its `updatedAt`.')`, add to the description "Each save that changes the definition is recorded in the draft's change log (`GET /api/workbench/projects/{id}/draft/changes`).", and replace the handler's last statement (`const record = await repo().updateDraft(…); return await withIssues(record!);`) with:

```ts
      const definition = pinned(body.data.definition, id, version);
      const record = await repo().updateDraft(id, version, definition, {
        expectedUpdatedAt: body.data.baseUpdatedAt,
        change: draftChange(existing.definition, definition, byHand(req.auth?.label ?? null)),
      });
      if (!record) {
        const now = await repo().get(id, version);
        return reply.code(409).send({
          error:
            now?.status === 'draft'
              ? 'the draft changed since you opened it; reload it to see the changes'
              : `${id} v${version} is published; start a new draft`,
        });
      }
      return await withIssues(record);
```

4. `createTemplate` route: pass `startedChange('Draft v1 created', req.auth?.label ?? null)` as the fifth argument of `repo().create(…)`.
5. `createDraft` route: `createNextDraft(repo(), req.params.id, body.data.from, req.auth?.label ?? null)`.
6. `importTemplate` route: pass `body.data.publish ? undefined : startedChange('Imported from YAML', req.auth?.label ?? null, 'import')` as the fifth argument of `repo().create(…)`.

In `apps/api/src/routes/workbench.ts`:

1. Import `import { draftChange, startedChange } from '../templates/changes.js';` and add `type ChangeStage` to the `@ih/shared` import list.
2. `createProject`: `await templates.create(id, 1, skeleton(id, name), 'draft', startedChange('Draft v1 created', req.auth?.label ?? null));` and `if (draft === null) await createNextDraft(templates, id, undefined, req.auth?.label ?? null);`.
3. Proposal decision: replace the `const updated = await templates.updateDraft(…)` statement with:

```ts
      const next = pinned(applyChanges(draftRecord.definition, selected), projectId, draft);
      const partial =
        chosen.length < proposed.length
          ? ` (${chosen.length} of ${proposed.length} proposed changes)`
          : '';
      const updated = await templates.updateDraft(projectId, draft, next, {
        change: draftChange(
          draftRecord.definition,
          next,
          {
            source: 'proposal',
            // A change stage: the branch above returned for every other stage.
            stage: record.stage as ChangeStage,
            proposalId: pid,
            by: req.auth?.label ?? null,
          },
          partial,
        ),
      });
```

4. Restore: replace the `const saved = await templates.updateDraft(…)` statement with:

```ts
      const next = pinned(iteration.definition, projectId, draft);
      const current = await templates.get(projectId, draft);
      const saved = await templates.updateDraft(projectId, draft, next, {
        change: draftChange(
          current?.definition ?? {},
          next,
          { source: 'restore', stage: null, proposalId: null, by: req.auth?.label ?? null },
          ` (from the ${iteration.set} evaluation of ${iteration.createdAt.slice(0, 10)})`,
        ),
      });
```

In `apps/api/src/routes/workbench-bundle.ts`, import `startedChange` from `../templates/changes.js` and change the draft creation to:

```ts
      await templates.create(
        projectId,
        1,
        pinned(definition, projectId, 1),
        'draft',
        startedChange('Imported from a bundle', req.auth?.label ?? null, 'import'),
      );
```

(`req` is the handler's `FastifyRequest`, already in scope there: it is used for `createdBy` a few lines below.)

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project api apps/api/test/template-changes.test.ts apps/api/test/workbench-bundle.test.ts apps/api/test/templates.test.ts apps/api/test/workbench-stages.test.ts apps/api/test/workbench-evaluation.test.ts apps/api/test/openapi.test.ts` → PASS (the conformance check validates the new 409 against the docs).
Run: `npm run typecheck -w @ih/api` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/templates/changes.ts apps/api/src/templates/drafts.ts apps/api/src/routes/templates.ts apps/api/src/routes/workbench.ts apps/api/src/routes/workbench-bundle.ts apps/api/test/template-changes.test.ts apps/api/test/workbench-bundle.test.ts
git commit -m "API: log every draft write; refuse a save from a stale base with 409 (TP1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `GET …/draft/changes` and the overview's *Hand edit*

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`, `apps/api/src/routes/workbench-overview.ts`
- Test: `apps/api/test/template-changes.test.ts`, `apps/api/test/workbench-overview.test.ts`

**Interfaces:**
- Consumes: `TemplateRepo.listChanges` (Task 2), `handEditedAt` (Task 3), `TemplateChangeSchema` (Task 1).
- Produces: `GET /api/workbench/projects/:id/draft/changes` → `200 TemplateChange[]` (the open draft's log, newest first; `[]` without an open draft), `404 project not found`; `operationId: 'listDraftChanges'`, tag `Drafting stages & proposals`. `MetricFacts.template.editedAt` = `handEditedAt(changes, template)`.
- No `projectFingerprints` / `LIST_CACHE_VERSION` change: list rows carry no metrics, and every logged change writes `templates.updated_at` in the same statement, which the fingerprint already reads.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/template-changes.test.ts` (add `import { handEditedAt } from '../src/templates/changes.js';` and `import type { TemplateChange } from '@ih/shared';`):

```ts
describe('GET /api/workbench/projects/:id/draft/changes', () => {
  it("lists the open draft's changes newest first", async () => {
    const { app } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'letter', name: 'Letter' }));
    await app.inject(json('PUT', '/api/templates/letter/versions/1', { definition: letter(1) }));
    const res = await app.inject('/api/workbench/projects/letter/draft/changes');
    expect(res.statusCode).toBe(200);
    expect((res.json() as TemplateChange[]).map((c) => [c.source, c.version])).toEqual([
      ['hand', 1],
      ['started', 1],
    ]);
  });

  it('is empty without an open draft and 404s an unknown project', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'letter', name: 'Letter' }));
    await templates.publish('letter', 1);
    expect((await app.inject('/api/workbench/projects/letter/draft/changes')).json()).toEqual([]);
    const missing = await app.inject('/api/workbench/projects/nope/draft/changes');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'project not found' });
  });
});

describe('handEditedAt', () => {
  const entry = (source: TemplateChange['source'], at: string): TemplateChange => ({
    id: at,
    version: 1,
    at,
    source,
    stage: source === 'proposal' ? 'outputs' : null,
    proposalId: null,
    summary: 's',
    diff: [],
    by: null,
  });
  const record = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
  it.each<[string, TemplateChange[], string | null]>([
    ['no log (before migration 0029): the last write', [], record.updatedAt],
    ['the newest hand change', [entry('proposal', 'c'), entry('hand', 'b'), entry('hand', 'a')], 'b'],
    ['no hand change yet', [entry('proposal', 'b'), entry('started', 'a')], null],
  ])('%s', (_name, changes, expected) => expect(handEditedAt(changes, record)).toBe(expected));
  it('is null without a version', () => expect(handEditedAt([], null)).toBeNull());
});
```

In `apps/api/test/workbench-overview.test.ts`, replace `it('reads the template figures from the open draft', …)` with (a deliberate change: *Hand edit* now means the newest hand change, not the last write of any kind):

```ts
  it('reads the template figures from the open draft, and the last hand edit from its log', async () => {
    const p = await project();
    const o = await p.overview();
    const template = o.stages.find((s) => s.stage === 'template')!.metrics;
    // `letter`: one pipeline step, one section, one field.
    expect(template[0]).toEqual({ label: 'Steps · sections', value: '1 · 1', at: null });
    // Only the draft's start is logged (the helper wrote the draft directly): no hand edit yet.
    expect(template[1]).toEqual({ label: 'Hand edit', value: '—', at: null });
    await p.app.inject({
      method: 'PUT',
      url: '/api/templates/letter/versions/1',
      payload: { definition: { ...(await p.templates.get('letter', 1))!.definition, name: 'Memo' } },
    });
    const [hand] = await p.templates.listChanges('letter', 1);
    expect((await p.metrics('template'))[1]).toEqual({ label: 'Hand edit', value: '—', at: hand!.at });
    expect(await p.metrics('outputs')).toEqual([
      { label: 'Fields · tables', value: '1 · 0', at: null },
      { label: 'Changes applied', value: '—', at: null },
    ]);
    expect((await p.metrics('sections'))[0]).toEqual({ label: 'Sections', value: '1', at: null });
  });
```

(`project()` in that file returns `{ ...ctx, overview, item, metrics, … }`, and `metrics(stage)` reads any tab's figures.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project api apps/api/test/template-changes.test.ts apps/api/test/workbench-overview.test.ts`
Expected: FAIL — the route 404s (`Route GET … not found`), and *Hand edit* still reads `updatedAt`.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/workbench.ts`, add `TemplateChangeSchema` to the `@ih/shared` imports and register after the `GET /workbench/projects/:id/briefs/:version` route:

```ts
  app.get<{ Params: ProjectParams }>(
    '/workbench/projects/:id/draft/changes',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'listDraftChanges',
        summary: "List the open draft's changes",
        description: md`
          The open draft's change log, newest first: every write to its definition with where it
          came from (\`hand\` saves, applied \`proposal\`s with their \`stage\`, \`restore\`d
          iterations, the draft's \`started\` entry, \`import\`s), a one-line \`summary\` and up to
          four \`diff\` chips. Empty without an open draft, and for drafts started before the log
          existed. The Template tab's *Changes since vN* panel.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The changes, newest first.', z.array(TemplateChangeSchema)),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const { draft } = await versionsOf(templates, req.params.id);
      return draft === null ? [] : templates.listChanges(req.params.id, draft);
    },
  );
```

In `apps/api/src/routes/workbench-overview.ts`:

1. Import `import { handEditedAt } from '../templates/changes.js';`.
2. In `gatherFacts`, add an eighth entry to the `Promise.all` and destructure it as `changes`:

```ts
  const [template, survey, outputsResult, sectionsResult, stepsResult, dev, holdout, changes] =
    await Promise.all([
      version === null ? null : app.deps.templates.get(id, version),
      // … the six existing entries, unchanged …
      version === null ? [] : app.deps.templates.listChanges(id, version),
    ]);
```

3. Replace `editedAt: template?.updatedAt ?? template?.createdAt ?? null,` with `editedAt: handEditedAt(changes, template),`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project api apps/api/test/template-changes.test.ts apps/api/test/workbench-overview.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts` → PASS (the openapi test sees the route's tags, summary, description and unique `operationId`; the access sweep sees it guarded).
Run: `npm run openapi` (regenerates `docs/openapi.json`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/src/routes/workbench-overview.ts apps/api/test/template-changes.test.ts apps/api/test/workbench-overview.test.ts docs/openapi.json
git commit -m "API: GET draft changes; the overview's hand edit reads the change log (TP1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web client

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`
- Test: `apps/web/test/client.test.ts`

**Interfaces:**
- Produces on `Api`: `listDraftChanges(projectId: string): Promise<TemplateChange[]>`; `saveTemplate(id, version, definition, baseUpdatedAt?: string): Promise<TemplateRecordView>` (sends `baseUpdatedAt` only when it is a non-empty string). `fakeApi().listDraftChanges` resolves `[]`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/client.test.ts`:

```ts
describe('http api: template drafts (TP1)', () => {
  it('lists the draft changes and saves with the base it started from', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listDraftChanges('letter');
    await api.saveTemplate('letter', 2, { name: 'A' }, '2026-10-13T10:00:00.000Z');
    await api.saveTemplate('letter', 2, { name: 'A' });
    await api.saveTemplate('letter', 2, { name: 'A' }, '');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workbench/projects/letter/draft/changes',
      '/api/templates/letter/versions/2',
      '/api/templates/letter/versions/2',
      '/api/templates/letter/versions/2',
    ]);
    expect(fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { definition: { name: 'A' }, baseUpdatedAt: '2026-10-13T10:00:00.000Z' },
      { definition: { name: 'A' } },
      { definition: { name: 'A' } },
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web apps/web/test/client.test.ts` → FAIL (`api.listDraftChanges is not a function`).

- [ ] **Step 3: Implement**

In `apps/web/src/api/client.ts`: add `type TemplateChange` to the `@ih/shared` imports; in the `Api` interface replace the `saveTemplate` signature with

```ts
  /** `baseUpdatedAt`: the version's `updatedAt` the edit started from (409 when it moved). */
  saveTemplate(
    id: string,
    version: number,
    definition: Record<string, unknown>,
    baseUpdatedAt?: string,
  ): Promise<TemplateRecordView>;
```

and add next to `listBriefVersions`:

```ts
  /** TP1: the open draft's change log, newest first. */
  listDraftChanges(projectId: string): Promise<TemplateChange[]>;
```

In `createHttpApi`:

```ts
    saveTemplate: (id, version, definition, baseUpdatedAt) =>
      post<TemplateRecordView>(
        `${base}/templates/${id}/versions/${version}`,
        { definition, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
        'PUT',
      ),
```

```ts
    listDraftChanges: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/draft/changes`).then(json<TemplateChange[]>),
```

In `apps/web/test/fake-api.ts` add to `fakeApi`'s defaults: `listDraftChanges: vi.fn(async () => []),`.

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run --project web apps/web/test/client.test.ts` → PASS; `npm run typecheck -w @ih/web` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/client.test.ts
git commit -m "Web client: draft change log and saves with a base (TP1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Move the editor's building blocks out of `TemplateEditor.tsx`

A refactor with no behaviour change, so Tasks 8–10 can reuse the field components, step forms and the delete menu. The only new behaviour is `retryWarning(m, here)` and the exported `StepFigures`.

**Files:**
- Create: `apps/web/src/templates/fields.tsx`, `apps/web/src/templates/StepForms.tsx`, `apps/web/src/templates/DraftMenu.tsx`
- Modify: `apps/web/src/templates/TemplateEditor.tsx`, `apps/web/src/templates/EditorHeader.tsx`, `apps/web/src/workbench/StepsView.tsx`, `apps/web/src/workbench/steps.ts`
- Test: `apps/web/test/steps-derive.test.ts` (and the whole existing `TemplateEditor.test.tsx` as the regression net)

**Interfaces:**
- Produces: `fields.tsx` exports `Text` (with a new optional `placeholder?: string`), `Area`, `Select`, `Checklist`, `opt`, `intList`, `optInt`; `StepForms.tsx` exports `ExtractStep`, `CheckStep`, `ContextEditor`, `defaultLabel`; `DraftMenu({ version, onDelete })` renders *More actions → Delete draft* and its inline confirm; `StepFigures({ metric, here? })` from `workbench/StepsView.tsx`; `retryWarning(m, here = false)`.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/steps-derive.test.ts`, extend `it('explains a step that keeps retrying, in plain words', …)` with:

```ts
    expect(retryWarning(metric(2), true)).toBe(
      'Needs a retry on many runs (2.0 attempts on average): the first answer often fails the checks. Narrow the sections it reads or add instructions below.',
    );
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web apps/web/test/steps-derive.test.ts` → FAIL (the second argument is ignored).

- [ ] **Step 3: Implement**

1. `apps/web/src/workbench/steps.ts` — replace `retryWarning` with:

```ts
/** `here`: shown beside the step's own form (the Template tab), not on the Steps tab. */
export function retryWarning(m: StepMetric | undefined, here = false): string | null {
  if (!m || m.runs === 0 || m.avgAttempts < RETRY_WARN_ATTEMPTS) return null;
  const where = here ? 'below' : 'on the Template tab';
  return `Needs a retry on many runs (${m.avgAttempts.toFixed(1)} attempts on average): the first answer often fails the checks. Narrow the sections it reads or add instructions ${where}.`;
}
```

2. `apps/web/src/workbench/StepsView.tsx` — rename `function Figures({ metric }: …)` to `export function StepFigures({ metric, here = false }: { metric: StepMetric | undefined; here?: boolean })`, make it call `retryWarning(metric, here)`, and change the one use to `<StepFigures metric={metric} />`.

3. Create `apps/web/src/templates/fields.tsx`: move from `TemplateEditor.tsx`, verbatim, the helpers `opt`, `intList`, `optInt` (current lines 41–49) and the components `Checklist`, `Text`, `Area`, `Select` (current lines 1032–1155), each with `export`. Give `Text` one new optional prop, passed to its `<input>`:

```tsx
  /** Shown while empty, e.g. "all" for Pages per call. */
  placeholder?: string;
```

   (`<input … placeholder={placeholder} …/>`). The file starts with `import type { ReactNode } from 'react';` only if a component needs it (none does: drop it if lint complains).

4. Create `apps/web/src/templates/StepForms.tsx`: move from `TemplateEditor.tsx`, verbatim, `FILLS` (lines 36–39), `defaultLabel` (lines 524–528), `ExtractStep` (530–648), `ContextEditor` (650–687) and `CheckStep` (689–726), exporting `defaultLabel`, `ExtractStep`, `ContextEditor`, `CheckStep`. Imports:

```tsx
import { useState } from 'react';
import type { ModelChoice } from '@ih/shared';
import { ModelPicker } from '../ui/ModelPicker.js';
import { Segmented } from '../ui/Segmented.js';
import { Area, Checklist, intList, opt, optInt, Select, Text } from './fields.js';
import type { Definition } from './model.js';
```

5. `TemplateEditor.tsx`: delete the moved code and import it back:

```tsx
import { Area, opt, Select, Text } from './fields.js';
import { CheckStep, defaultLabel, ExtractStep } from './StepForms.js';
```

   (drop the now-unused `Segmented` and `VALUE_TYPES`/`ModelChoice` imports only if they are unused — `ValueList` still uses `VALUE_TYPES`.)

6. Create `apps/web/src/templates/DraftMenu.tsx` from the menu and confirm parts of `EditorHeader.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.js';

/**
 * *More actions → Delete draft* with its inline confirm (UI handoff §5). Deleting is
 * irreversible: the confirm opens on Keep, so a stray Enter keeps the draft; Keep and Escape
 * return focus to More actions.
 */
export function DraftMenu({ version, onDelete }: { version: number; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);

  // The menu closes on a click anywhere else (like the job row menus).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  useEffect(() => {
    if (confirming) keepButton.current?.focus();
    else if (returnFocus) {
      more.current?.focus();
      setReturnFocus(false);
    }
  }, [confirming, returnFocus]);

  return (
    <>
      <div
        className="menu-anchor"
        ref={anchor}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && menu) {
            setMenu(false);
            more.current?.focus();
          }
        }}
      >
        <button
          ref={more}
          type="button"
          className="icon bordered"
          aria-label="More actions"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <Icon name="more" />
        </button>
        {menu && (
          <div className="menu menu-down" role="group" aria-label="More actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenu(false);
                setConfirming(true);
              }}
            >
              Delete draft
            </button>
          </div>
        )}
      </div>
      {confirming && (
        <div className="inline-confirm delete-confirm" role="group" aria-label="Confirm delete">
          <span>Delete draft v{version}? This cannot be undone.</span>
          <button
            type="button"
            className="danger-fill"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            Delete draft v{version}
          </button>
          <button
            ref={keepButton}
            type="button"
            onClick={() => {
              setConfirming(false);
              setReturnFocus(true);
            }}
          >
            Keep
          </button>
        </div>
      )}
    </>
  );
}
```

7. `EditorHeader.tsx`: remove the `menu`/`confirming`/`returnFocus` state, the three refs, both effects, the `menu-anchor` block and the trailing `{confirming && …}` block; render `<DraftMenu version={version} onDelete={onDeleteDraft} />` where the `menu-anchor` div was; drop the now-unused `useEffect`, `useRef`, `useState` imports (the confirm now sits inside `.editor-actions`; `.delete-confirm` is `flex: 1 1 100%`, so it still takes its own row).

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run --project web apps/web/test/steps-derive.test.ts apps/web/test/TemplateEditor.test.tsx apps/web/test/StepsTab.test.tsx apps/web/test/TemplatesPage.test.tsx` → PASS (every existing editor test, including "deletes a draft only after confirming", "closes More actions on an outside click and on Escape" and "focuses Keep", unchanged).
Run: `npm run typecheck -w @ih/web && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/fields.tsx apps/web/src/templates/StepForms.tsx apps/web/src/templates/DraftMenu.tsx apps/web/src/templates/TemplateEditor.tsx apps/web/src/templates/EditorHeader.tsx apps/web/src/workbench/StepsView.tsx apps/web/src/workbench/steps.ts apps/web/test/steps-derive.test.ts
git commit -m "Templates web: move field components, step forms and the delete menu out of the editor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pure helpers for the embedded editor

**Files:**
- Create: `apps/web/src/templates/checks.ts`, `apps/web/test/template-checks.test.ts`
- Modify: `apps/web/src/templates/editor-derive.ts`, `apps/web/test/editor-derive.test.ts`

**Interfaces:**
- Produces in `checks.ts`:
  - `type SubTab = 'general' | 'sections' | 'outputs' | 'pipeline' | 'yaml'`, `SUB_TAB_LABEL: Record<SubTab, string>`.
  - `interface TemplateCheck { tone: 'ok' | 'warn' | 'alert' | 'danger'; text: string; link: { label: string; hash: string } | { label: string; subTab: SubTab } | null; subTabs: SubTab[] }`.
  - `issueSubTab(issue: string): SubTab`.
  - `templateChecks(input: { projectId: string; definition: Record<string, unknown>; issues: readonly string[]; serverIssues: readonly string[]; stages: readonly OverviewItem[] | null }): TemplateCheck[]`.
  - `attentionTabs(checks: readonly TemplateCheck[]): Set<SubTab>`.
  - `issueText(i: { path: string; message: string }): string` (the client's `validateDefinition` wording for a server issue).
- Produces in `editor-derive.ts`: `stepListSummary(step): string`, `unsavedText(subjects: readonly string[]): string`, `changeTag(c: Pick<TemplateChange, 'source' | 'stage'>): string`, `tryOnBlockedReason(dirty: boolean, readyDevSamples: number | null): string | null`, `changeAtText(iso: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/template-checks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { OverviewItem } from '@ih/shared';
import {
  attentionTabs,
  issueSubTab,
  issueText,
  templateChecks,
  type SubTab,
} from '../src/templates/checks.js';

const definition = {
  outputs: { fields: [{ id: 'total' }, { id: 'due_date' }], tables: [] },
  pipeline: [{ type: 'extract', id: 'totals', fields: ['total'], sections: ['totals'] }],
};
const stale = (stage: OverviewItem['stage']): OverviewItem => ({
  stage,
  state: 'stale',
  status: 'Stale — Outputs changed after it was accepted',
  metrics: [],
});
const run = (over: Partial<Parameters<typeof templateChecks>[0]> = {}) =>
  templateChecks({ projectId: 'invoice', definition, issues: [], serverIssues: [], stages: null, ...over });

describe('issueSubTab', () => {
  it.each<[string, SubTab]>([
    ['document.sections: Array must contain at least 1 element(s)', 'sections'],
    ['outputs.fields.0.type: Invalid enum value', 'outputs'],
    ['duplicate output id "total"', 'outputs'],
    ['output id "rows" is reserved', 'outputs'],
    ['pipeline: Array must contain at least 1 element(s)', 'pipeline'],
    ['step "totals": unknown section "payment"', 'pipeline'],
    ['check "sum": unknown field or column "x"', 'pipeline'],
    ['duplicate step id "a"', 'pipeline'],
    ['name: String must contain at least 1 character(s)', 'general'],
  ])('%s -> %s', (issue, tab) => expect(issueSubTab(issue)).toBe(tab));
});

describe('templateChecks', () => {
  it('names an output no step fills, linking to Steps and marking Outputs and Pipeline', () => {
    const checks = run({ issues: ['field "due_date" is not filled by any step'] });
    expect(checks).toEqual([
      {
        tone: 'warn',
        text: 'due_date is not filled by any step.',
        link: { label: 'Add it to a step in Steps', hash: '#/workbench/invoice/steps' },
        subTabs: ['outputs', 'pipeline'],
      },
    ]);
    expect([...attentionTabs(checks)].sort()).toEqual(['outputs', 'pipeline']);
  });

  it('says so when everything is valid and filled', () => {
    const full = { ...definition, outputs: { fields: [{ id: 'total' }], tables: [] } };
    expect(run({ definition: full })).toEqual([
      { tone: 'ok', text: 'Sections, outputs and steps are valid.', link: null, subTabs: [] },
    ]);
  });

  it('lists validation issues once, with a link to the sub-tab that fixes them', () => {
    const issue = 'pipeline.0.model: model local/x is not offered';
    const checks = run({
      definition: { ...definition, outputs: { fields: [{ id: 'total' }], tables: [] } },
      issues: [issue],
      serverIssues: [issue, 'name: Required'],
    });
    expect(checks).toEqual([
      { tone: 'danger', text: issue, link: { label: 'Open Pipeline', subTab: 'pipeline' }, subTabs: ['pipeline'] },
      { tone: 'danger', text: 'name: Required', link: { label: 'Open General', subTab: 'general' }, subTabs: ['general'] },
    ]);
  });

  it('adds stale stages after the draft checks, each linking to its tab', () => {
    const full = { ...definition, outputs: { fields: [{ id: 'total' }], tables: [] } };
    const checks = run({
      definition: full,
      stages: [stale('sections'), { ...stale('steps'), state: 'accepted' }, stale('publish')],
    });
    expect(checks.slice(1)).toEqual([
      {
        tone: 'alert',
        text: 'Sections: Stale — Outputs changed after it was accepted',
        link: { label: 'Review in Sections', hash: '#/workbench/invoice/sections' },
        subTabs: [],
      },
      {
        tone: 'alert',
        text: 'Publish: Stale — Outputs changed after it was accepted',
        link: { label: 'Review in Evaluate', hash: '#/workbench/invoice/evaluate' },
        subTabs: [],
      },
    ]);
  });

  it('flags outputs more than one step fills', () => {
    const twice = {
      outputs: { fields: [{ id: 'total' }], tables: [] },
      pipeline: [
        { type: 'extract', id: 'a', fields: ['total'], sections: [] },
        { type: 'extract', id: 'b', fields: ['total'], sections: [] },
      ],
    };
    expect(run({ definition: twice, issues: ['field "total" is filled by more than one step'] })).toEqual([
      {
        tone: 'warn',
        text: 'total is filled by more than one step.',
        link: { label: 'Review in Steps', hash: '#/workbench/invoice/steps' },
        subTabs: ['pipeline'],
      },
    ]);
  });
});

describe('issueText', () => {
  it('words a server issue as the editor does', () => {
    expect(issueText({ path: 'pipeline.0.model', message: 'not offered' })).toBe(
      'pipeline.0.model: not offered',
    );
    expect(issueText({ path: '', message: 'duplicate step id "a"' })).toBe('duplicate step id "a"');
  });
});
```

Append to `apps/web/test/editor-derive.test.ts` (extend its import with `changeAtText`, `changeTag`, `stepListSummary`, `tryOnBlockedReason`, `unsavedText`):

```ts
describe('stepListSummary', () => {
  it.each<[Record<string, unknown>, string]>([
    [{ type: 'extract', id: 'h', fields: ['a', 'b'], sections: ['header', 'supplier'] }, 'Fills 2 · reads header, supplier'],
    [{ type: 'extract', id: 'l', table: 'line_items', sections: ['line_items'] }, 'Fills 1 · reads line_items'],
    [{ type: 'extract', id: 'x', fields: [], sections: [] }, 'Fills 0 · reads no sections'],
    [{ type: 'check', id: 'c', values: 'total', reference: 'subtotal' }, 'Checks total against subtotal'],
    [{ type: 'check', id: 'c' }, 'Check not set up yet'],
  ])('%j', (step, text) => expect(stepListSummary(step)).toBe(text));
});

describe('unsavedText', () => {
  it.each<[string[], string]>([
    [['step totals'], 'Unsaved change to step totals'],
    [['step totals', 'field a', 'the name'], 'Unsaved changes to step totals and 2 more'],
    [[], 'Unsaved changes'],
  ])('%j', (subjects, text) => expect(unsavedText(subjects)).toBe(text));
});

describe('changeTag', () => {
  it.each<[Parameters<typeof changeTag>[0], string]>([
    [{ source: 'hand', stage: null }, 'BY HAND'],
    [{ source: 'proposal', stage: 'outputs' }, 'OUTPUTS PROPOSAL'],
    [{ source: 'proposal', stage: 'revise' }, 'REVISE PROPOSAL'],
    [{ source: 'restore', stage: null }, 'RESTORED'],
    [{ source: 'started', stage: null }, 'STARTED'],
    [{ source: 'import', stage: null }, 'IMPORTED'],
  ])('%j', (c, tag) => expect(changeTag(c)).toBe(tag));
});

describe('tryOnBlockedReason', () => {
  it.each<[boolean, number | null, string | null]>([
    [false, null, 'Loading the dev samples…'],
    [true, 3, 'Save the draft first: a test run uses the saved draft'],
    [false, 0, 'No prepared dev samples: add or prepare some on the Samples tab'],
    [false, 2, null],
  ])('dirty %s, %s ready', (dirty, n, reason) => expect(tryOnBlockedReason(dirty, n)).toBe(reason));
});

describe('changeAtText', () => {
  it('shows the day, month and time', () => {
    expect(changeAtText('2026-10-12T08:40:00.000Z')).toMatch(/^\d{1,2} Oct,? \d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/template-checks.test.ts apps/web/test/editor-derive.test.ts` → FAIL (modules / exports missing).

- [ ] **Step 3: Implement**

Create `apps/web/src/templates/checks.ts`:

```ts
import { OVERVIEW_TAB_LABEL, outputCoverage, type OverviewItem } from '@ih/shared';

/** The embedded editor's sub-tabs (handoff §10; Quality is the Templates page's only). */
export type SubTab = 'general' | 'sections' | 'outputs' | 'pipeline' | 'yaml';

export const SUB_TAB_LABEL: Record<SubTab, string> = {
  general: 'General',
  sections: 'Sections',
  outputs: 'Outputs',
  pipeline: 'Pipeline',
  yaml: 'YAML',
};

export interface TemplateCheck {
  tone: 'ok' | 'warn' | 'alert' | 'danger';
  text: string;
  /** Where it is fixed: a project tab, or one of the editor's sub-tabs. */
  link: { label: string; hash: string } | { label: string; subTab: SubTab } | null;
  /** The sub-tabs that get a warn dot for it. */
  subTabs: SubTab[];
}

/** The coverage issues, which the Checks panel words itself (with a link to Steps). */
const COVERAGE = /is (not filled by any step|filled by more than one step)$/;

/** The sub-tab where a validation issue (as `validateDefinition` words it) is fixed. */
export function issueSubTab(issue: string): SubTab {
  if (/^document\.sections/.test(issue)) return 'sections';
  if (/^(outputs|duplicate output id|output id ")/.test(issue)) return 'outputs';
  if (/^(pipeline|step "|check "|duplicate step id)/.test(issue)) return 'pipeline';
  return 'general';
}

/** A server issue in the editor's wording: `path: message`, or the message alone. */
export const issueText = (i: { path: string; message: string }) =>
  i.path ? `${i.path}: ${i.message}` : i.message;

/**
 * The Template tab's Checks (handoff §10): outputs no step fills (or several fill), validation
 * issues, or that all is valid; then stale stages. Every item links to where it is fixed.
 */
export function templateChecks(input: {
  projectId: string;
  definition: Record<string, unknown>;
  /** Live issues of the definition being edited. */
  issues: readonly string[];
  /** The saved version's issues (they add the model checks); empty while edits are pending. */
  serverIssues: readonly string[];
  stages: readonly OverviewItem[] | null;
}): TemplateCheck[] {
  const tab = (t: string) => `#/workbench/${input.projectId}/${t}`;
  const coverage = outputCoverage(input.definition);
  const checks: TemplateCheck[] = [
    ...coverage.uncovered.map(
      (id): TemplateCheck => ({
        tone: 'warn',
        text: `${id} is not filled by any step.`,
        link: { label: 'Add it to a step in Steps', hash: tab('steps') },
        subTabs: ['outputs', 'pipeline'],
      }),
    ),
    ...coverage.multiple.map(
      (id): TemplateCheck => ({
        tone: 'warn',
        text: `${id} is filled by more than one step.`,
        link: { label: 'Review in Steps', hash: tab('steps') },
        subTabs: ['pipeline'],
      }),
    ),
  ];
  const issues = [...new Set([...input.issues, ...input.serverIssues])].filter(
    (i) => !COVERAGE.test(i),
  );
  for (const issue of issues) {
    const sub = issueSubTab(issue);
    checks.push({
      tone: 'danger',
      text: issue,
      link: { label: `Open ${SUB_TAB_LABEL[sub]}`, subTab: sub },
      subTabs: [sub],
    });
  }
  if (checks.length === 0) {
    checks.push({ tone: 'ok', text: 'Sections, outputs and steps are valid.', link: null, subTabs: [] });
  }
  for (const item of input.stages ?? []) {
    if (item.state !== 'stale') continue;
    const target = item.stage === 'publish' ? 'evaluate' : item.stage;
    checks.push({
      tone: 'alert',
      text: `${OVERVIEW_TAB_LABEL[item.stage]}: ${item.status}`,
      link: { label: `Review in ${OVERVIEW_TAB_LABEL[target]}`, hash: tab(target) },
      subTabs: [],
    });
  }
  return checks;
}

/** The sub-tabs to mark with a warn dot. */
export function attentionTabs(checks: readonly TemplateCheck[]): Set<SubTab> {
  return new Set(checks.flatMap((c) => c.subTabs));
}
```

Append to `apps/web/src/templates/editor-derive.ts` (add `import type { TemplateChange } from '@ih/shared';` at the top):

```ts
/** The Pipeline list's line under a step's id: "Fills 5 · reads header, supplier". */
export function stepListSummary(step: Record<string, unknown>): string {
  if (step.type === 'check') {
    const values = text(step.values).trim();
    const reference = text(step.reference).trim();
    return values && reference ? `Checks ${values} against ${reference}` : 'Check not set up yet';
  }
  const fills = typeof step.table === 'string' ? 1 : list(step.fields).length;
  const sections = list(step.sections).map(String);
  return `Fills ${fills} · reads ${sections.length ? sections.join(', ') : 'no sections'}`;
}

/** The unsaved bar's headline, from `describeDefinitionChange(saved, current).subjects`. */
export function unsavedText(subjects: readonly string[]): string {
  if (subjects.length === 0) return 'Unsaved changes';
  if (subjects.length === 1) return `Unsaved change to ${subjects[0]}`;
  return `Unsaved changes to ${subjects[0]} and ${subjects.length - 1} more`;
}

/** A change log entry's tag: BY HAND, OUTPUTS PROPOSAL, RESTORED, STARTED, IMPORTED. */
export function changeTag(c: Pick<TemplateChange, 'source' | 'stage'>): string {
  switch (c.source) {
    case 'hand':
      return 'BY HAND';
    case 'proposal':
      return `${(c.stage ?? 'stage').toUpperCase()} PROPOSAL`;
    case 'restore':
      return 'RESTORED';
    case 'started':
      return 'STARTED';
    case 'import':
      return 'IMPORTED';
  }
}

/** Why *Test run* is disabled (its title); null when it can run. `null` samples: loading. */
export function tryOnBlockedReason(dirty: boolean, readyDevSamples: number | null): string | null {
  if (readyDevSamples === null) return 'Loading the dev samples…';
  if (dirty) return 'Save the draft first: a test run uses the saved draft';
  if (readyDevSamples === 0) return 'No prepared dev samples: add or prepare some on the Samples tab';
  return null;
}

/** "12 Oct 08:40" (local time), as the change log shows it. */
export function changeAtText(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/template-checks.test.ts apps/web/test/editor-derive.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/checks.ts apps/web/src/templates/editor-derive.ts apps/web/test/template-checks.test.ts apps/web/test/editor-derive.test.ts
git commit -m "Templates web: checks, step summaries and change log wording for the Template tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Embedded editor shell — tab header, *Try on*, sub-tabs, unsaved bar, safe saves

**Files:**
- Create: `apps/web/src/templates/EmbeddedHeader.tsx`, `apps/web/src/templates/TryOn.tsx`, `apps/web/src/templates/UnsavedBar.tsx`
- Modify: `apps/web/src/templates/TemplateEditor.tsx`
- Test: `apps/web/test/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `DraftMenu` (Task 6), `tryOnBlockedReason`, `unsavedText` (Task 7), `describeDefinitionChange` (Task 1), `api.saveTemplate(…, baseUpdatedAt)` (Task 5), `runSamples` (`workbench/runs.ts`), `ReprocessDialog`, `useModelChoices`, `TabHeader`.
- Produces: `export interface EmbeddedEditor { onChanged: () => void; onSaved?: () => void; dataPolicy?: DataPolicy; stages?: readonly OverviewItem[] | null; published?: number | null }` — the `embedded` prop's type (Tasks 9–11 read `stages` and `published`).

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/TemplateEditor.test.tsx`:

1. Imports: add `import { ApiError } from '../src/api/client.js';`, `import type { EmbeddedEditor } from '../src/templates/TemplateEditor.js';` and `sampleView` to the `./fake-api.js` import.
2. Change `setup`'s third parameter type to `embedded?: EmbeddedEditor`.
3. In `describe('embedded in the workbench', …)`:
   - `it('hides the single-sample test run …')`: replace `await screen.findByRole('button', { name: /^Publish v1/ });` with `await screen.findByRole('heading', { level: 2, name: 'Template · draft v1' });`.
   - Replace `it('publishes through the Workbench, without references or evaluation, and reports it', …)` (deliberate: per handoff §10 the embedded editor has no Publish; the project header's *Publish vN* opens Evaluate, whose gate card publishes through `api.publish`, covered by `GateCard.test.tsx`) with:

```ts
    it('has the tab header, and no back link, name heading, Publish or Save draft button', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Template · draft v1' }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Model proposals and your edits change the same draft/)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Document types/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Publish/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Export YAML' })).toHaveAttribute(
        'href',
        '/api/templates/letter/versions/1/export',
      );
    });
```

4. Append inside `describe('embedded in the workbench', …)`:

```ts
    it('opens on Pipeline, ordered General, Sections, Outputs, Pipeline, YAML, without Quality', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await screen.findByRole('heading', { level: 2, name: 'Template · draft v1' });
      const tabs = within(screen.getByRole('tablist', { name: 'Template sections' })).getAllByRole(
        'tab',
      );
      expect(tabs.map((t) => t.textContent?.replace(/\s*\d+.*$/, ''))).toEqual([
        'General',
        'Sections',
        'Outputs',
        'Pipeline',
        'YAML',
      ]);
      expect(screen.getByRole('tab', { name: /^Pipeline/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: /Quality/ })).not.toBeInTheDocument();
      // validDefinition: one field and one table.
      expect(screen.getByRole('tab', { name: /^Outputs/ })).toHaveTextContent('Outputs 2');
    });

    it('shows the unsaved bar on any edit, and Discard restores the saved draft', async () => {
      const { api } = setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await userEvent.click(await tab(/^General/));
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Name'), '!');
      const bar = screen.getByRole('region', { name: 'Unsaved changes' });
      expect(bar).toHaveTextContent('Unsaved change to the name');
      expect(bar).toHaveTextContent('Saving marks the latest evaluation out of date.');
      await userEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
      expect(screen.getByLabelText('Name')).toHaveValue('Letter');
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
      expect(api.saveTemplate).not.toHaveBeenCalled();
    });

    it('saves from the bar with the base it started from and reports the save', async () => {
      const record = view({ ...validDefinition(), version: 1 });
      record.record.updatedAt = '2026-10-13T10:00:00.000Z';
      const onSaved = vi.fn();
      const { api } = setup(record, {}, { onChanged: vi.fn(), onSaved });
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      expect(api.saveTemplate).toHaveBeenCalledWith(
        'letter',
        1,
        expect.objectContaining({ name: 'Letter!' }),
        '2026-10-13T10:00:00.000Z',
      );
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    });

    it('offers a reload when the draft changed elsewhere', async () => {
      const definition = { ...validDefinition(), version: 1 };
      const getTemplate = vi
        .fn()
        .mockResolvedValueOnce(view(definition))
        .mockResolvedValue(view({ ...definition, name: 'Changed elsewhere' }));
      setup(
        view(definition),
        {
          getTemplate,
          saveTemplate: vi.fn(async () => {
            throw new ApiError('the draft changed since you opened it; reload it to see the changes', 409);
          }),
        },
        { onChanged: vi.fn() },
      );
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('the draft changed since you opened it');
      await userEvent.click(screen.getByRole('button', { name: 'Reload the draft' }));
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Changed elsewhere'));
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    });

    it('tries the saved draft on one prepared dev sample', async () => {
      const onSaved = vi.fn();
      const { api } = setup(
        view({ ...validDefinition(), version: 1 }),
        {
          listSamples: vi.fn(async () => [
            sampleView({ id: 's1', filename: 'inv-0001.pdf' }),
            sampleView({ id: 's2', filename: 'inv-0012-initech.pdf' }),
            sampleView({ id: 'h1', filename: 'holdout.pdf', role: 'holdout' }),
            sampleView({ id: 'p1', filename: 'preparing.pdf', state: 'preparing' }),
          ]),
        },
        { onChanged: vi.fn(), onSaved, dataPolicy: 'local' },
      );
      const pick = await screen.findByRole('combobox', { name: 'Try on' });
      await waitFor(() =>
        expect([...(pick as HTMLSelectElement).options].map((o) => o.text)).toEqual([
          'inv-0001.pdf',
          'inv-0012-initech.pdf',
        ]),
      );
      await userEvent.selectOptions(pick, 's2');
      await userEvent.click(screen.getByRole('button', { name: 'Test run' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Run test' }));
      expect(api.runDevTests).toHaveBeenCalledWith('letter', { model: null, sampleIds: ['s2'] });
      expect(await screen.findByText('Test run queued on inv-0012-initech.pdf.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'See Test runs' })).toHaveAttribute(
        'href',
        '#/workbench/letter/runs',
      );
      expect(onSaved).toHaveBeenCalled();
    });

    it('disables Test run with a reason while edits are unsaved or no dev sample is prepared', async () => {
      setup(
        view({ ...validDefinition(), version: 1 }),
        { listSamples: vi.fn(async () => [sampleView({ state: 'failed', error: 'password' })]) },
        { onChanged: vi.fn() },
      );
      const run = await screen.findByRole('button', { name: 'Test run' });
      await waitFor(() =>
        expect(run).toHaveAttribute(
          'title',
          'No prepared dev samples: add or prepare some on the Samples tab',
        ),
      );
      expect(run).toBeDisabled();
      cleanup();
      setup(
        view({ ...validDefinition(), version: 1 }),
        { listSamples: vi.fn(async () => [sampleView()]) },
        { onChanged: vi.fn() },
      );
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      const blocked = screen.getByRole('button', { name: 'Test run' });
      expect(blocked).toBeDisabled();
      expect(blocked).toHaveAttribute('title', 'Save the draft first: a test run uses the saved draft');
    });

    it('ends each part with a link to the stage that drafts it', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      expect(await screen.findByRole('link', { name: 'Ask the model in Steps' })).toHaveAttribute(
        'href',
        '#/workbench/letter/steps',
      );
      await userEvent.click(await tab(/^Outputs/));
      expect(screen.getByRole('link', { name: 'Ask the model in Outputs' })).toHaveAttribute(
        'href',
        '#/workbench/letter/outputs',
      );
      await userEvent.click(await tab(/^Sections/));
      expect(screen.getByRole('link', { name: 'Ask the model in Sections' })).toBeInTheDocument();
      await userEvent.click(await tab(/^General/));
      expect(screen.getByRole('link', { name: /Revise/ })).toHaveAttribute('href', '#/workbench/letter/revise');
    });
```

   (Add `cleanup` to the `@testing-library/react` import.)

5. Add to `describe('TemplateEditor', …)` (standalone):

```ts
  it('saves with the base it started from on the Templates page too', async () => {
    const record = view({ ...validDefinition(), version: 1 });
    record.record.updatedAt = '2026-10-13T10:00:00.000Z';
    const { api } = setup(record);
    await userEvent.type(await screen.findByLabelText('Name'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![3]).toBe('2026-10-13T10:00:00.000Z');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/TemplateEditor.test.tsx` → FAIL (no H2, Publish still shown, no unsaved bar, no *Try on*).

- [ ] **Step 3: Implement**

Create `apps/web/src/templates/UnsavedBar.tsx`:

```tsx
/** The Template tab's sticky unsaved bar (handoff §10, 10b): what changed, Discard, Save. */
export function UnsavedBar({
  text,
  version,
  onDiscard,
  onSave,
}: {
  text: string;
  version: number;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="unsaved-bar" role="region" aria-label="Unsaved changes">
      <span className="unsaved-dot" aria-hidden="true" />
      <strong>{text}</strong>
      <span className="muted">Saving marks the latest evaluation out of date.</span>
      <span className="unsaved-actions">
        <button type="button" onClick={onDiscard}>
          Discard
        </button>
        <button type="button" className="primary" onClick={onSave}>
          Save draft v{version}
        </button>
      </span>
    </div>
  );
}
```

Create `apps/web/src/templates/TryOn.tsx`:

```tsx
import { useEffect, useId, useState } from 'react';
import type { DataPolicy } from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { runSamples, type SampleChoice } from '../workbench/runs.js';
import { tryOnBlockedReason } from './editor-derive.js';

/**
 * *Try on [dev sample] → Test run* (handoff §10, TR1): runs the saved draft on one prepared dev
 * sample as a test run; it shows on the Test runs tab. Never holdout.
 */
export function TryOn({
  api,
  projectId,
  version,
  dirty,
  dataPolicy,
  onQueued,
}: {
  api: Api;
  projectId: string;
  version: number;
  dirty: boolean;
  dataPolicy: DataPolicy;
  onQueued: () => void;
}) {
  const [samples, setSamples] = useState<SampleChoice[] | null>(null);
  const [picked, setPicked] = useState('');
  const [asking, setAsking] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const choices = useModelChoices(api);
  const selectId = useId();

  useEffect(() => {
    let live = true;
    api.listSamples(projectId).then(
      (all) => {
        if (live) setSamples(runSamples(all).filter((c) => c.selectable));
      },
      () => {
        if (live) setSamples([]);
      },
    );
    return () => {
      live = false;
    };
  }, [api, projectId]);

  const ready = samples ?? [];
  const current = ready.find((c) => c.sample.id === picked) ?? ready[0] ?? null;
  const blocked = tryOnBlockedReason(dirty, samples === null ? null : ready.length);
  return (
    <div className="try-on">
      {/* A separate label: a select inside its label would add the picked file to its name. */}
      <label htmlFor={selectId}>Try on</label>
      <select
          id={selectId}
          className="mono"
          value={current?.sample.id ?? ''}
          disabled={ready.length === 0}
          onChange={(e) => setPicked(e.target.value)}
        >
          {ready.map((c) => (
            <option key={c.sample.id} value={c.sample.id}>
              {c.sample.filename}
            </option>
          ))}
      </select>
      <button
        type="button"
        disabled={blocked !== null}
        title={blocked ?? undefined}
        onClick={() => setAsking(true)}
      >
        Test run
      </button>
      {asking && current && (
        <ReprocessDialog
          title={`Test v${version} on ${current.sample.filename}`}
          confirmLabel="Run test"
          choices={choices}
          emptyLabel="Document type's model"
          dataPolicy={dataPolicy}
          summary={
            <p>
              Runs the saved draft on {current.sample.filename}: reviewable, never published or
              scored. It shows on the Test runs tab.
            </p>
          }
          onConfirm={async (model) => {
            await api.runDevTests(projectId, { model, sampleIds: [current.sample.id] });
            setQueued(current.sample.filename);
            onQueued();
          }}
          onClose={() => setAsking(false)}
        />
      )}
      {queued && (
        <p role="status" className="muted">
          Test run queued on {queued}.{' '}
          <a href={`#/workbench/${projectId}/runs`}>See Test runs</a>
        </p>
      )}
    </div>
  );
}
```

(`SampleChoice` is exported by `workbench/runs.ts` (PR 7); if it is not, export its interface there.)

Create `apps/web/src/templates/EmbeddedHeader.tsx`:

```tsx
import type { DataPolicy } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { TabHeader } from '../workbench/TabHeader.js';
import { DraftMenu } from './DraftMenu.js';
import { TryOn } from './TryOn.js';

export const EMBEDDED_NOTE =
  'Edit the draft by hand. Model proposals and your edits change the same draft, so everything here is what the next run uses. Saving marks the latest evaluation as out of date.';

/**
 * The Template tab's header (handoff §10): no back link, name or Publish (the project header
 * owns them); *Try on → Test run*, Export YAML and *More → Delete draft*.
 */
export function EmbeddedHeader({
  api,
  templateId,
  version,
  status,
  dirty,
  dataPolicy,
  exportUrl,
  onQueued,
  onNewDraft,
  onDeleteDraft,
}: {
  api: Api;
  templateId: string;
  version: number;
  status: 'draft' | 'published';
  dirty: boolean;
  dataPolicy: DataPolicy;
  exportUrl: string;
  onQueued: () => void;
  onNewDraft: () => void;
  onDeleteDraft: () => void;
}) {
  const draft = status === 'draft';
  return (
    <TabHeader
      title={draft ? `Template · draft v${version}` : `Template · v${version}`}
      item={null}
      description={EMBEDDED_NOTE}
      actions={
        <>
          {draft && (
            <TryOn
              api={api}
              projectId={templateId}
              version={version}
              dirty={dirty}
              dataPolicy={dataPolicy}
              onQueued={onQueued}
            />
          )}
          <a
            className="button icon bordered"
            href={exportUrl}
            aria-label="Export YAML"
            title="Export YAML"
          >
            <Icon name="download" />
          </a>
          {draft ? (
            <DraftMenu version={version} onDelete={onDeleteDraft} />
          ) : (
            <button type="button" className="primary" onClick={onNewDraft}>
              New draft from v{version}
            </button>
          )}
        </>
      }
    />
  );
}
```

In `apps/web/src/templates/TemplateEditor.tsx`:

1. Imports — make the top of the file:

```tsx
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import {
  describeDefinitionChange,
  pickedChoice,
  VALUE_TYPES,
  type DataPolicy,
  type JobSummary,
  type OverviewItem,
} from '@ih/shared';
import { ApiError, type Api, type TemplateRecordView } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { YamlEditor } from '../ui/YamlEditor.js';
import { TabHeader } from '../workbench/TabHeader.js';
import { EditorHeader } from './EditorHeader.js';
import { EmbeddedHeader } from './EmbeddedHeader.js';
import { tabCounts, unsavedText } from './editor-derive.js';
import { Area, opt, Select, Text } from './fields.js';
import { StepCard } from './StepCard.js';
import { CheckStep, defaultLabel, ExtractStep } from './StepForms.js';
import { TestRail } from './TestRail.js';
import { QualityPanel } from './QualityPanel.js';
import { UnsavedBar } from './UnsavedBar.js';
import {
  checkPathOptions,
  getIn,
  moveItem,
  removeAt,
  setIn,
  validateDefinition,
  type Definition,
} from './model.js';
import { ModelPicker, useModelChoices } from '../ui/ModelPicker.js';
```

2. Replace the `Tab` type and `TABS` with:

```tsx
type Tab = 'general' | 'sections' | 'outputs' | 'pipeline' | 'yaml' | 'quality';

/** The Templates page's order (UI handoff §5). */
const STANDALONE_TABS: [Tab, string][] = [
  ['general', 'General'],
  ['sections', 'Sections'],
  ['pipeline', 'Pipeline'],
  ['outputs', 'Outputs'],
  ['yaml', 'YAML'],
  ['quality', 'Quality'],
];

/** The Template tab's order (handoff §10): Evaluate replaces Quality. */
const EMBEDDED_TABS: [Tab, string][] = [
  ['general', 'General'],
  ['sections', 'Sections'],
  ['outputs', 'Outputs'],
  ['pipeline', 'Pipeline'],
  ['yaml', 'YAML'],
];

/** Set when hosted by the Workbench's Template tab (handoff §10). */
export interface EmbeddedEditor {
  /** The draft was deleted or a new one started: reload the project. */
  onChanged: () => void;
  /** Saved, or a test run queued: stage states may have moved (reload the page overview). */
  onSaved?: () => void;
  /** The project's data policy, for the Try on model picker (default: local). */
  dataPolicy?: DataPolicy;
  /** The page overview's items (null while unknown): stale stages for Checks. */
  stages?: readonly OverviewItem[] | null;
  /** The latest published version: "Changes since vN" and Full diff. */
  published?: number | null;
}
```

3. Props: change the `embedded` doc and type to

```tsx
  /**
   * Set when hosted by the Workbench's Template tab: the tab header (Try on, Export, More)
   * replaces the editor header (no Publish: Evaluate's gate card publishes), the sub-tabs drop
   * Quality, edits show the unsaved bar, and new draft / delete draft report back instead of
   * navigating to Document types.
   */
  embedded?: EmbeddedEditor;
```

4. State: change `const [tab, setTab] = useState<Tab>('general');` to `useState<Tab>(embedded ? 'pipeline' : 'general')`, and add after `publishedVersion`:

```tsx
  /** A save refused with 409 (written elsewhere meanwhile, or published): offer a reload. */
  const [conflict, setConflict] = useState(false);
  const savedDef = useMemo<Definition>(
    () => (saved ? (JSON.parse(saved) as Definition) : {}),
    [saved],
  );
```

5. Early returns: replace the two lines `if (error && !view) …` / `if (!view) …` with:

```tsx
  if (!view) {
    const body = error ? <p role="alert">{error}</p> : <p>Loading…</p>;
    return embedded ? (
      <section className="template-editor template-embedded">
        <TabHeader title={`Template · draft v${version}`} item={null} />
        {body}
      </section>
    ) : (
      body
    );
  }
```

6. Replace `save` and `publish` with:

```tsx
  const save = async () => {
    setError(null);
    setConflict(false);
    try {
      accept(await api.saveTemplate(templateId, version, def, record.updatedAt || undefined));
      setMessage('Draft saved.');
      embedded?.onSaved?.();
    } catch (err) {
      setError((err as Error).message);
      setConflict(err instanceof ApiError && err.status === 409);
    }
  };
  const reload = () =>
    act(async () => {
      accept(await api.getTemplate(templateId, version));
      setConflict(false);
      setMessage('Reloaded the saved draft.');
    });
  const discard = () => {
    setDef(savedDef);
    if (tab === 'yaml') setYamlText(toYaml(savedDef, { lineWidth: 100 }));
    setMessage(null);
  };
  /** The Templates page only: the Workbench publishes from Evaluate's gate card. */
  const publish = () =>
    act(async () => {
      accept(await api.publishTemplate(templateId, version));
      setMessage(`Published v${version}.`);
    });
```

7. After `const counts = tabCounts(def);` replace `tabCount` and add:

```tsx
  const tabs = embedded ? EMBEDDED_TABS : STANDALONE_TABS;
  const tabCount = (t: Tab): string | null =>
    t === 'sections'
      ? String(counts.sections)
      : t === 'outputs'
        ? embedded
          ? String(counts.fields + counts.tables)
          : `${counts.fields} · ${counts.tables}`
        : t === 'pipeline'
          ? String(counts.steps)
          : null;
  /** The Template tab ends each part with the stage that drafts it (handoff §10). */
  const stageLink = (stage: string, text: string) =>
    embedded ? (
      <p className="muted subtab-foot">
        <a href={`#/workbench/${templateId}/${stage}`}>{text}</a>
      </p>
    ) : null;
```

8. In the JSX:
   - Root: `<section className={embedded ? 'template-editor template-embedded' : 'template-editor'}>`.
   - Replace `<EditorHeader … />` with:

```tsx
      {embedded ? (
        <EmbeddedHeader
          api={api}
          templateId={templateId}
          version={version}
          status={record.status}
          dirty={dirty}
          dataPolicy={embedded.dataPolicy ?? 'local'}
          exportUrl={api.exportUrl(templateId, version)}
          onQueued={() => embedded.onSaved?.()}
          onNewDraft={() => void newDraft()}
          onDeleteDraft={() => void removeDraft()}
        />
      ) : (
        <EditorHeader
          name={String(def.name ?? templateId)}
          id={templateId}
          version={version}
          status={record.status}
          publishedVersion={publishedVersion}
          dirty={dirty}
          issues={issues.length}
          exportUrl={api.exportUrl(templateId, version)}
          onSave={() => void save()}
          onPublish={() => void publish()}
          onNewDraft={() => void newDraft()}
          onDeleteDraft={() => void removeDraft()}
        />
      )}
```

   - Replace `{error && <p role="alert">{error}</p>}` with:

```tsx
      {error && (
        <p role="alert">
          {error}
          {conflict && (
            <>
              {' '}
              <button type="button" onClick={() => void reload()}>
                Reload the draft
              </button>
            </>
          )}
        </p>
      )}
```

   - Guard the validation list: `{!embedded && issues.length > 0 && (…)}` (the Checks panel shows them in Task 10).
   - In the tablist, map `tabs` instead of `TABS`.
   - `{tab === 'quality' && !embedded && (<QualityPanel … />)}`.
   - Inside the fieldset: after the General `form-rows` div add `{stageLink('revise', 'Revise proposes a new preamble from your feedback')}`; after the Sections `RowTable` add `{stageLink('sections', 'Ask the model in Sections')}`; after the Outputs fragment's sub-tab content add `{stageLink('outputs', 'Ask the model in Outputs')}` (wrap the General and Sections branches in `<>…</>`).
   - After the pipeline block, still inside `.editor-main`: `{tab === 'pipeline' && stageLink('steps', 'Ask the model in Steps')}`.
   - After the closing `</div>` of `.editor-layout`, before `</section>`:

```tsx
      {embedded && editable && dirty && (
        <UnsavedBar
          text={unsavedText(describeDefinitionChange(savedDef, def).subjects)}
          version={version}
          onDiscard={discard}
          onSave={() => void save()}
        />
      )}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/TemplateEditor.test.tsx` → PASS (standalone tests unchanged: header, Publish, tab order with Quality, TestRail).
Run: `npm run typecheck -w @ih/web && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/EmbeddedHeader.tsx apps/web/src/templates/TryOn.tsx apps/web/src/templates/UnsavedBar.tsx apps/web/src/templates/TemplateEditor.tsx apps/web/test/TemplateEditor.test.tsx
git commit -m "Workbench web: Template tab header, Try on, sub-tabs and the unsaved bar (handoff 10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Embedded Pipeline — step list and step form

**Files:**
- Create: `apps/web/src/templates/PipelineEditor.tsx`
- Modify: `apps/web/src/templates/TemplateEditor.tsx`
- Test: `apps/web/test/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `stepListSummary` (Task 7), `Text`/`Area`/`opt`/`optInt`/`intList` (with `placeholder`), `CheckStep`, `ContextEditor` (Task 6), `StepFigures` (Task 6), `outputCoverage`, `sectionTone`, `TONE_COLOR`, `ModelPicker`.
- Produces: `PipelineEditor({ pipeline, selected, onSelect, onChange, readOnly, definition, models, typeModelLabel, paths, metrics })` with `metrics: ReadonlyMap<string, StepMetric>`; the open step is `role="region"` named `Step N`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/TemplateEditor.test.tsx`:

```ts
describe('TemplateEditor embedded Pipeline (handoff §10)', () => {
  const invoice = () => ({
    id: 'letter',
    version: 1,
    name: 'Invoice',
    document: {
      sections: ['header', 'supplier', 'line_items', 'totals', 'payment'].map((id) => ({ id, anchor: `^${id}` })),
    },
    outputs: {
      fields: ['supplier_name', 'due_date', 'subtotal', 'total'].map((id) => ({ id, type: 'text' })),
      tables: [{ id: 'line_items', columns: [{ id: 'amount', type: 'number' }] }],
    },
    pipeline: [
      { type: 'extract', id: 'header', fields: ['supplier_name'], sections: ['header', 'supplier'] },
      { type: 'extract', id: 'line_items', table: 'line_items', sections: ['line_items'] },
      { type: 'extract', id: 'totals', fields: ['subtotal', 'total'], sections: ['totals', 'payment'] },
    ],
  });
  const open = (overrides = {}) => setup(view(invoice()), overrides, { onChanged: vi.fn() });
  const savedPipeline = (api: ReturnType<typeof open>['api']) =>
    (vi.mocked(api.saveTemplate).mock.calls.at(-1)![2] as { pipeline: Record<string, unknown>[] }).pipeline;

  it('lists the steps as pressable rows and opens the first', async () => {
    open();
    const first = await screen.findByRole('button', { name: /^1 header Fills 1 · reads header, supplier/ });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Step 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^3 totals/ }));
    expect(screen.getByRole('button', { name: /^3 totals/ })).toHaveAttribute('aria-pressed', 'true');
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('region', { name: 'Step 3' })).toBeInTheDocument();
  });

  it('toggles the sections a step reads', async () => {
    const { api } = open();
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    const payment = within(step).getByRole('checkbox', { name: 'payment' });
    expect(payment).toBeChecked();
    await userEvent.click(payment);
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    expect(savedPipeline(api)[2]!.sections).toEqual(['totals']);
  });

  it('removes a filled output and offers unfilled outputs first', async () => {
    const { api } = open();
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    await userEvent.click(within(step).getByRole('button', { name: 'Stop filling total' }));
    const add = within(step).getByRole('combobox', { name: 'Add output' });
    const groups = [...add.querySelectorAll('optgroup')].map((g) => [
      g.label,
      [...g.querySelectorAll('option')].map((o) => o.value),
    ]);
    expect(groups).toEqual([
      ['Not filled by any step', ['due_date', 'total']],
      ['Filled by another step', ['supplier_name']],
    ]);
    await userEvent.selectOptions(add, 'due_date');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    expect(savedPipeline(api)[2]!.fields).toEqual(['subtotal', 'due_date']);
  });

  it('a table step fills one table: Add output says why it is disabled', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: /^2 line_items/ }));
    const add = within(screen.getByRole('region', { name: 'Step 2' })).getByRole('combobox', {
      name: 'Add output',
    });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'A table step fills one table: remove it to fill fields instead');
    expect(
      within(screen.getByRole('region', { name: 'Step 2' })).getByLabelText('Pages per call'),
    ).toHaveAttribute('placeholder', 'all');
  });

  it('adds a step, opens it, and lets it fill a table', async () => {
    const { api } = open();
    await userEvent.click(await screen.findByRole('button', { name: 'Add extract step' }));
    const step = screen.getByRole('region', { name: 'Step 4' });
    await userEvent.type(within(step).getByLabelText('Step id'), 'rows');
    await userEvent.selectOptions(within(step).getByRole('combobox', { name: 'Add output' }), 'line_items');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    expect(savedPipeline(api)[3]).toMatchObject({ id: 'rows', table: 'line_items', fields: [] });
  });

  it('shows the last runs and explains a step that keeps retrying', async () => {
    open({
      getMetrics: vi.fn(async () => ({
        templateId: 'letter',
        versions: [],
        topEdited: [],
        steps: [{ stepId: 'totals', runs: 18, reruns: 0, failures: 0, avgAttempts: 2, avgOutputTokens: null, avgSeconds: 5 }],
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    expect(await within(step).findByText(/2\.0 attempts on average/)).toHaveTextContent('add instructions below');
    expect(within(step).getByText('18')).toBeInTheDocument();
  });

  it('says why the first step cannot move up', async () => {
    open();
    const up = await screen.findByRole('button', { name: 'Move step 1 up' });
    expect(up).toBeDisabled();
    expect(up).toHaveAttribute('title', 'Already the first step');
    await userEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(screen.getByRole('button', { name: /^2 header/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/TemplateEditor.test.tsx -t "embedded Pipeline"` → FAIL (the embedded Pipeline still shows collapsed `StepCard`s).

- [ ] **Step 3: Implement**

Create `apps/web/src/templates/PipelineEditor.tsx`:

```tsx
import { outputCoverage, type ModelChoice, type OutputCoverage } from '@ih/shared';
import { Icon } from '../ui/Icon.js';
import { ModelPicker } from '../ui/ModelPicker.js';
import { sectionTone, TONE_COLOR } from '../ui/stageStyle.js';
import { StepFigures } from '../workbench/StepsView.js';
import type { StepMetric } from '../workbench/steps.js';
import { stepListSummary } from './editor-derive.js';
import { Area, intList, opt, optInt, Text } from './fields.js';
import { CheckStep, ContextEditor } from './StepForms.js';
import { moveItem, removeAt, setIn, type Definition } from './model.js';

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? ids(v.map((x) => (x as { id?: unknown })?.id)) : [];

/**
 * The Template tab's Pipeline (handoff §10): the steps as a list (number, id, what it fills and
 * reads) and the selected step's form. The Templates page keeps its collapsible step cards.
 */
export function PipelineEditor({
  pipeline,
  selected,
  onSelect,
  onChange,
  readOnly,
  definition,
  models,
  typeModelLabel,
  paths,
  metrics,
}: {
  pipeline: Definition[];
  /** Index of the open step; -1 when there are none. */
  selected: number;
  onSelect: (index: number) => void;
  onChange: (pipeline: Definition[]) => void;
  readOnly: boolean;
  /** The whole draft: its sections, outputs and which step fills what. */
  definition: Definition;
  models: readonly ModelChoice[];
  /** The Model picker's empty option: what a step naming no model runs. */
  typeModelLabel: string;
  /** Values a check step can compare. */
  paths: string[];
  /** Figures from the type's runs, by step id. */
  metrics: ReadonlyMap<string, StepMetric>;
}) {
  const add = (step: Definition) => {
    onChange([...pipeline, step]);
    onSelect(pipeline.length);
  };
  const current = selected >= 0 ? pipeline[selected] : undefined;
  return (
    <div className="pipeline-editor">
      <div className="step-list-col">
        <ol className="step-list" aria-label="Pipeline steps">
          {pipeline.map((step, i) => (
            <li key={i}>
              <button
                type="button"
                className="step-list-item"
                aria-pressed={i === selected}
                onClick={() => onSelect(i)}
              >
                <span className="step-num">{i + 1}</span>{' '}
                <span className="mono step-id">
                  {typeof step.id === 'string' && step.id ? step.id : '(no id)'}
                </span>{' '}
                <small className="muted">{stepListSummary(step)}</small>
              </button>
            </li>
          ))}
        </ol>
        <fieldset className="step-list-add" disabled={readOnly}>
          <button
            type="button"
            className="add"
            onClick={() => add({ type: 'extract', id: '', fields: [], sections: [] })}
          >
            Add extract step
          </button>
          <button
            type="button"
            className="add"
            onClick={() => add({ type: 'check', id: '', values: '', reference: '' })}
          >
            Add check step
          </button>
        </fieldset>
      </div>
      {current ? (
        <StepDetail
          // A fresh form per step: the Context editor keeps its own text.
          key={selected}
          index={selected}
          count={pipeline.length}
          step={current}
          readOnly={readOnly}
          sections={idsOf((definition.document as Definition | undefined)?.sections)}
          fields={idsOf((definition.outputs as Definition | undefined)?.fields)}
          tables={idsOf((definition.outputs as Definition | undefined)?.tables)}
          coverage={outputCoverage(definition)}
          models={models}
          typeModelLabel={typeModelLabel}
          paths={paths}
          metric={typeof current.id === 'string' ? metrics.get(current.id) : undefined}
          onSet={(key, value) => onChange(setIn(pipeline, [selected, key], value))}
          onReplace={(step) => onChange(setIn(pipeline, [selected], step))}
          onMove={(delta) => {
            onChange(moveItem(pipeline, selected, delta));
            onSelect(selected + delta);
          }}
          onRemove={() => {
            onChange(removeAt(pipeline, selected));
            onSelect(Math.min(selected, pipeline.length - 2));
          }}
        />
      ) : (
        <p className="muted">No steps yet: add one, or ask the model in Steps.</p>
      )}
    </div>
  );
}

function StepDetail({
  index,
  count,
  step,
  readOnly,
  sections,
  fields,
  tables,
  coverage,
  models,
  typeModelLabel,
  paths,
  metric,
  onSet,
  onReplace,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  step: Definition;
  readOnly: boolean;
  sections: string[];
  fields: string[];
  tables: string[];
  coverage: OutputCoverage;
  models: readonly ModelChoice[];
  typeModelLabel: string;
  paths: string[];
  metric: StepMetric | undefined;
  onSet: (key: string, value: unknown) => void;
  onReplace: (step: Definition) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const kind = step.type === 'check' ? 'CHECK' : 'EXTRACT';
  return (
    <section className="card step-detail" aria-label={`Step ${n}`}>
      <div className="step-detail-head">
        <span className={`kind-tag ${kind === 'CHECK' ? 'tone-neutral' : 'tone-info'}`}>
          {kind}
        </span>
        <h3 className="mono">{typeof step.id === 'string' && step.id ? step.id : '(no id)'}</h3>
        <fieldset className="step-tools" disabled={readOnly}>
          <button
            type="button"
            className="icon bordered"
            aria-label={`Move step ${n} up`}
            disabled={index === 0}
            title={index === 0 ? 'Already the first step' : undefined}
            onClick={() => onMove(-1)}
          >
            <Icon name="chevronUp" />
          </button>
          <button
            type="button"
            className="icon bordered"
            aria-label={`Move step ${n} down`}
            disabled={index === count - 1}
            title={index === count - 1 ? 'Already the last step' : undefined}
            onClick={() => onMove(1)}
          >
            <Icon name="chevronDown" />
          </button>
          <button
            type="button"
            className="icon bordered danger"
            aria-label={`Remove step ${n}`}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </fieldset>
      </div>
      <fieldset className="step-body" disabled={readOnly}>
        {step.type === 'check' ? (
          <CheckStep step={step} paths={paths} set={onSet} />
        ) : (
          <ExtractDetail
            step={step}
            sections={sections}
            fields={fields}
            tables={tables}
            coverage={coverage}
            models={models}
            typeModelLabel={typeModelLabel}
            set={onSet}
            replace={onReplace}
          />
        )}
      </fieldset>
      {step.type !== 'check' && (
        <div className="step-detail-figures">
          <span className="muted">Last runs</span>
          <StepFigures metric={metric} here />
        </div>
      )}
    </section>
  );
}

function ExtractDetail({
  step,
  sections,
  fields,
  tables,
  coverage,
  models,
  typeModelLabel,
  set,
  replace,
}: {
  step: Definition;
  sections: string[];
  fields: string[];
  tables: string[];
  coverage: OutputCoverage;
  models: readonly ModelChoice[];
  typeModelLabel: string;
  set: (key: string, value: unknown) => void;
  replace: (step: Definition) => void;
}) {
  const isTable = typeof step.table === 'string';
  const filled = isTable ? [step.table as string] : ids(step.fields);
  const reads = ids(step.sections);
  const filledBy = (id: string) => coverage.outputs.find((o) => o.id === id)?.steps ?? [];
  const candidates = isTable ? [] : fields.filter((f) => !filled.includes(f));
  const unfilled = candidates.filter((f) => filledBy(f).length === 0);
  const elsewhere = candidates.filter((f) => filledBy(f).length > 0);
  const tableChoices = !isTable && filled.length === 0 ? tables : [];
  const addBlocked = isTable
    ? 'A table step fills one table: remove it to fill fields instead'
    : candidates.length + tableChoices.length === 0
      ? 'This step already fills every output'
      : null;
  const addOutput = (id: string) => {
    if (tableChoices.includes(id)) replace({ ...step, fields: [], table: id });
    else set('fields', [...filled, id]);
  };
  const removeOutput = (id: string) => {
    if (!isTable) return set('fields', filled.filter((f) => f !== id));
    const rest = { ...step };
    delete rest.table;
    delete rest.chunkPages;
    replace({ ...rest, fields: [] });
  };
  return (
    <div className="step-detail-body">
      <div className="grid step-settings">
        <Text label="Step id" value={step.id} onChange={(v) => set('id', v)} />
        <div className="field">
          <span className="field-label">Model</span>
          <ModelPicker
            label="Model"
            choices={models}
            // No model, or `default`: the default choice, whichever it is when the step runs.
            value={step.model === 'default' ? '' : (step.model ?? '')}
            emptyLabel={typeModelLabel}
            onChange={(id) => set('model', id || undefined)}
          />
        </div>
        {isTable && (
          <Text
            label="Pages per call"
            hint="Run once per N pages (large tables); empty: all pages in one call"
            placeholder="all"
            value={step.chunkPages === undefined ? '' : String(step.chunkPages)}
            onChange={(v) => set('chunkPages', optInt(v))}
          />
        )}
        <Text
          label="Max attempts"
          value={step.maxAttempts === undefined ? '' : String(step.maxAttempts)}
          onChange={(v) => set('maxAttempts', optInt(v))}
        />
      </div>
      <fieldset className="chip-toggles">
        <legend>Reads sections</legend>
        {sections.length === 0 && <small>No sections defined yet.</small>}
        {sections.map((id, i) => (
          <label key={id} className="toggle-chip">
            <input
              type="checkbox"
              checked={reads.includes(id)}
              onChange={(e) =>
                set('sections', e.target.checked ? [...reads, id] : reads.filter((s) => s !== id))
              }
            />
            <span
              className="section-dot"
              aria-hidden="true"
              style={{ background: TONE_COLOR[sectionTone(i)] }}
            />
            <code>{id}</code>
          </label>
        ))}
      </fieldset>
      <fieldset className="fill-chips">
        <legend>Fills outputs</legend>
        {filled.map((id) => (
          <span key={id} className="fill-chip">
            <code>{id}</code>
            <button
              type="button"
              className="icon"
              aria-label={`Stop filling ${id}`}
              onClick={() => removeOutput(id)}
            >
              ×
            </button>
          </span>
        ))}
        <select
          aria-label="Add output"
          value=""
          disabled={addBlocked !== null}
          title={addBlocked ?? undefined}
          onChange={(e) => {
            if (e.target.value) addOutput(e.target.value);
          }}
        >
          <option value="">+ Add output…</option>
          {unfilled.length > 0 && (
            <optgroup label="Not filled by any step">
              {unfilled.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
          {elsewhere.length > 0 && (
            <optgroup label="Filled by another step">
              {elsewhere.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
          {tableChoices.length > 0 && (
            <optgroup label="Tables">
              {tableChoices.map((t) => (
                <option key={t} value={t}>
                  {t} (table)
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </fieldset>
      <Area
        label="Instructions"
        hint="Added to the preamble for this step only."
        value={step.instructions}
        onChange={(v) => set('instructions', opt(v))}
      />
      <details className="step-more">
        <summary>More settings</summary>
        <div className="grid">
          <Text
            label="Page images"
            hint="1-based pages sent as images, e.g. 1"
            value={(step.pageImages ?? []).join(', ')}
            onChange={(v) => set('pageImages', intList(v).length ? intList(v) : undefined)}
          />
          <Text
            label="Max tokens"
            value={step.maxTokens === undefined ? '' : String(step.maxTokens)}
            onChange={(v) => set('maxTokens', optInt(v))}
          />
        </div>
        <ContextEditor
          value={step.context ?? {}}
          onChange={(context) => set('context', Object.keys(context).length ? context : undefined)}
        />
      </details>
    </div>
  );
}
```

(In the test "removes a filled output…", `total` is unfilled once removed, so the first group lists `['due_date', 'total']` in the fields' order; `supplier_name` is filled by step 1.)

In `apps/web/src/templates/TemplateEditor.tsx`:

1. Imports: `import { PipelineEditor } from './PipelineEditor.js';` and `import type { StepMetric } from '../workbench/steps.js';`.
2. State (before the early returns):

```tsx
  /** The open step on the Template tab's Pipeline (clamped to the list when rendered). */
  const [selectedStep, setSelectedStep] = useState(0);
  const [metrics, setMetrics] = useState<ReadonlyMap<string, StepMetric>>(new Map());
  // `embedded` is a new object on every render: depend on whether it is set.
  const isEmbedded = embedded !== undefined;
  useEffect(() => {
    if (!isEmbedded) return;
    let live = true;
    api.getMetrics(templateId).then(
      (m) => {
        if (live) setMetrics(new Map(m.steps.map((s) => [s.stepId, s])));
      },
      () => {}, // figures are optional: the form works without them
    );
    return () => {
      live = false;
    };
  }, [api, templateId, isEmbedded]);
```

3. Wrap the existing `{tab === 'pipeline' && (<div className="pipeline">…</div>)}` block so it renders for the Templates page only, and add the embedded editor:

```tsx
          {tab === 'pipeline' && embedded && (
            <PipelineEditor
              pipeline={pipeline}
              // -1 only when there are no steps (removing the last one leaves -1 behind).
              selected={
                pipeline.length === 0 ? -1 : Math.min(Math.max(selectedStep, 0), pipeline.length - 1)
              }
              onSelect={setSelectedStep}
              onChange={(next) => update(['pipeline'], next)}
              readOnly={!editable}
              definition={def}
              models={models}
              typeModelLabel={
                typeModel
                  ? `Document type's model (${modelName(typeModel)})`
                  : `Default choice${defaultLabel(models)}`
              }
              paths={paths}
              metrics={metrics}
            />
          )}
          {tab === 'pipeline' && !embedded && (
            <div className="pipeline">{/* … the existing StepCard list and Add buttons … */}</div>
          )}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/TemplateEditor.test.tsx` → PASS (the standalone "shows steps as collapsed cards…", "keeps the open step open when it moves…", "lets a published version open its steps read-only" are unchanged).
Run: `npm run typecheck -w @ih/web && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/PipelineEditor.tsx apps/web/src/templates/TemplateEditor.tsx apps/web/test/TemplateEditor.test.tsx
git commit -m "Workbench web: Template tab Pipeline with a step list, section chips and output chips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Checks and *Changes since vN* panels, warn dots

**Files:**
- Create: `apps/web/src/templates/ChecksPanel.tsx`, `apps/web/src/templates/DraftChangesPanel.tsx`, `apps/web/test/TemplateSide.test.tsx`
- Modify: `apps/web/src/templates/TemplateEditor.tsx`
- Test: `apps/web/test/TemplateSide.test.tsx`, `apps/web/test/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `templateChecks`, `attentionTabs`, `issueText`, `SubTab` (Task 7), `changeTag`, `changeAtText` (Task 7), `api.listDraftChanges`, `api.diffVersions`.
- Produces: `ChecksPanel({ checks, onOpenSubTab })`; `DraftChangesPanel({ api, projectId, version, published, refreshKey })` (reloads when `refreshKey` changes; the editor bumps it after each save).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/TemplateSide.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateChange } from '@ih/shared';
import { ChecksPanel } from '../src/templates/ChecksPanel.js';
import { DraftChangesPanel } from '../src/templates/DraftChangesPanel.js';
import { fakeApi } from './fake-api.js';

const change = (overrides: Partial<TemplateChange> = {}): TemplateChange => ({
  id: '1',
  version: 4,
  at: '2026-10-12T08:40:00.000Z',
  source: 'hand',
  stage: null,
  proposalId: null,
  summary: 'Changed section supplier',
  diff: ['^(From|Supplier)\\b → ^(From|Supplier|Vendor)\\b'],
  by: 'Ken',
  ...overrides,
});

describe('ChecksPanel', () => {
  it('lists checks with a tone word and the link that fixes each', async () => {
    const onOpenSubTab = vi.fn();
    render(
      <ChecksPanel
        checks={[
          {
            tone: 'warn',
            text: 'due_date is not filled by any step.',
            link: { label: 'Add it to a step in Steps', hash: '#/workbench/invoice/steps' },
            subTabs: ['outputs', 'pipeline'],
          },
          {
            tone: 'danger',
            text: 'pipeline: Array must contain at least 1 element(s)',
            link: { label: 'Open Pipeline', subTab: 'pipeline' },
            subTabs: ['pipeline'],
          },
        ]}
        onOpenSubTab={onOpenSubTab}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Checks' });
    const items = within(panel).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Needs you: due_date is not filled by any step.');
    expect(within(items[0]!).getByRole('link', { name: 'Add it to a step in Steps' })).toHaveAttribute(
      'href',
      '#/workbench/invoice/steps',
    );
    expect(items[1]).toHaveTextContent('Error:');
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Open Pipeline' }));
    expect(onOpenSubTab).toHaveBeenCalledWith('pipeline');
    expect(panel).toHaveAttribute('data-tone', 'warn');
  });

  it('has an ok border when every check passes', () => {
    render(
      <ChecksPanel
        checks={[{ tone: 'ok', text: 'Sections, outputs and steps are valid.', link: null, subTabs: [] }]}
        onOpenSubTab={vi.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: 'Checks' })).toHaveAttribute('data-tone', 'ok');
  });
});

describe('DraftChangesPanel', () => {
  it('lists the changes since the live version, newest first, with tags and chips', async () => {
    const api = fakeApi({
      listDraftChanges: vi.fn(async () => [
        change(),
        change({ id: '0', source: 'proposal', stage: 'outputs', summary: 'Added field due_date', diff: ['+ due_date'] }),
      ]),
    });
    render(<DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />);
    const panel = screen.getByRole('region', { name: 'Changes since v3' });
    const items = await within(panel).findAllByRole('listitem', { name: /./ });
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('BY HAND');
    expect(items[0]).toHaveTextContent('Changed section supplier');
    expect(items[0]).toHaveTextContent('^(From|Supplier)\\b → ^(From|Supplier|Vendor)\\b');
    expect(items[1]).toHaveTextContent('OUTPUTS PROPOSAL');
    expect(items[1]).toHaveTextContent('+ due_date');
    expect(within(items[0]!).getByText(/12 Oct/)).toHaveAttribute('dateTime', '2026-10-12T08:40:00.000Z');
  });

  it('opens the full diff from the live version', async () => {
    const api = fakeApi({
      diffVersions: vi.fn(async (_id: string, from: number, to: number) => ({
        from,
        to,
        changes: [{ kind: 'added' as const, path: 'outputs.fields[due_date]' }],
      })),
    });
    render(<DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />);
    const full = screen.getByRole('button', { name: 'Full diff' });
    expect(full).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(full);
    expect(api.diffVersions).toHaveBeenCalledWith('invoice', 3, 4);
    expect(await screen.findByRole('list', { name: 'Full diff from v3' })).toHaveTextContent(
      'added outputs.fields[due_date]',
    );
    expect(full).toHaveAttribute('aria-expanded', 'true');
  });

  it('names the draft when nothing is published, and says when nothing is recorded', async () => {
    render(
      <DraftChangesPanel api={fakeApi()} projectId="invoice" version={1} published={null} refreshKey={0} />,
    );
    const panel = screen.getByRole('region', { name: 'Changes in draft v1' });
    expect(await within(panel).findByText('No changes recorded for this draft yet.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Full diff' })).not.toBeInTheDocument();
  });

  it('keeps the newest response when an older one arrives late', async () => {
    let resolveFirst: (v: TemplateChange[]) => void = () => {};
    const listDraftChanges = vi
      .fn()
      .mockImplementationOnce(() => new Promise<TemplateChange[]>((r) => (resolveFirst = r)))
      .mockResolvedValue([change({ summary: 'Newest' })]);
    const api = fakeApi({ listDraftChanges });
    const { rerender } = render(
      <DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />,
    );
    rerender(<DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={1} />);
    expect(await screen.findByText('Newest')).toBeInTheDocument();
    resolveFirst([change({ summary: 'Old' })]);
    await waitFor(() => expect(screen.queryByText('Old')).not.toBeInTheDocument());
  });

  it('says when the changes cannot be read', async () => {
    const api = fakeApi({ listDraftChanges: vi.fn(async () => Promise.reject(new Error('offline'))) });
    render(<DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the changes: offline');
  });
});
```

Append inside `describe('embedded in the workbench', …)` in `apps/web/test/TemplateEditor.test.tsx`:

```ts
    it('marks the sub-tabs a check fails on and lists the checks, stale stages included', async () => {
      const definition = {
        ...validDefinition(),
        version: 1,
        outputs: { ...validDefinition().outputs, fields: [{ id: 'sender', type: 'text' }, { id: 'due_date', type: 'date' }] },
      };
      setup(view(definition), {}, {
        onChanged: vi.fn(),
        stages: [{ stage: 'sections', state: 'stale', status: 'Stale — Outputs changed after it was accepted', metrics: [] }],
      });
      const checks = await screen.findByRole('region', { name: 'Checks' });
      expect(within(checks).getByText(/due_date is not filled by any step\./)).toBeInTheDocument();
      expect(within(checks).getByRole('link', { name: 'Review in Sections' })).toHaveAttribute(
        'href',
        '#/workbench/letter/sections',
      );
      expect(screen.getByRole('tab', { name: /^Pipeline.*needs attention/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Outputs.*needs attention/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Sections/ })).not.toHaveAccessibleName(/needs attention/);
    });

    it('opens the sub-tab a validation issue names', async () => {
      setup(view({ ...skeleton }), {}, { onChanged: vi.fn() });
      await userEvent.click(await tab(/^General/));
      const checks = screen.getByRole('region', { name: 'Checks' });
      await userEvent.click(within(checks).getAllByRole('button', { name: 'Open Pipeline' })[0]!);
      expect(screen.getByRole('tab', { name: /^Pipeline/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('reloads the change log after a save', async () => {
      const { api } = setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await screen.findByRole('region', { name: 'Changes in draft v1' });
      await waitFor(() => expect(api.listDraftChanges).toHaveBeenCalledTimes(1));
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      await waitFor(() => expect(api.listDraftChanges).toHaveBeenCalledTimes(2));
    });
```

Add to `describe('TemplateEditor', …)` (standalone):

```ts
  it('has no Checks or Changes panels on the Templates page', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await screen.findByRole('heading', { level: 1, name: 'Letter' });
    expect(screen.queryByRole('region', { name: 'Checks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /needs attention/ })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/TemplateSide.test.tsx apps/web/test/TemplateEditor.test.tsx` → FAIL (modules missing; no Checks region).

- [ ] **Step 3: Implement**

Create `apps/web/src/templates/ChecksPanel.tsx`:

```tsx
import { useId } from 'react';
import type { SubTab, TemplateCheck } from './checks.js';

const TONE_WORD: Record<TemplateCheck['tone'], string> = {
  ok: 'OK',
  warn: 'Needs you',
  alert: 'Stale',
  danger: 'Error',
};

/** The Template tab's Checks (handoff §10): each item says what is wrong and links to the fix. */
export function ChecksPanel({
  checks,
  onOpenSubTab,
}: {
  checks: readonly TemplateCheck[];
  onOpenSubTab: (tab: SubTab) => void;
}) {
  const heading = useId();
  const ok = checks.every((c) => c.tone === 'ok');
  return (
    <section
      className="card checks-panel"
      aria-labelledby={heading}
      data-tone={ok ? 'ok' : 'warn'}
    >
      <h3 id={heading}>Checks</h3>
      <ul className="checks-list">
        {checks.map((c, i) => (
          <li key={i} data-tone={c.tone}>
            <span className="check-dot" aria-hidden="true" />
            <span>
              <span className="visually-hidden">{TONE_WORD[c.tone]}: </span>
              {c.text}{' '}
              {c.link &&
                ('hash' in c.link ? (
                  <a href={c.link.hash}>{c.link.label}</a>
                ) : (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpenSubTab((c.link as { subTab: SubTab }).subTab)}
                  >
                    {c.link.label}
                  </button>
                ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Create `apps/web/src/templates/DraftChangesPanel.tsx`:

```tsx
import { useEffect, useId, useRef, useState } from 'react';
import type { TemplateChange } from '@ih/shared';
import type { Api, VersionDiff } from '../api/client.js';
import { changeAtText, changeTag } from './editor-derive.js';

const TAG_TONE: Record<TemplateChange['source'], string> = {
  hand: 'tone-neutral',
  proposal: 'tone-info',
  restore: 'tone-warn',
  started: 'tone-neutral',
  import: 'tone-neutral',
};

/**
 * *Changes since vN* (handoff §10, TP1): the open draft's change log, newest first, and the
 * full diff from the live version. Reloads when `refreshKey` changes (after each save).
 */
export function DraftChangesPanel({
  api,
  projectId,
  version,
  published,
  refreshKey,
}: {
  api: Api;
  projectId: string;
  version: number;
  published: number | null;
  refreshKey: number;
}) {
  const heading = useId();
  const [changes, setChanges] = useState<TemplateChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  /** Numbers each load, so an older response never replaces a newer one. */
  const request = useRef(0);

  useEffect(() => {
    const n = ++request.current;
    api.listDraftChanges(projectId).then(
      (c) => {
        if (n !== request.current) return;
        setChanges(c);
        setError(null);
      },
      (err: Error) => {
        if (n === request.current) setError(err.message);
      },
    );
    return () => {
      request.current++;
    };
  }, [api, projectId, refreshKey]);

  const toggleDiff = () => {
    const open = !showDiff;
    setShowDiff(open);
    if (open && published !== null) {
      api.diffVersions(projectId, published, version).then(setDiff, (err: Error) =>
        setError(err.message),
      );
    }
  };

  const title = published !== null ? `Changes since v${published}` : `Changes in draft v${version}`;
  return (
    <section className="card changes-panel" aria-labelledby={heading}>
      <div className="changes-panel-head">
        <h3 id={heading}>{title}</h3>
        {published !== null && (
          <button type="button" className="link" aria-expanded={showDiff} onClick={toggleDiff}>
            Full diff
          </button>
        )}
      </div>
      {error && <p role="alert">Could not load the changes: {error}</p>}
      {showDiff && diff && (
        <ul className="full-diff" aria-label={`Full diff from v${diff.from}`}>
          {diff.changes.length === 0 && <li className="muted">No differences.</li>}
          {diff.changes.map((c, i) => (
            <li key={i}>
              <code>
                {c.kind} {c.path}
              </code>
            </li>
          ))}
        </ul>
      )}
      {changes !== null && changes.length === 0 && (
        <p className="muted">No changes recorded for this draft yet.</p>
      )}
      {changes !== null && changes.length > 0 && (
        <ul className="changes-list">
          {changes.map((c) => (
            <li key={c.id} aria-label={`${changeTag(c)}: ${c.summary}`}>
              <div className="change-meta">
                <span className={`kind-tag ${TAG_TONE[c.source]}`}>{changeTag(c)}</span>{' '}
                <time className="muted" dateTime={c.at}>
                  {changeAtText(c.at)}
                </time>
              </div>
              <p>{c.summary}</p>
              {c.diff.length > 0 && (
                <ul className="diff-chips">
                  {c.diff.map((d, i) => (
                    <li key={i}>
                      <code>{d}</code>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

(The list items carry `aria-label` so `findAllByRole('listitem', { name: /./ })` counts entries, not the nested chips.)

In `apps/web/src/templates/TemplateEditor.tsx`:

1. Imports: `import { ChecksPanel } from './ChecksPanel.js';`, `import { DraftChangesPanel } from './DraftChangesPanel.js';`, `import { attentionTabs, issueText, templateChecks, type SubTab } from './checks.js';`.
2. State (before the early returns): `const [saves, setSaves] = useState(0);` and in `save` after `setMessage('Draft saved.');` add `setSaves((n) => n + 1);`.
3. After `tabs`/`tabCount`:

```tsx
  const checks = embedded
    ? templateChecks({
        projectId: templateId,
        definition: def,
        issues,
        serverIssues: dirty ? [] : view.issues.map(issueText),
        stages: embedded.stages ?? null,
      })
    : [];
  const needs = attentionTabs(checks);
```

4. In the tablist button, after the count:

```tsx
                {needs.has(id as SubTab) && (
                  <>
                    <span className="tab-dot" aria-hidden="true" />
                    <span className="visually-hidden"> (needs attention)</span>
                  </>
                )}
```

5. After `{!embedded && <TestRail … />}` inside `.editor-layout`:

```tsx
        {embedded && (
          <aside className="template-side" aria-label="Checks and changes">
            <ChecksPanel checks={checks} onOpenSubTab={(t) => openTab(t)} />
            {record.status === 'draft' && (
              <DraftChangesPanel
                api={api}
                projectId={templateId}
                version={version}
                published={embedded.published ?? null}
                refreshKey={saves}
              />
            )}
          </aside>
        )}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/TemplateSide.test.tsx apps/web/test/TemplateEditor.test.tsx` → PASS.
Run: `npm run typecheck -w @ih/web && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/ChecksPanel.tsx apps/web/src/templates/DraftChangesPanel.tsx apps/web/src/templates/TemplateEditor.tsx apps/web/test/TemplateSide.test.tsx apps/web/test/TemplateEditor.test.tsx
git commit -m "Workbench web: Template tab Checks and Changes since vN panels (handoff 10, TP1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Wire the project page; Publish opens Evaluate; CSS

**Files:**
- Modify: `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/workbench/ProjectHeader.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/ProjectPage.test.tsx`, `apps/web/test/ProjectHeader.test.tsx`

**Interfaces:**
- Consumes: `EmbeddedEditor` (Task 8).
- Produces: the Template tab passes `{ onChanged: load, onSaved: loadOverview, dataPolicy, stages: overview?.stages ?? null, published }`; `ProjectHeader`'s *Publish vN* links to `#/workbench/:id/evaluate`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/ProjectPage.test.tsx`:

1. In `TAB_TITLES` change `['template', 'Template']` to `['template', 'Template · draft v1']` (deliberate: handoff §10's header names the draft; the editor owns its `TabHeader`, shown while it loads or fails too).
2. Append to `describe('ProjectPage', …)`:

```ts
  it("passes the overview's stale stages to the Template tab and refreshes the overview after a save", async () => {
    const getProjectOverview = vi.fn(async () =>
      overviewWith({ steps: { state: 'stale', status: 'Stale — Sections changed after it was accepted' } }),
    );
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })),
      getProjectOverview,
      getTemplate: vi.fn(async () => templateView({ ...validDefinition(), version: 2 })),
    });
    page(api, 'template');
    const checks = await screen.findByRole('region', { name: 'Checks' });
    expect(await within(checks).findByRole('link', { name: 'Review in Steps' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Changes since v1' })).toBeInTheDocument();
    const calls = getProjectOverview.mock.calls.length;
    await userEvent.click(screen.getByRole('tab', { name: /^General/ }));
    await userEvent.type(screen.getByLabelText('Name'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v2' }));
    await waitFor(() => expect(getProjectOverview.mock.calls.length).toBeGreaterThan(calls));
  });
```

   (Import `validDefinition` from `./template-fixture.js`.)

In `apps/web/test/ProjectHeader.test.tsx`, in `it('never locks Publish: …')` change the expected href to `'#/workbench/letter/evaluate'` and rename the test `'never locks Publish, which opens Evaluate (its gate card publishes)'`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/ProjectPage.test.tsx apps/web/test/ProjectHeader.test.tsx` → FAIL (H2 is "Template", no Checks region, href is `/template`).

- [ ] **Step 3: Implement**

`apps/web/src/workbench/ProjectHeader.tsx`: change the doc comment's "Publish, which opens the Template tab" to "Publish, which opens Evaluate (its gate card publishes)" and the link to `href={\`#/workbench/${project.id}/evaluate\`}`.

`apps/web/src/workbench/ProjectPage.tsx`: replace the Template tab block (`{tab === 'template' && header('template')}` and the `TemplateEditor` / Start card ternary) with:

```tsx
          {tab === 'template' &&
            (draft !== null ? (
              // The editor owns its tab header ("Template · draft vN", Try on, Export, More).
              <TemplateEditor
                key={draft}
                api={api}
                templateId={project.id}
                version={draft}
                onNavigate={onNavigate}
                embedded={{
                  onChanged: load,
                  onSaved: loadOverview,
                  dataPolicy: project.dataPolicy,
                  stages: overview?.stages ?? null,
                  published,
                }}
              />
            ) : (
              <>
                {header('template')}
                <div className="card">
                  <p>Every version is published; start the next one to keep developing.</p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void act(async () => {
                        await api.newDraft(project.id, published!);
                        load();
                        loadOverview();
                      })
                    }
                  >
                    Start v{(published ?? 0) + 1}
                  </button>
                </div>
              </>
            ))}
```

`apps/web/src/styles/stages.css`:

1. Extend the shared padding rule's selector list (after `.runs-others`) with `.checks-panel,`, `.changes-panel,`, `.step-detail` and the `font-weight: 600` list (after `.runs-others h3`) with `.checks-panel h3,`, `.changes-panel h3,`, `.step-detail h3`.
2. Append:

```css
/* Template tab (handoff §10) */
.template-embedded .editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
}
.template-embedded .editor-main {
  min-width: 0;
}
.template-side {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  position: sticky;
  top: calc(var(--ih-topbar-h, 0px) + 12px);
  max-height: calc(100vh - var(--ih-topbar-h, 0px) - 24px);
  overflow: auto;
}
.checks-panel[data-tone='warn'] {
  border-color: var(--ih-warn-fg);
}
.checks-list,
.changes-list,
.full-diff,
.diff-chips,
.step-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.checks-list {
  display: grid;
  gap: 8px;
}
.checks-list li {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  overflow-wrap: anywhere;
}
.check-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ih-ok-fg);
}
.checks-list li[data-tone='warn'] .check-dot {
  background: var(--ih-warn-fg);
}
.checks-list li[data-tone='alert'] .check-dot {
  background: var(--ih-alert-fg);
}
.checks-list li[data-tone='danger'] .check-dot {
  background: var(--ih-danger-fg);
}
.changes-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.changes-list > li {
  padding: 10px 0;
  border-top: 1px solid var(--ih-border);
  overflow-wrap: anywhere;
}
.changes-list p {
  margin: 4px 0 0;
}
.full-diff {
  margin-bottom: 8px;
  font-size: var(--ih-text-sm);
  overflow-wrap: anywhere;
}
.diff-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.diff-chips code {
  display: inline-block;
  padding: 2px 6px;
  border-radius: var(--ih-radius-sm);
  background: var(--ih-code-bg);
  overflow-wrap: anywhere;
}
.tab-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 4px;
  border-radius: 50%;
  background: var(--ih-warn-fg);
  vertical-align: middle;
}
.try-on {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.try-on select {
  max-width: 220px;
}
.subtab-foot {
  margin-top: 12px;
}
.pipeline-editor {
  display: grid;
  grid-template-columns: minmax(0, 240px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.step-list-col,
.step-detail {
  min-width: 0;
}
.step-list {
  display: grid;
  gap: 8px;
  margin-bottom: 8px;
}
.step-list-item {
  display: grid;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  text-align: left;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-md);
  background: var(--ih-surface);
  overflow-wrap: anywhere;
}
.step-list-item[aria-pressed='true'] {
  border-color: var(--ih-accent);
  background: var(--ih-accent-soft);
}
.step-list-add {
  border: 0;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 8px;
}
.step-detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.step-detail-head h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.step-detail-head .step-tools {
  margin-left: auto;
  border: 0;
  padding: 0;
}
.chip-toggles,
.fill-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  padding: 0;
  border: 0;
}
.toggle-chip,
.fill-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-pill);
}
.toggle-chip {
  padding: 4px 10px;
}
.toggle-chip:has(input:checked) {
  border-color: var(--ih-accent);
  background: var(--ih-accent-soft);
}
.toggle-chip:has(input:focus-visible) {
  outline: 2px solid var(--ih-accent);
  outline-offset: 2px;
}
.fill-chip {
  padding: 2px 4px 2px 10px;
}
.step-detail-figures {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ih-border);
}
.unsaved-bar {
  position: sticky;
  bottom: 12px;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 16px;
  padding: 12px 16px;
  border: 1px solid var(--ih-warn-fg);
  border-radius: var(--ih-radius-md);
  background: var(--ih-surface);
  box-shadow: var(--ih-shadow-bar);
}
.unsaved-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
@media (max-width: 1100px) {
  .template-embedded .editor-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .template-side {
    position: static;
    max-height: none;
  }
}
@media (max-width: 760px) {
  .pipeline-editor {
    grid-template-columns: minmax(0, 1fr);
  }
  .unsaved-actions {
    margin-left: 0;
  }
}
```

(Every token used exists in `apps/web/src/styles/tokens.css`: `--ih-warn-fg`, `--ih-ok-fg`, `--ih-alert-fg`, `--ih-danger-fg`, `--ih-border`, `--ih-surface`, `--ih-accent`, `--ih-accent-soft`, `--ih-code-bg`, `--ih-radius-sm|md|pill`, `--ih-shadow-bar`, `--ih-text-sm`.)

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/ProjectPage.test.tsx apps/web/test/ProjectHeader.test.tsx apps/web/test/TemplateEditor.test.tsx` → PASS.
Run: `npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: Look at it** (recommended): `deploy/scripts/dev-infra.ps1 up`, `npm run dev:api`, `npm run dev:web`, open `#/workbench/<id>/template` at 1440 px and at 375 px (Browser pane `resize_window` preset `mobile`): the Checks/Changes column sits right and stays in view while scrolling; the unsaved bar sticks to the bottom after an edit; the step list and form stack on mobile; no horizontal page scroll; dark theme legible. Reset the viewport (`preset: "desktop"`) afterwards. Also open `#/templates/<id>/<v>` and confirm the Templates page editor looks as before.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/workbench/ProjectPage.tsx apps/web/src/workbench/ProjectHeader.tsx apps/web/src/styles/stages.css apps/web/test/ProjectPage.test.tsx apps/web/test/ProjectHeader.test.tsx
git commit -m "Workbench web: wire the Template tab; Publish opens Evaluate; Template tab CSS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs and the full check

**Files:**
- Modify: `CLAUDE.md` (and `docs/openapi.json` if regenerating changes it)

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table: add a row after "Stage confirmations (keep a stale stage)":
   `| Draft change log (Template tab, TP1) | `TemplateChangeSchema`, `TEMPLATE_CHANGE_SOURCES`, `describeDefinitionChange`, `diffDefinitions` (moved from `apps/api/src/regression/diff.ts`, which re-exports it) in `packages/shared/src/definition-diff.ts`; `TemplateRepo.create(…, change)`/`updateDraft(…, { change, expectedUpdatedAt })`/`listChanges`, `apps/api/src/templates/changes.ts` (TS only) | none: the worker never reads `template_changes` (migration 0029) |`
2. **Rules of the road**, the "Templates live in the database" bullet: append " Every write to a draft records a `template_changes` row (migration 0029, append-only, `ON DELETE CASCADE` from its version; published rows are never written) in the same statement: `hand` saves (`PUT …/versions/:version`, also the Sections tab's anchor saves), applied `proposal`s (with `stage`, `proposal_id`; ` (n of m proposed changes)` when partly accepted), `restore`d iterations, the draft's `started` entry (new type, next version) and `import`s (YAML as a draft, bundles); summaries and diff chips come from `describeDefinitionChange`, and a write that changes nothing logs nothing. A save may carry `baseUpdatedAt` (the editors send it): when the draft was written since, nothing is saved and the answer is a 409 `the draft changed since you opened it; reload it to see the changes` (Pg compares `updated_at` truncated to the millisecond)."
3. **Workbench** bullet: replace "The Template tab's Publish (embedded `TemplateEditor`) calls this route, not the Templates one." with "The gate card on Evaluate calls this route (the Template tab has no Publish; the project header's *Publish vN* opens Evaluate)." Add, after the `deleteProject` children list ("…stage skips, briefs and samples"), "…and, with the template's draft rows, their change log (`template_changes`)". After the overview sentence, add "`GET /api/workbench/projects/:id/draft/changes` lists the open draft's change log newest first (`[]` without an open draft); the overview's *Hand edit* figure is the newest `hand` change (`handEditedAt`; a version with no log, from before migration 0029, falls back to its `updatedAt`)."
4. **UI** bullet: append " Template (`TemplateEditor` with `embedded`: `EmbeddedHeader` (`TabHeader` "Template · draft vN", `TryOn` → `runDevTests(…, { sampleIds: [one] })` through the re-process dialog, Export YAML, `DraftMenu`), sub-tabs General, Sections, Outputs, Pipeline (default; `PipelineEditor`: step list + step form with section toggle chips, output chips, last-run figures), YAML — no Quality; `ChecksPanel` (`templateChecks` in `templates/checks.ts`: coverage gaps, validation issues, stale stages, each linked; warn dots on sub-tabs), `DraftChangesPanel` (TP1, Full diff), `UnsavedBar` (Discard / Save draft vN)) follows handoff §10; the Templates page keeps `EditorHeader`, `StepCard`s, Quality and `TestRail`."

- [ ] **Step 2: Run** `npm run openapi` (commit `docs/openapi.json` if it changed), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

Re-run the Pg integration tests once on a fresh container (Global Constraints), then `docker rm -f ih-test-pg-template`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/openapi.json
git commit -m "Docs: draft change log, safe draft saves and the Template tab in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`.)

---

## Self-review

- **Spec coverage (§10):** no back link, name heading or Publish embedded (Task 8; Publish moves to Evaluate, Task 11); header "Template · draft vN" + sentence + *Try on [dev sample ▾] → Test run* + Export YAML + *More → Delete draft* (Tasks 6, 8); sub-tabs General, Sections n, Outputs n, Pipeline n, YAML, Quality removed, default Pipeline (Task 8), warn dots (Task 10); Pipeline step list with number, id, "Fills n · reads …", add, and the step form with Model, Pages per call, Max attempts, Reads sections chips in section colours, Fills outputs chips with × and an Add output select listing unfilled outputs first, Instructions, last-run figures and the retry warning (Task 9); General/Sections/Outputs keep their forms and end with a stage link (Task 8); Checks panel with validation issues, coverage gaps and stale stages, each linked (Tasks 7, 10); Changes since vN-1 with tags, time, summary, diff chip and Full diff (Tasks 1–5, 10); sticky unsaved bar with Discard / Save draft vN (Task 8). TP1 (Tasks 1–4), TP2 reused (`outputCoverage`, Task 7), TR1 used by *Try on* (Task 8). "Tests to add": any edit shows the unsaved bar, Discard restores, Quality absent when embedded (Task 8). §0: tab header (Task 8), cross-links (Tasks 8, 10), accessibility — aria-pressed step rows, tone words, labelled dots (Tasks 9, 10), polling — none on this tab, overview refreshed after save and test run (Tasks 8, 11).
- **Contracts and storage:** migration 0029 forward-only, published rows untouched (Task 2); TS-only log recorded in the contract table (Task 12); `deleteProject` deletes the log and its Pg counts test covers it (Task 2); repository interface change on Memory + Pg with a Pg integration test (Task 2); new route documented, swept and conformance-checked (Task 4); no `LIST_CACHE_VERSION` bump (list rows carry no metrics; the fingerprint already reads `templates.updated_at`).
- **Type consistency:** `TemplateChange`, `TemplateChangeInput`, `DraftWrite`, `EmbeddedEditor`, `TemplateCheck`, `SubTab`, `listDraftChanges`, `saveTemplate(…, baseUpdatedAt)`, `describeDefinitionChange`, `draftChange`, `startedChange`, `handEditedAt`, `PipelineEditor`, `StepFigures`, `retryWarning(m, here)` are named the same in every task.
