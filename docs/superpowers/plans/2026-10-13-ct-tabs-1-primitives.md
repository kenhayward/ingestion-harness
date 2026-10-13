# Workbench tabs 1/8: tab primitives, Outputs and Steps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared pieces every redesigned Workbench tab reuses (`ProposalCard`, `StaleBanner`, `SampleTag`, `SectionChip`, `sectionTone`, `Meter`), extract the "is not filled by any step" check into a pure shared `outputCoverage` (TP2), and redesign the Outputs and Steps tabs: Outputs gets summary chips, an "Outputs in draft vN" table compared with the live version and the latest proposal; Steps gets the coverage strip, the pipeline of step cards with per-step figures, and the proposal card that turns into an "N changes applied" card with JUST ADDED steps.

**Architecture:** Pure logic first, each in its own tested module: `outputCoverage` (`packages/shared/src/template.ts`, used by `TemplateSchema`'s validation and by the Steps tab), `changeVerb`/`changeDiff` (`apps/web/src/workbench/changes.ts`), `outputRows`/`outputSummary`/`changedRows` (`apps/web/src/workbench/outputRows.ts`), `stepCards`/`coverageHeadline`/`stepFigures`/`retryWarning` (`apps/web/src/workbench/steps.ts`). `ProposalCard` takes over the proposal markup from `StagePanel`; `StagePanel` keeps the data (proposals, selection, decide/skip) and gains `draft`/`published`/`briefVersion` props, loading the draft (and live) definitions through `useDefinitions` only for the Outputs and Steps stages, then renders `OutputsView` or `StepsView` around the card. No new API routes, no migrations, no worker change: the screens use `getTemplate`, `getMetrics`, `listProposals`, `decideProposal`.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §4 Outputs, §6 Steps, TP2 row of "New API"; screens `docs/design/workbench-tabs/screenshots/light/04-outputs.png`, `06-steps.png`, `docs/design/workbench-tabs/screenshots/states/06b-steps-applied.png` (dark variants in `screenshots/dark/`).

## Global Constraints

- **No new tokens** (handoff). Tones: `ok` done, `warn` needs you, `alert` stale, `danger` error/removed, `info` dev/informational, `skip` holdout, `lock` locked. `.tone-skip` and `.tone-lock` classes are added in `stages.css` using the existing `--ih-skip-*`/`--ih-lock-*` tokens.
- **Section colours** cycle by section order: `accent, ok, skip, warn, lock` (`sectionTone(index)`); real section ids are arbitrary, so the order in `document.sections` decides.
- **Proposal card (§0.2):** warn border while ready; meta = model (mono) · brief vN · status · age; one row per change with a tick box (default on, `aria-label="Apply: <describeChange>"`), `NEW`/`CHANGED`/`REMOVED` tag (only when the draft definition is known and the proposal is still ready), kind tag, mono diff chip, reason; footer **Apply N selected change(s)** (live count, disabled at 0), **Reject all**, "Edit by hand on the Template tab". After a decision: ok-bordered card "N of M changes applied to draft vN" with the next action link, and a **Latest proposal** disclosure listing each change as **Applied** / **Not applied**; a rejected proposal reads "Proposal rejected".
- **Stale (§0.4):** `StaleBanner` (role `note`) names what changed; *Keep* renders only with an `onKeep` handler (the confirm API arrives in PR 3), *Propose again* only with `onPropose` (the stage header already has one, so `StagePanel` passes neither).
- **Accessibility (§0.7):** every status icon labelled or decorative next to text; meters `role="img"` with the numbers in `aria-label`; tables are real `<table>` with `scope="col"` headers; colour never the only signal (removed rows say "− REMOVED" and are struck through; uncovered chips carry "!" and visually-hidden "not filled by any step").
- **Polling (§0.8):** unchanged — `StagePanel` polls only while its proposal is `running`.
- Data used only if it exists: brief-version staleness uses `ProposalView.briefVersion` vs `ProjectView.brief.version`; "Survey has a new candidate" is **not** shown (no `inBrief`/SV2 data yet). Per-step figures come from `TemplateMetrics.steps`, which aggregates every run of the type by step id across versions (cached runs excluded) — the subtitle says so instead of "last N test runs".
- Tests first (red, then green); `npm run check` green at the end; never stage `config/llm-providers.yaml` (it has an unrelated local edit); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`outputCoverage` changes no validation message** — duplicate field ids still give two issues, a table sharing a field's id is still reported as a field, a step listing a field twice still counts twice (Task 1 tests and the untouched `template.test.ts`).
2. **Decided proposals render differently** — the read-only checkbox list is replaced by the applied card; the StagePanel test "shows a decided proposal read-only" is rewritten deliberately (handoff §0.2), not weakened: it still asserts what was applied, no Reject button and the ok border (Task 4).
3. **Outputs/Steps are no longer remounted by `revision`** — `ProjectPage` keys them by tab so JUST ADDED survives the apply; `StagePanel` reloads the definitions itself after an apply (Task 7/8). Sections keeps its `revision` key.
4. **A failed definition load never hides the proposal** — the card still renders with an alert above it (Task 7 test).
5. **Coverage "fixed by the proposal"** follows the live tick boxes (applies only the selected changes with `applyChanges`) (Task 8 test).
6. **Long ids, regexes, diff chips** wrap inside cards at 390 px (`overflow-wrap: anywhere`; the outputs table scrolls inside its own wrapper, never the page).

---

### Task 1: Commit the handoff; shared `outputCoverage` (TP2)

**Files:**
- Add: `docs/design/workbench-tabs/` (already copied, untracked)
- Modify: `packages/shared/src/template.ts`
- Test: `packages/shared/test/coverage.test.ts` (create)

**Interfaces:**
- Produces (exported from `@ih/shared` via `template.ts`):
  - `interface OutputFill { id: string; kind: 'field' | 'table'; steps: string[] }`
  - `interface OutputCoverage { outputs: OutputFill[]; uncovered: string[]; multiple: string[] }`
  - `outputCoverage(definition: unknown): OutputCoverage`
- Consumed by: `TemplateSchema.superRefine` (this task), `StepsView` and `coverageHeadline` (Tasks 6, 8). TS only: the worker's own message (`worker/src/ingest_worker/template.py:209`) is unchanged and identical, so no contract change.

- [ ] **Step 1: Commit the handoff pack**

```bash
git add docs/design/workbench-tabs
git commit -m "Docs: Workbench tabs redesign handoff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing test** — `packages/shared/test/coverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { outputCoverage, TemplateSchema, type OutputCoverage } from '../src/template.js';

const outputs = {
  fields: [{ id: 'a' }, { id: 'b' }],
  tables: [{ id: 't', columns: [{ id: 'c' }] }],
};
const def = (pipeline: unknown[], outs: unknown = outputs) => ({ outputs: outs, pipeline });
const extract = (id: string, more: Record<string, unknown>) => ({
  type: 'extract',
  id,
  sections: ['x'],
  ...more,
});

describe('outputCoverage', () => {
  it.each<[string, unknown, OutputCoverage]>([
    [
      'every output filled once',
      def([extract('s1', { fields: ['a', 'b'] }), extract('s2', { table: 't' })]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s2'] },
        ],
        uncovered: [],
        multiple: [],
      },
    ],
    [
      'an unfilled field and table',
      def([extract('s1', { fields: ['a'] })]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'b', kind: 'field', steps: [] },
          { id: 't', kind: 'table', steps: [] },
        ],
        uncovered: ['b', 't'],
        multiple: [],
      },
    ],
    [
      'a field filled by two steps',
      def([
        extract('s1', { fields: ['a', 'b'] }),
        extract('s2', { fields: ['a'] }),
        extract('s3', { table: 't' }),
      ]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1', 's2'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s3'] },
        ],
        uncovered: [],
        multiple: ['a'],
      },
    ],
    [
      'a step listing a field twice counts twice',
      def([extract('s1', { fields: ['a', 'a', 'b'] }), extract('s2', { table: 't' })]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1', 's1'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s2'] },
        ],
        uncovered: [],
        multiple: ['a'],
      },
    ],
    [
      'check steps and unknown fields fill nothing',
      def([
        extract('s1', { fields: ['a', 'b', 'zzz'] }),
        extract('s2', { table: 't' }),
        { type: 'check', id: 'k', values: 'a', reference: 'b' },
      ]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s2'] },
        ],
        uncovered: [],
        multiple: [],
      },
    ],
    [
      'duplicate tables collapse, a table sharing a field id reads as a field',
      def([extract('s1', { fields: ['a'] })], {
        fields: [{ id: 'a' }],
        tables: [
          { id: 'a', columns: [] },
          { id: 'u', columns: [] },
          { id: 'u', columns: [] },
        ],
      }),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'u', kind: 'table', steps: [] },
        ],
        uncovered: ['u'],
        multiple: [],
      },
    ],
    ['a raw draft with missing parts', {}, { outputs: [], uncovered: [], multiple: [] }],
    ['not an object', null, { outputs: [], uncovered: [], multiple: [] }],
  ])('%s', (_name, definition, expected) => {
    expect(outputCoverage(definition)).toEqual(expected);
  });

  it('gives the template validation messages (unchanged)', () => {
    const result = TemplateSchema.safeParse({
      id: 'demo',
      version: 1,
      name: 'Demo',
      document: { sections: [{ id: 'x', anchor: 'X' }] },
      outputs: { fields: [{ id: 'a' }, { id: 'b' }], tables: [] },
      pipeline: [extract('s1', { fields: ['a'] }), extract('s2', { fields: ['a'] })],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.message)).toEqual([
      'field "a" is filled by more than one step',
      'field "b" is not filled by any step',
    ]);
  });
});
```

- [ ] **Step 3: Run** `npx vitest run --project shared packages/shared/test/coverage.test.ts` → FAIL (`outputCoverage` is not exported). (The last test passes on its own today: it pins the messages before the refactor.)

- [ ] **Step 4: Implement** — in `packages/shared/src/template.ts`, above `TemplateSchema`:

```ts
/** Which extract steps fill one output (handoff TP2). */
export interface OutputFill {
  id: string;
  kind: 'field' | 'table';
  /** Ids of the extract steps that fill it, in pipeline order (listed twice: appears twice). */
  steps: string[];
}

export interface OutputCoverage {
  /** Fields in order, then each distinct table id. */
  outputs: OutputFill[];
  /** Outputs no step fills. */
  uncovered: string[];
  /** Outputs more than one step fills. */
  multiple: string[];
}

type Loose = Record<string, unknown>;
const looseObj = (v: unknown): Loose =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {};
const looseList = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(looseObj) : []);
const looseIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Which extract step fills each output. Reads any definition, parsed or a raw draft (the Steps
 * tab's coverage strip), skipping malformed parts. The template validation's "is not filled by
 * any step" / "is filled by more than one step" issues come from this.
 */
export function outputCoverage(definition: unknown): OutputCoverage {
  const def = looseObj(definition);
  const outputs = looseObj(def.outputs);
  const fieldIds = looseIds(looseList(outputs.fields).map((f) => f.id));
  const tableIds = [...new Set(looseIds(looseList(outputs.tables).map((t) => t.id)))];
  const extracts = looseList(def.pipeline).filter(
    (s): s is Loose & { id: string } => s.type === 'extract' && typeof s.id === 'string',
  );
  const rows: OutputFill[] = [...fieldIds, ...tableIds].map((id) => ({
    id,
    kind: fieldIds.includes(id) ? 'field' : 'table',
    steps: extracts.flatMap((s) => [
      ...looseIds(s.fields)
        .filter((f) => f === id)
        .map(() => s.id),
      ...(s.table === id ? [s.id] : []),
    ]),
  }));
  return {
    outputs: rows,
    uncovered: rows.filter((r) => r.steps.length === 0).map((r) => r.id),
    multiple: rows.filter((r) => r.steps.length > 1).map((r) => r.id),
  };
}
```

In `superRefine`, delete `const fills = new Map<string, number>();`, the two `fills.set(...)` lines inside the extract loop (keep the "unknown field"/"unknown table" issues), and replace the `for (const id of [...fieldIds, ...tables.keys()])` loop with:

```ts
    for (const o of outputCoverage(t).outputs) {
      if (o.steps.length === 0) issue(`${o.kind} "${o.id}" is not filled by any step`);
      if (o.steps.length > 1) issue(`${o.kind} "${o.id}" is filled by more than one step`);
    }
```

The extract loop becomes:

```ts
      for (const f of step.fields) {
        if (!fieldIds.includes(f)) issue(`step "${step.id}": unknown field "${f}"`);
      }
      if (step.table !== undefined && !tables.has(step.table)) {
        issue(`step "${step.id}": unknown table "${step.table}"`);
      }
```

- [ ] **Step 5: Run** `npx vitest run --project shared` → PASS (coverage tests and every existing `template.test.ts` row, including "field not filled" and "filled by more than one step"); then `npx vitest run apps/api/test/spec-registry.test.ts`, `npx eslint packages/shared`, `npm run typecheck`, `npx prettier --write packages/shared/src/template.ts packages/shared/test/coverage.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/template.ts packages/shared/test/coverage.test.ts
git commit -m "Shared: outputCoverage, the step coverage behind the template's fill checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Small primitives — `sectionTone`, `Meter`, `SampleTag`, `SectionChip`, `StaleBanner`, `TabHeader` description

**Files:**
- Create: `apps/web/src/ui/Meter.tsx`, `apps/web/src/workbench/tags.tsx`, `apps/web/src/workbench/StaleBanner.tsx`
- Modify: `apps/web/src/ui/stageStyle.ts`, `apps/web/src/workbench/TabHeader.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/tab-primitives.test.tsx` (create), `apps/web/test/TabHeader.test.tsx`

**Interfaces:**
- Produces:
  - `SECTION_TONES: readonly StageTone[]`, `sectionTone(index: number): StageTone` (`ui/stageStyle.ts`)
  - `Meter({ label, value, threshold?, min = 0, max = 1, tone = 'accent' }: { label: string; value: number | null; threshold?: number; min?: number; max?: number; tone?: StageTone })`
  - `SampleTag({ role }: { role: SampleRole })`, `SectionChip({ id, index }: { id: string; index: number })` (`index < 0`: not a section of the draft)
  - `StaleBanner({ children, tone = 'alert', onKeep?, onPropose?, busy = false }: { children: ReactNode; tone?: 'alert' | 'info'; onKeep?: () => void; onPropose?: () => void; busy?: boolean })`
  - `TabHeader` gains `description?: string` (muted sentence on what the tab does, above `note`).

- [ ] **Step 1: Write the failing tests** — `apps/web/test/tab-primitives.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Meter } from '../src/ui/Meter.js';
import { SECTION_TONES, sectionTone } from '../src/ui/stageStyle.js';
import { StaleBanner } from '../src/workbench/StaleBanner.js';
import { SampleTag, SectionChip } from '../src/workbench/tags.js';

describe('sectionTone', () => {
  it.each([
    [0, 'accent'],
    [1, 'ok'],
    [2, 'skip'],
    [3, 'warn'],
    [4, 'lock'],
    [5, 'accent'],
    [7, 'skip'],
  ] as const)('section %i is %s', (index, tone) => {
    expect(sectionTone(index)).toBe(tone);
  });

  it('cycles five tones', () => {
    expect(SECTION_TONES).toHaveLength(5);
  });
});

describe('SectionChip', () => {
  it('shows the id with a dot in the section colour', () => {
    const { container } = render(<SectionChip id="payment" index={4} />);
    expect(screen.getByText('payment')).toBeInTheDocument();
    expect((container.querySelector('.section-dot') as HTMLElement).style.background).toBe(
      'var(--ih-lock-fg)',
    );
  });

  it('says when the section is not in the draft', () => {
    render(<SectionChip id="ghost" index={-1} />);
    expect(screen.getByText('(not a section of the draft)')).toBeInTheDocument();
  });
});

describe('SampleTag', () => {
  it.each([
    ['dev', 'DEV', 'tone-info'],
    ['holdout', 'HOLDOUT', 'tone-skip'],
  ] as const)('%s reads %s in %s', (role, text, tone) => {
    render(<SampleTag role={role} />);
    expect(screen.getByText(text)).toHaveClass('sample-tag', tone);
  });
});

describe('Meter', () => {
  it('carries the numbers in its label and places fill and threshold on the scale', () => {
    render(<Meter label="Holdout" value={0.88} threshold={0.9} min={0.7} max={1} tone="skip" />);
    const meter = screen.getByRole('img', { name: 'Holdout: 88%, threshold 90%' });
    expect((meter.querySelector('.meter-fill') as HTMLElement).style.width).toBe('60%');
    expect((meter.querySelector('.meter-tick') as HTMLElement).style.left).toBe('66.67%');
  });

  it('has no fill without a value', () => {
    render(<Meter label="Dev" value={null} />);
    const meter = screen.getByRole('img', { name: 'Dev: no score yet' });
    expect(meter.querySelector('.meter-fill')).toBeNull();
    expect(meter.querySelector('.meter-tick')).toBeNull();
  });

  it('clamps values outside the scale', () => {
    render(<Meter label="Dev" value={1.2} />);
    const meter = screen.getByRole('img', { name: 'Dev: 120%' });
    expect((meter.querySelector('.meter-fill') as HTMLElement).style.width).toBe('100%');
  });
});

describe('StaleBanner', () => {
  it('names what changed, with Keep and Propose again', async () => {
    const onKeep = vi.fn();
    const onPropose = vi.fn();
    render(
      <StaleBanner onKeep={onKeep} onPropose={onPropose}>
        Survey changed after these anchors were accepted.
      </StaleBanner>,
    );
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Survey changed after these anchors were accepted.');
    expect(within(note).getByRole('img', { name: 'Stale' })).toBeInTheDocument();
    await userEvent.click(within(note).getByRole('button', { name: 'Keep' }));
    expect(onKeep).toHaveBeenCalled();
    await userEvent.click(within(note).getByRole('button', { name: 'Propose again' }));
    expect(onPropose).toHaveBeenCalled();
  });

  it('leaves out the buttons it has no handler for', () => {
    render(<StaleBanner>Brief changed.</StaleBanner>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('disables its buttons while busy', () => {
    render(
      <StaleBanner onKeep={vi.fn()} onPropose={vi.fn()} busy>
        Brief changed.
      </StaleBanner>,
    );
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeDisabled();
  });

  it('is an info note without the stale icon', () => {
    render(<StaleBanner tone="info">This proposal used brief v2.</StaleBanner>);
    const note = screen.getByRole('note');
    expect(note).toHaveAttribute('data-tone', 'info');
    expect(within(note).queryByRole('img')).toBeNull();
  });
});
```

Add to `apps/web/test/TabHeader.test.tsx`:

```tsx
  it('says what the tab does above the policy note', () => {
    render(
      <TabHeader
        title="Outputs"
        item={null}
        description="The fields and tables every document of this type produces."
        note="Runs on local models; holdout samples are never sent."
      />,
    );
    const [description, note] = Array.from(document.querySelectorAll('.tab-note'));
    expect(description).toHaveTextContent('The fields and tables every document of this type produces.');
    expect(note).toHaveTextContent('Runs on local models; holdout samples are never sent.');
  });
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/tab-primitives.test.tsx apps/web/test/TabHeader.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/web/src/ui/stageStyle.ts` (append):

```ts
/** Section colours by order (handoff §0.6): a section keeps its colour on every tab. */
export const SECTION_TONES: readonly StageTone[] = ['accent', 'ok', 'skip', 'warn', 'lock'];

export function sectionTone(index: number): StageTone {
  const n = SECTION_TONES.length;
  return SECTION_TONES[((index % n) + n) % n]!;
}
```

`apps/web/src/ui/Meter.tsx`:

```tsx
import { TONE_COLOR, type StageTone } from './stageStyle.js';

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** A 0..1 figure as a bar (handoff §0.7): role img, the numbers in its label, a threshold tick. */
export function Meter({
  label,
  value,
  threshold,
  min = 0,
  max = 1,
  tone = 'accent',
}: {
  label: string;
  value: number | null;
  threshold?: number;
  min?: number;
  max?: number;
  tone?: StageTone;
}) {
  const at = (v: number) => {
    const share = Math.min(1, Math.max(0, (v - min) / (max - min)));
    return `${Math.round(share * 10000) / 100}%`;
  };
  const text = `${label}: ${value === null ? 'no score yet' : percent(value)}${
    threshold === undefined || value === null ? '' : `, threshold ${percent(threshold)}`
  }`;
  return (
    <span className="meter" role="img" aria-label={text}>
      {value !== null && (
        <span className="meter-fill" style={{ width: at(value), background: TONE_COLOR[tone] }} />
      )}
      {value !== null && threshold !== undefined && (
        <span className="meter-tick" style={{ left: at(threshold) }} />
      )}
    </span>
  );
}
```

`apps/web/src/workbench/tags.tsx`:

```tsx
import type { SampleRole } from '@ih/shared';
import { sectionTone, TONE_COLOR } from '../ui/stageStyle.js';

/** Dev = info "DEV", holdout = skip (violet) "HOLDOUT" (handoff §0.6): text, never colour alone. */
export function SampleTag({ role }: { role: SampleRole }) {
  return (
    <span className={`sample-tag tone-${role === 'dev' ? 'info' : 'skip'}`}>
      {role === 'dev' ? 'DEV' : 'HOLDOUT'}
    </span>
  );
}

/** A section id with its colour dot; `index` is its place in the draft's sections (-1: none). */
export function SectionChip({ id, index }: { id: string; index: number }) {
  const color = index < 0 ? TONE_COLOR.neutral : TONE_COLOR[sectionTone(index)];
  return (
    <span className="section-chip">
      <span className="section-dot" aria-hidden="true" style={{ background: color }} />
      <code>{id}</code>
      {index < 0 && <span className="visually-hidden">(not a section of the draft)</span>}
    </span>
  );
}
```

`apps/web/src/workbench/StaleBanner.tsx`:

```tsx
import type { ReactNode } from 'react';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';

/** Handoff §0.4: a tab whose inputs changed names what changed; Keep and Propose again. */
export function StaleBanner({
  children,
  tone = 'alert',
  onKeep,
  onPropose,
  busy = false,
}: {
  children: ReactNode;
  tone?: 'alert' | 'info';
  onKeep?: () => void;
  onPropose?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="stale-banner" role="note" data-tone={tone}>
      {tone === 'alert' && <StageStatusIcon state="stale" size={18} />}
      <p className="stale-banner-text">{children}</p>
      {(onKeep || onPropose) && (
        <div className="stale-banner-actions">
          {onKeep && (
            <button type="button" disabled={busy} onClick={onKeep}>
              Keep
            </button>
          )}
          {onPropose && (
            <button type="button" disabled={busy} onClick={onPropose}>
              Propose again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

(`StageStatusIcon` without `decorative` is `role="img"` labelled `stageStyle('stale').label` = "Stale".)

`TabHeader.tsx`: add `description?: string` to the props and render it before the note:

```tsx
        {description && <p className="muted tab-note">{description}</p>}
        {note && <p className="muted tab-note">{note}</p>}
```

`stages.css` (append):

```css
/* Workbench tabs (handoff §0): shared tags, chips, meter, stale banner */
.tone-skip {
  background: var(--ih-skip-bg);
  color: var(--ih-skip-fg);
}
.tone-lock {
  background: var(--ih-lock-bg);
  color: var(--ih-lock-fg);
}
.sample-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--ih-radius-sm);
  font-size: var(--ih-text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.section-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-sm);
  background: var(--ih-surface);
  overflow-wrap: anywhere;
}
.section-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.meter {
  position: relative;
  display: block;
  min-width: 84px;
  height: 8px;
  border-radius: 4px;
  background: var(--ih-border-soft);
}
.meter-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
}
.meter-tick {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  background: var(--ih-text);
}
.stale-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid var(--ih-alert-fg);
  border-radius: var(--ih-radius-lg);
  background: var(--ih-alert-bg);
  color: var(--ih-text);
}
.stale-banner[data-tone='info'] {
  border-color: var(--ih-info-fg);
  background: var(--ih-info-bg);
}
.stale-banner-text {
  flex: 1 1 280px;
  margin: 0;
  overflow-wrap: anywhere;
}
.stale-banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
```

- [ ] **Step 4: Run** the two test files → PASS; `npx eslint apps/web/src/ui apps/web/src/workbench apps/web/test/tab-primitives.test.tsx`, `npm run typecheck`, `npx prettier --write` on the touched files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/Meter.tsx apps/web/src/ui/stageStyle.ts apps/web/src/workbench/tags.tsx apps/web/src/workbench/StaleBanner.tsx apps/web/src/workbench/TabHeader.tsx apps/web/src/styles/stages.css apps/web/test/tab-primitives.test.tsx apps/web/test/TabHeader.test.tsx
git commit -m "Workbench web: section tones, meter, sample and section tags, stale banner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `changeVerb` and `changeDiff` (NEW/CHANGED/REMOVED and the diff chip)

**Files:**
- Modify: `apps/web/src/workbench/changes.ts`
- Test: `apps/web/test/changes.test.ts`

**Interfaces:**
- Consumes: `DraftChange`, `stableJson` (`@ih/shared`).
- Produces:
  - `type ChangeVerb = 'NEW' | 'CHANGED' | 'REMOVED'`
  - `changeVerb(c: DraftChange, definition: Record<string, unknown>): ChangeVerb`
  - `changeDiff(c: DraftChange, definition: Record<string, unknown>): string | null` — the mono chip (`+ due_date`, `chunk pages 3 → 2`, `− reads payment`); null when the change text says it all (copies, preamble) or nothing differs.
- Defaults of the raw definition are applied when comparing (`type` → `text`, `required` → true, `model` → `default`, `maxAttempts` → 2), so a draft saved without defaults does not read as changed.

- [ ] **Step 1: Write the failing tests** — append to `apps/web/test/changes.test.ts` (merge the imports):

```ts
import { changeDiff, changeVerb } from '../src/workbench/changes.js';

const def = {
  document: {
    sections: [
      { id: 'header', anchor: '^INVOICE', required: true },
      { id: 'totals', anchor: 'Total' },
    ],
  },
  outputs: {
    fields: [
      { id: 'invoice_date', type: 'date' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR'] },
    ],
    tables: [{ id: 'lines', columns: [{ id: 'qty', type: 'decimal' }, { id: 'amount' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['invoice_date'], sections: ['header'] },
    { type: 'extract', id: 'lines', table: 'lines', sections: ['totals'], chunkPages: 3 },
    { type: 'extract', id: 'totals', fields: ['currency'], sections: ['totals', 'payment'] },
  ],
};

describe('changeVerb and changeDiff', () => {
  it.each([
    [{ op: 'putField', reason: 'r', field: { id: 'due_date', type: 'date' } }, 'NEW', '+ due_date'],
    [
      { op: 'putField', reason: 'r', field: { id: 'currency', type: 'enum', enum: ['GBP', 'EUR', 'USD'] } },
      'CHANGED',
      'values GBP, EUR → GBP, EUR, USD',
    ],
    [
      { op: 'putField', reason: 'r', field: { id: 'invoice_date', type: 'text', description: 'Printed DMY' } },
      'CHANGED',
      'type date → text, description edited',
    ],
    [{ op: 'putField', reason: 'r', field: { id: 'invoice_date', type: 'date' } }, 'CHANGED', null],
    [{ op: 'removeOutput', reason: 'r', id: 'currency' }, 'REMOVED', '− currency'],
    [
      { op: 'putTable', reason: 'r', table: { id: 'lines', columns: [{ id: 'qty', type: 'decimal' }, { id: 'amount' }, { id: 'unit_price' }] } },
      'CHANGED',
      '+ unit_price',
    ],
    [
      { op: 'putTable', reason: 'r', table: { id: 'lines', columns: [{ id: 'qty', type: 'integer' }] } },
      'CHANGED',
      '− amount, ~ qty',
    ],
    [
      { op: 'putSection', reason: 'r', section: { id: 'totals', anchor: '^TOTAL', required: false } },
      'CHANGED',
      'anchor /Total/ → /^TOTAL/, required → optional',
    ],
    [{ op: 'removeSection', reason: 'r', id: 'totals' }, 'REMOVED', '− totals'],
    [
      { op: 'putStep', reason: 'r', step: { type: 'extract', id: 'header', fields: ['invoice_date', 'due_date'], sections: ['header'] } },
      'CHANGED',
      '+ due_date',
    ],
    [
      { op: 'putStep', reason: 'r', step: { type: 'extract', id: 'lines', table: 'lines', sections: ['totals'], chunkPages: 2 } },
      'CHANGED',
      'chunk pages 3 → 2',
    ],
    [
      { op: 'putStep', reason: 'r', step: { type: 'extract', id: 'totals', fields: ['currency'], sections: ['totals'] } },
      'CHANGED',
      '− reads payment',
    ],
    [
      { op: 'putStep', reason: 'r', step: { type: 'extract', id: 'header', fields: ['invoice_date'], sections: ['header'], model: 'fast', maxAttempts: 3 } },
      'CHANGED',
      'model default → fast, attempts 2 → 3',
    ],
    [
      { op: 'putStep', reason: 'r', step: { type: 'check', id: 'totals-match', values: 'lines.amount', reference: 'total' } },
      'NEW',
      '+ totals-match',
    ],
    [{ op: 'removeStep', reason: 'r', id: 'lines' }, 'REMOVED', '− lines'],
    [{ op: 'setPreamble', reason: 'r', preamble: 'Be careful' }, 'NEW', null],
    [{ op: 'setPreamble', reason: 'r', preamble: '' }, 'REMOVED', null],
    [{ op: 'setCopies', reason: 'r', copies: null }, 'REMOVED', null],
  ])('%#', (change, verb, diff) => {
    const c = change as unknown as DraftChange;
    expect(changeVerb(c, def)).toBe(verb);
    expect(changeDiff(c, def)).toBe(diff);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/changes.test.ts` → FAIL.

- [ ] **Step 3: Implement** — append to `apps/web/src/workbench/changes.ts` (add `stableJson` to the `@ih/shared` import):

```ts
export type ChangeVerb = 'NEW' | 'CHANGED' | 'REMOVED';

type Def = Record<string, unknown>;
const MINUS = '−';
const obj = (v: unknown): Def => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {});
const list = (v: unknown): Def[] => (Array.isArray(v) ? v.map(obj) : []);
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const shown = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '–');
const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);
const arrow = (label: string, a: unknown, b: unknown) =>
  same(a, b) ? [] : [`${label} ${shown(a)} → ${shown(b)}`];
const edited = (key: string, a: unknown, b: unknown) => (same(a, b) ? [] : [`${key} edited`]);
const setDiff = (before: string[], after: string[], label = '') => [
  ...after.filter((x) => !before.includes(x)).map((x) => `+ ${label}${x}`),
  ...before.filter((x) => !after.includes(x)).map((x) => `${MINUS} ${label}${x}`),
];
const withDefault = (v: unknown, fallback: unknown) => (v === undefined ? fallback : v);

/** The item a change replaces in the draft, or null when it adds one. */
function existing(c: DraftChange, def: Def): Def | null {
  const outputs = obj(def.outputs);
  const document = obj(def.document);
  const find = (items: Def[], id: string) => items.find((x) => x.id === id) ?? null;
  switch (c.op) {
    case 'putField':
      return find([...list(outputs.fields), ...list(outputs.tables)], c.field.id);
    case 'putTable':
      return find([...list(outputs.fields), ...list(outputs.tables)], c.table.id);
    case 'putSection':
      return find(list(document.sections), c.section.id);
    case 'putStep':
      return find(list(def.pipeline), c.step.id);
    case 'setCopies':
      return document.copies ? obj(document.copies) : null;
    case 'setPreamble':
      return typeof def.preamble === 'string' && def.preamble !== '' ? {} : null;
    default:
      return null;
  }
}

/** NEW / CHANGED / REMOVED against the open draft (handoff §0.2). */
export function changeVerb(c: DraftChange, definition: Def): ChangeVerb {
  if (c.op === 'removeOutput' || c.op === 'removeSection' || c.op === 'removeStep') return 'REMOVED';
  if (c.op === 'setCopies' && c.copies === null) return 'REMOVED';
  if (c.op === 'setPreamble' && c.preamble === '') return 'REMOVED';
  return existing(c, definition) === null ? 'NEW' : 'CHANGED';
}

function valueDiff(before: Def, after: Def): string[] {
  return [
    ...arrow('type', withDefault(before.type, 'text'), withDefault(after.type, 'text')),
    ...(same(before.enum, after.enum)
      ? []
      : [`values ${ids(before.enum).join(', ') || '–'} → ${ids(after.enum).join(', ') || '–'}`]),
    ...edited('name', before.name, after.name),
    ...edited('description', before.description, after.description),
  ];
}

/** The mono diff chip of a change: what it adds, drops or moves; null when there is nothing to add. */
export function changeDiff(c: DraftChange, definition: Def): string | null {
  if (c.op === 'removeOutput' || c.op === 'removeSection' || c.op === 'removeStep') {
    return `${MINUS} ${c.id}`;
  }
  if (c.op === 'setCopies' || c.op === 'setPreamble') return null;
  const before = existing(c, definition);
  const id = c.op === 'putField' ? c.field.id : c.op === 'putTable' ? c.table.id : c.op === 'putSection' ? c.section.id : c.step.id;
  if (before === null) return `+ ${id}`;
  let parts: string[] = [];
  if (c.op === 'putField') parts = valueDiff(before, c.field as Def);
  if (c.op === 'putTable') {
    const old = list(before.columns);
    const now = c.table.columns as Def[];
    parts = [
      ...setDiff(ids(old.map((x) => x.id)), now.map((x) => String(x.id))),
      ...now
        .filter((col) => {
          const prev = old.find((x) => x.id === col.id);
          return prev !== undefined && valueDiff(prev, col).length > 0;
        })
        .map((col) => `~ ${String(col.id)}`),
      ...edited('name', before.name, c.table.name),
      ...edited('description', before.description, c.table.description),
    ];
  }
  if (c.op === 'putSection') {
    const was = withDefault(before.required, true) === true;
    parts = [
      ...(same(before.anchor, c.section.anchor) ? [] : [`anchor /${shown(before.anchor)}/ → /${c.section.anchor}/`]),
      ...(was === c.section.required ? [] : [was ? 'required → optional' : 'optional → required']),
    ];
  }
  if (c.op === 'putStep') {
    const step = c.step as Def;
    if (before.type !== step.type) {
      parts = [`type ${shown(before.type)} → ${shown(step.type)}`];
    } else if (step.type === 'extract') {
      parts = [
        ...setDiff(ids(before.fields), ids(step.fields)),
        ...arrow('table', before.table, step.table),
        ...setDiff(ids(before.sections), ids(step.sections), 'reads '),
        ...arrow('chunk pages', before.chunkPages, step.chunkPages),
        ...arrow('model', withDefault(before.model, 'default'), withDefault(step.model, 'default')),
        ...arrow('attempts', withDefault(before.maxAttempts, 2), withDefault(step.maxAttempts, 2)),
        ...edited('instructions', before.instructions, step.instructions),
      ];
    } else {
      parts = [
        ...arrow('values', before.values, step.values),
        ...arrow('reference', before.reference, step.reference),
        ...arrow('aliases', before.aliases, step.aliases),
      ];
    }
  }
  return parts.length ? parts.join(', ') : null;
}
```

(The test's `putTable` row `'− amount, ~ qty'`: `setDiff` lists additions first, then removals, then changed columns. `required` arrives parsed as a boolean on `DraftChange`, so comparing with the draft's defaulted value is enough.)

- [ ] **Step 4: Run** the test file → PASS; eslint, typecheck, prettier (prettier will rewrap the long ternary for `id`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/changes.ts apps/web/test/changes.test.ts
git commit -m "Workbench web: NEW/CHANGED/REMOVED and the diff chip for each proposed change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `ProposalCard`, and `StagePanel` on it

**Files:**
- Create: `apps/web/src/workbench/ProposalCard.tsx`
- Modify: `apps/web/src/workbench/StagePanel.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/ProposalCard.test.tsx` (create), `apps/web/test/StagePanel.test.tsx`

**Interfaces:**
- Consumes: Task 3 (`changeVerb`, `changeDiff`), `changeParts`, `relativeTime`, `stageStyle`, `TONE_COLOR`, `StageStatusIcon`.
- Produces (`ProposalCard.tsx`; `PROPOSAL_STATE` and `describeChange` move here from `StagePanel.tsx` — nothing else imports them):

```ts
export interface NextStep { href: string; label: string; text: string }
export function ProposalCard(props: {
  projectId: string;
  proposal: ProposalView;
  body: ChangeBody;
  /** The open draft: NEW/CHANGED tags and diff chips while the proposal is ready; null hides them. */
  definition: Record<string, unknown> | null;
  draftVersion: number | null;
  selected: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onApply: () => void;
  onReject: () => void;
  busy: boolean;
  now: number;
  /** A muted line under a change (sections: where the anchor was found). */
  note?: (c: DraftChange) => string | null;
  /** The next action on the applied card. */
  next?: NextStep;
}): JSX.Element
```

- [ ] **Step 1: Write the failing tests** — `apps/web/test/ProposalCard.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { changeBodyOf, type ProposalView } from '@ih/shared';
import { ProposalCard } from '../src/workbench/ProposalCard.js';
import { changeProposalView } from './fake-api.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const NEXT = {
  href: '#/workbench/letter/sections',
  label: 'Go to Sections',
  text: 'Next, check where each section starts in the dev samples.',
};

function card(p: ProposalView, props: Partial<Parameters<typeof ProposalCard>[0]> = {}) {
  const handlers = { onToggle: vi.fn(), onApply: vi.fn(), onReject: vi.fn() };
  render(
    <ProposalCard
      projectId="letter"
      proposal={p}
      body={changeBodyOf(p)!}
      definition={null}
      draftVersion={4}
      selected={new Set([0, 1])}
      busy={false}
      now={NOW}
      next={NEXT}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('ProposalCard', () => {
  it('lists every change with a tick box, a live count, Apply and Reject all', async () => {
    const h = card(changeProposalView());
    expect(
      screen.getByRole('heading', { level: 3, name: 'Proposal · 2 of 2 changes selected' }),
    ).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Apply: Field protocol_number (text)' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(h.onToggle).toHaveBeenCalledWith(0);
    await userEvent.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(h.onApply).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    expect(h.onReject).toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Proposal' }).style.borderColor).toBe(
      'var(--ih-warn-fg)',
    );
  });

  it('cannot apply nothing', () => {
    card(changeProposalView(), { selected: new Set() });
    expect(screen.getByRole('button', { name: 'Apply 0 selected changes' })).toBeDisabled();
  });

  it('tags new and changed outputs against the draft, with the diff chip', () => {
    card(changeProposalView(), {
      definition: { outputs: { fields: [{ id: 'approved_on', type: 'text' }], tables: [] } },
    });
    const added = screen
      .getByRole('checkbox', { name: 'Apply: Field protocol_number (text)' })
      .closest('li')!;
    expect(within(added).getByText('NEW')).toBeInTheDocument();
    expect(within(added).getByText('+ protocol_number')).toBeInTheDocument();
    const changed = screen
      .getByRole('checkbox', { name: 'Apply: Field approved_on (date)' })
      .closest('li')!;
    expect(within(changed).getByText('CHANGED')).toBeInTheDocument();
    expect(within(changed).getByText('type text → date')).toBeInTheDocument();
  });

  it('has no NEW/CHANGED tags without the draft', () => {
    card(changeProposalView());
    expect(screen.queryByText('NEW')).toBeNull();
    expect(screen.queryByText('CHANGED')).toBeNull();
  });

  it('becomes the applied card with the next action and the latest proposal', () => {
    card(changeProposalView({ status: 'partially_accepted', acceptedChanges: [1] }));
    const region = screen.getByRole('region', { name: 'Proposal' });
    expect(region.style.borderColor).toBe('var(--ih-ok-fg)');
    expect(
      within(region).getByRole('heading', { level: 3, name: '1 of 2 changes applied to draft v4' }),
    ).toBeInTheDocument();
    expect(within(region).getByText(NEXT.text)).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Go to Sections' })).toHaveAttribute(
      'href',
      NEXT.href,
    );
    expect(within(region).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(region).queryByRole('button', { name: 'Reject all' })).toBeNull();
    expect(within(region).getByText('Latest proposal')).toBeInTheDocument();
    // Inside a closed <details>: query by text, not by role.
    expect(within(region).getByText('Not applied').closest('li')).toHaveTextContent(
      'protocol_number',
    );
    expect(within(region).getByText('Applied').closest('li')).toHaveTextContent('approved_on');
  });

  it('says a rejected proposal was rejected, without a next action', () => {
    card(changeProposalView({ status: 'rejected' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Proposal rejected' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Sections' })).toBeNull();
    expect(screen.getAllByText('Not applied')).toHaveLength(2);
  });
});
```

Update `apps/web/test/StagePanel.test.tsx` deliberately (handoff §0.2 replaces the read-only checkbox list with the applied card):
- Replace the test "shows a decided proposal read-only, bordered in its tone" with:

```tsx
  it('shows a decided proposal as the applied card, bordered in its tone', async () => {
    const p = changeProposalView({ status: 'partially_accepted', acceptedChanges: [0] });
    panel({ listProposals: vi.fn(async () => [p]) });
    const region = await screen.findByRole('region', { name: 'Proposal' });
    expect(within(region).getByText(/1 of 2 changes applied/)).toBeInTheDocument();
    expect(within(region).getByText('Applied').closest('li')).toHaveTextContent('protocol_number');
    expect(within(region).getByText('Not applied').closest('li')).toHaveTextContent(
      'approved_on',
    );
    expect(within(region).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
    expect(region.style.borderColor).toBe('var(--ih-ok-fg)');
  });

  it('points to the next tab once applied', async () => {
    const p = changeProposalView({ status: 'accepted', acceptedChanges: [0, 1] });
    panel({ listProposals: vi.fn(async () => [p]) });
    expect(await screen.findByRole('link', { name: 'Go to Sections' })).toHaveAttribute(
      'href',
      '#/workbench/letter/sections',
    );
  });
```

The other StagePanel tests keep their assertions (checkbox names, button names, "1 of 2 changes applied" text, the kind tags, the Template link).

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/ProposalCard.test.tsx apps/web/test/StagePanel.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `apps/web/src/workbench/ProposalCard.tsx`:

```tsx
import { useId } from 'react';
import type { ChangeBody, DraftChange, ProposalStatus, ProposalView } from '@ih/shared';
import { relativeTime } from '../jobs/derive.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR, type DisplayState } from '../ui/stageStyle.js';
import { changeDiff, changeParts, changeVerb, type ChangeVerb } from './changes.js';

/** A proposal's status as a stage state: the card's border tone. */
export const PROPOSAL_STATE: Record<ProposalStatus, DisplayState> = {
  running: 'running',
  ready: 'proposed',
  accepted: 'accepted',
  partially_accepted: 'accepted',
  rejected: 'pending',
  failed: 'warn',
};

const VERB_TONE: Record<ChangeVerb, string> = { NEW: 'ok', CHANGED: 'info', REMOVED: 'alert' };

export interface NextStep {
  href: string;
  label: string;
  text: string;
}

/** One line per change, used as its checkbox label. */
export function describeChange(c: DraftChange): string {
  // body moved verbatim from StagePanel.tsx
}

function ChangeText({ c }: { c: DraftChange }) {
  const parts = changeParts(c);
  return (
    <>
      <span className={`kind-tag tone-${parts.tone}`}>{parts.kind}</span>
      {parts.id && <code>{parts.id}</code>} {parts.text}
    </>
  );
}

/** Handoff §0.2: the drafting proposal; after a decision, the applied card. */
export function ProposalCard({
  projectId,
  proposal,
  body,
  definition,
  draftVersion,
  selected,
  onToggle,
  onApply,
  onReject,
  busy,
  now,
  note,
  next,
}: {
  projectId: string;
  proposal: ProposalView;
  body: ChangeBody;
  definition: Record<string, unknown> | null;
  draftVersion: number | null;
  selected: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onApply: () => void;
  onReject: () => void;
  busy: boolean;
  now: number;
  note?: (c: DraftChange) => string | null;
  next?: NextStep;
}) {
  const idBase = useId();
  const border = TONE_COLOR[stageStyle(PROPOSAL_STATE[proposal.status]).tone];
  const meta = (
    <p>
      <code>{proposal.model ?? '—'}</code> · brief v{proposal.briefVersion ?? '–'} ·{' '}
      {proposal.status.replace('_', ' ')} · {relativeTime(proposal.createdAt, now)}
    </p>
  );

  if (proposal.status !== 'ready') {
    const applied = proposal.acceptedChanges ?? [];
    const accepted = proposal.status === 'accepted' || proposal.status === 'partially_accepted';
    return (
      <section aria-label="Proposal" className="proposal-card proposal-decided" style={{ borderColor: border }}>
        <div className={accepted ? 'proposal-meta proposal-applied' : 'proposal-meta'}>
          <h3>
            {accepted
              ? `${applied.length} of ${body.changes.length} changes applied${draftVersion === null ? '' : ` to draft v${draftVersion}`}`
              : proposal.status === 'rejected'
                ? 'Proposal rejected'
                : `Proposal ${proposal.status}`}
          </h3>
          {accepted && next && (
            <>
              <p>{next.text}</p>
              <a className="button primary" href={next.href}>
                {next.label}
              </a>
            </>
          )}
        </div>
        <details className="proposal-history">
          <summary>Latest proposal</summary>
          <div className="proposal-meta">
            {meta}
            {body.notes && <p>{body.notes}</p>}
          </div>
          <ul className="proposal-changes proposal-decided-list">
            {body.changes.map((c, i) => {
              const done = applied.includes(i);
              return (
                <li key={`${i}-${c.op}`}>
                  <StageStatusIcon state={done ? 'accepted' : 'pending'} size={18} decorative />
                  <span className="proposal-change">
                    <span className="proposal-line">
                      <ChangeText c={c} />{' '}
                      <strong className={done ? 'applied-yes' : 'muted'}>
                        {done ? 'Applied' : 'Not applied'}
                      </strong>
                    </span>
                    <span className="proposal-line muted">{c.reason}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </section>
    );
  }

  return (
    <section aria-label="Proposal" className="proposal-card" style={{ borderColor: border }}>
      <div className="proposal-meta proposal-ready">
        <h3>
          Proposal · {selected.size} of {body.changes.length} changes selected
        </h3>
        {meta}
        {body.notes && <p>{body.notes}</p>}
      </div>
      <ul className="proposal-changes">
        {body.changes.map((c, i) => {
          const verb = definition ? changeVerb(c, definition) : null;
          const diff = definition ? changeDiff(c, definition) : null;
          const line = note?.(c) ?? null;
          return (
            <li key={`${i}-${c.op}`}>
              <input
                id={`${idBase}-${i}`}
                type="checkbox"
                aria-label={`Apply: ${describeChange(c)}`}
                checked={selected.has(i)}
                onChange={() => onToggle(i)}
              />
              <label className="proposal-change" htmlFor={`${idBase}-${i}`}>
                <span className="proposal-line">
                  {verb && <span className={`kind-tag tone-${VERB_TONE[verb]}`}>{verb}</span>}
                  <ChangeText c={c} />
                </span>
                {diff && <code className="diff-chip">{diff}</code>}
                <span className="proposal-line muted">{c.reason}</span>
                {line && <span className="proposal-line muted">{line}</span>}
              </label>
              <details>
                <summary>Details</summary>
                <pre>{JSON.stringify(c, null, 2)}</pre>
              </details>
            </li>
          );
        })}
      </ul>
      <footer className="proposal-footer">
        <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={onApply}>
          Apply {selected.size} selected {selected.size === 1 ? 'change' : 'changes'}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onReject}>
          Reject all
        </button>
        <a className="proposal-edit" href={`#/workbench/${projectId}/template`}>
          Edit by hand on the Template tab
        </a>
      </footer>
    </section>
  );
}
```

(`describeChange`: cut the existing function body from `StagePanel.tsx` and paste it unchanged. `ChangeText` keeps the kind tag and the id as siblings of the text node, so the existing `getByText('items.amount against total')` still matches the span's own text.)

`StagePanel.tsx`:
- Remove `PROPOSAL_STATE`, `describeChange`, `useId`, `idBase`, and the imports only they used (`relativeTime`, `stageStyle`, `TONE_COLOR`, `DisplayState`, `ProposalStatus`, `changeParts`); import `ProposalCard` and `NextStep` from `./ProposalCard.js`.
- Add above the component:

```ts
/** What follows an applied proposal (handoff §0.2: "usually a link to the next tab"). */
const NEXT: Record<ChangeStage, { tab: string; label: string; text: string }> = {
  outputs: {
    tab: 'sections',
    label: 'Go to Sections',
    text: 'Next, check where each section starts in the dev samples.',
  },
  sections: {
    tab: 'steps',
    label: 'Go to Steps',
    text: 'Next, decide which step reads which sections and fills which outputs.',
  },
  steps: {
    tab: 'runs',
    label: 'Run on dev samples',
    text: 'Run the steps on the dev samples to refresh the per-step figures, then verify references.',
  },
  revise: {
    tab: 'evaluate',
    label: 'Evaluate on dev',
    text: 'Evaluate the revised draft on the dev samples to see whether it helped.',
  },
};
```

- Replace the whole `{body && proposal && (<section aria-label="Proposal" …>…</section>)}` block with:

```tsx
      {body && proposal && (
        <ProposalCard
          projectId={projectId}
          proposal={proposal}
          body={body}
          definition={null}
          draftVersion={null}
          selected={selected}
          onToggle={toggle}
          onApply={() => void accept()}
          onReject={() => void reject()}
          busy={busy}
          now={now}
          note={anchorLine}
          next={nextStep}
        />
      )}
```

  with, after `const applied = …` is deleted (the card owns it): 

```ts
  const nextStep: NextStep = {
    href: `#/workbench/${projectId}/${NEXT[stage].tab}`,
    label: NEXT[stage].label,
    text: NEXT[stage].text,
  };
```

  (`definition` and `draftVersion` are wired in Task 7.)

`stages.css` (append):

```css
.proposal-meta h3 {
  margin: 0 0 6px;
  font-size: var(--ih-text-md);
}
.proposal-ready {
  background: var(--ih-warn-bg);
}
.proposal-applied {
  background: var(--ih-ok-bg);
}
.proposal-applied .button {
  margin-top: 8px;
}
.proposal-history > summary {
  padding: 10px 18px;
  cursor: pointer;
  font-weight: 600;
}
.proposal-decided-list li {
  grid-template-columns: 20px minmax(0, 1fr);
}
.applied-yes {
  color: var(--ih-ok-fg);
}
.diff-chip {
  display: inline-block;
  width: fit-content;
  margin: 4px 0;
  padding: 1px 8px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-sm);
  background: var(--ih-code-bg);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/ProposalCard.test.tsx apps/web/test/StagePanel.test.tsx apps/web/test/ReviseTab.test.tsx apps/web/test/ProjectPage.test.tsx` → PASS; eslint, typecheck, prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ProposalCard.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/styles/stages.css apps/web/test/ProposalCard.test.tsx apps/web/test/StagePanel.test.tsx
git commit -m "Workbench web: ProposalCard, with NEW/CHANGED tags, diff chips and the applied card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pure outputs comparison (`outputRows`)

**Files:**
- Create: `apps/web/src/workbench/outputRows.ts`
- Test: `apps/web/test/output-rows.test.ts` (create)

**Ruling:** compare client-side rather than through `diffVersions`. The table needs every output's name, type, values and description from both versions anyway (removed outputs are shown from the live version), and `diffVersions` returns generic paths (`outputs.fields[a].type`) that would have to be parsed back. Two `getTemplate` calls give everything.

**Interfaces:**
- Produces:
  - `type VsLive = 'added' | 'changed' | 'removed' | null`
  - `interface OutputRow { kind: 'field' | 'table' | 'column'; id: string; table: string | null; name: string; type: string; values: string; description: string; vsLive: VsLive }`
  - `outputRows(draft: Record<string, unknown>, live: Record<string, unknown> | null): OutputRow[]` — draft fields, then removed live fields, then each table (draft, then removed) followed by its columns (draft, then removed); a column of an added/removed table carries the table's tag.
  - `interface OutputSummary { fields: number; tables: number; columns: number; added: number; changed: number; removed: number }`, `outputSummary(rows: OutputRow[]): OutputSummary` — counts exclude removed rows; tags count fields, tables and columns, except the columns of an added or removed table.
  - `changedRows(rows: OutputRow[]): OutputRow[]` — rows with a tag, plus the table row of any tagged column (context).

- [ ] **Step 1: Write the failing test** — `apps/web/test/output-rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { changedRows, outputRows, outputSummary } from '../src/workbench/outputRows.js';

const LIVE = {
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR'] },
      { id: 'supplier_address', type: 'text' },
    ],
    tables: [
      {
        id: 'line_items',
        name: 'Line items',
        columns: [{ id: 'description' }, { id: 'amount', type: 'decimal' }],
      },
    ],
  },
};
const DRAFT = {
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'due_date', name: 'Due date', type: 'date', description: 'Payment due date' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR', 'USD'] },
    ],
    tables: [
      {
        id: 'line_items',
        name: 'Line items',
        columns: [
          { id: 'description' },
          { id: 'amount', type: 'decimal', description: 'Line total as printed' },
        ],
      },
    ],
  },
};
const brief = (rows: ReturnType<typeof outputRows>) => rows.map((r) => [r.kind, r.id, r.vsLive]);

describe('outputRows', () => {
  it('lists the draft beside the live version, removed outputs included', () => {
    const rows = outputRows(DRAFT, LIVE);
    expect(brief(rows)).toEqual([
      ['field', 'supplier_name', null],
      ['field', 'due_date', 'added'],
      ['field', 'currency', 'changed'],
      ['field', 'supplier_address', 'removed'],
      ['table', 'line_items', null],
      ['column', 'description', null],
      ['column', 'amount', 'changed'],
    ]);
    expect(rows[1]).toEqual({
      kind: 'field',
      id: 'due_date',
      table: null,
      name: 'Due date',
      type: 'date',
      values: '—',
      description: 'Payment due date',
      vsLive: 'added',
    });
    expect(rows[2]).toMatchObject({ name: '—', values: 'GBP, EUR, USD' });
    expect(rows[4]).toMatchObject({ type: 'table', values: '2 columns', name: 'Line items' });
    expect(rows[5]).toMatchObject({ table: 'line_items', type: 'text' });
  });

  it('summarises counts and changes', () => {
    expect(outputSummary(outputRows(DRAFT, LIVE))).toEqual({
      fields: 3,
      tables: 1,
      columns: 2,
      added: 1,
      changed: 2,
      removed: 1,
    });
  });

  it('keeps only changes, with their table for context', () => {
    expect(changedRows(outputRows(DRAFT, LIVE)).map((r) => r.id)).toEqual([
      'due_date',
      'currency',
      'supplier_address',
      'line_items',
      'amount',
    ]);
  });

  it('tags the columns of an added table without counting them twice', () => {
    const draft = {
      outputs: {
        ...DRAFT.outputs,
        tables: [...DRAFT.outputs.tables, { id: 'taxes', columns: [{ id: 'rate' }] }],
      },
    };
    const rows = outputRows(draft, LIVE);
    expect(brief(rows).slice(-2)).toEqual([
      ['table', 'taxes', 'added'],
      ['column', 'rate', 'added'],
    ]);
    expect(outputSummary(rows)).toMatchObject({ tables: 2, columns: 3, added: 2 });
  });

  it('has no tags with nothing published', () => {
    const rows = outputRows(DRAFT, null);
    expect(rows.every((r) => r.vsLive === null)).toBe(true);
    expect(outputSummary(rows)).toMatchObject({ added: 0, changed: 0, removed: 0 });
  });

  it('reads a draft with no outputs', () => {
    expect(outputRows({}, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/output-rows.test.ts` → FAIL.

- [ ] **Step 3: Implement** `apps/web/src/workbench/outputRows.ts`:

```ts
import { stableJson } from '@ih/shared';

export type VsLive = 'added' | 'changed' | 'removed' | null;

export interface OutputRow {
  kind: 'field' | 'table' | 'column';
  id: string;
  /** The table a column belongs to. */
  table: string | null;
  name: string;
  type: string;
  values: string;
  description: string;
  vsLive: VsLive;
}

export interface OutputSummary {
  fields: number;
  tables: number;
  columns: number;
  added: number;
  changed: number;
  removed: number;
}

type Def = Record<string, unknown>;
const obj = (v: unknown): Def => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {});
const list = (v: unknown): Def[] =>
  Array.isArray(v) ? v.map(obj).filter((x) => typeof x.id === 'string') : [];
const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : '—');
const typeOf = (v: Def) => (typeof v.type === 'string' ? v.type : 'text');
const outputsOf = (def: Def) => {
  const o = obj(def.outputs);
  return { fields: list(o.fields), tables: list(o.tables) };
};
const sameValue = (a: Def, b: Def) =>
  stableJson({ name: a.name, type: typeOf(a), description: a.description, enum: a.enum }) ===
  stableJson({ name: b.name, type: typeOf(b), description: b.description, enum: b.enum });
const sameTable = (a: Def, b: Def) =>
  stableJson({ name: a.name, description: a.description }) ===
  stableJson({ name: b.name, description: b.description });

function compare(draft: Def[], live: Def[] | null, same: (a: Def, b: Def) => boolean) {
  if (live === null) return draft.map((item) => ({ item, vsLive: null as VsLive }));
  const byId = new Map(live.map((x) => [x.id, x]));
  const draftIds = new Set(draft.map((x) => x.id));
  return [
    ...draft.map((item) => {
      const old = byId.get(item.id);
      const vsLive: VsLive = old === undefined ? 'added' : same(old, item) ? null : 'changed';
      return { item, vsLive };
    }),
    ...live.filter((x) => !draftIds.has(x.id)).map((item) => ({ item, vsLive: 'removed' as VsLive })),
  ];
}

function valueRow(v: Def, kind: 'field' | 'column', table: string | null, vsLive: VsLive): OutputRow {
  return {
    kind,
    id: String(v.id),
    table,
    name: text(v.name),
    type: typeOf(v),
    values: Array.isArray(v.enum) ? v.enum.join(', ') : '—',
    description: text(v.description),
    vsLive,
  };
}

/** The draft's outputs beside the live version's (null: nothing published yet). */
export function outputRows(draft: Def, live: Def | null): OutputRow[] {
  const d = outputsOf(draft);
  const l = live === null ? null : outputsOf(live);
  const fields = compare(d.fields, l?.fields ?? null, sameValue).map(({ item, vsLive }) =>
    valueRow(item, 'field', null, vsLive),
  );
  const tables = compare(d.tables, l?.tables ?? null, sameTable).flatMap(({ item, vsLive }) => {
    const id = String(item.id);
    const whole = vsLive === 'added' || vsLive === 'removed';
    const liveColumns =
      whole || l === null ? null : list(l.tables.find((t) => t.id === id)?.columns);
    const columns = compare(list(item.columns), liveColumns, sameValue).map((c) =>
      valueRow(c.item, 'column', id, whole ? vsLive : c.vsLive),
    );
    const row: OutputRow = {
      kind: 'table',
      id,
      table: null,
      name: text(item.name),
      type: 'table',
      values: `${list(item.columns).length} columns`,
      description: text(item.description),
      vsLive,
    };
    return [row, ...columns];
  });
  return [...fields, ...tables];
}

export function outputSummary(rows: OutputRow[]): OutputSummary {
  const tableTag = new Map(rows.filter((r) => r.kind === 'table').map((r) => [r.id, r.vsLive]));
  const present = rows.filter((r) => r.vsLive !== 'removed');
  const counted = rows.filter((r) => {
    if (r.kind !== 'column') return true;
    const parent = tableTag.get(r.table ?? '');
    return parent !== 'added' && parent !== 'removed';
  });
  const count = (xs: OutputRow[], f: (r: OutputRow) => boolean) => xs.filter(f).length;
  return {
    fields: count(present, (r) => r.kind === 'field'),
    tables: count(present, (r) => r.kind === 'table'),
    columns: count(present, (r) => r.kind === 'column'),
    added: count(counted, (r) => r.vsLive === 'added'),
    changed: count(counted, (r) => r.vsLive === 'changed'),
    removed: count(counted, (r) => r.vsLive === 'removed'),
  };
}

/** "Changed since vN": tagged rows, plus the table of a tagged column. */
export function changedRows(rows: OutputRow[]): OutputRow[] {
  return rows.filter(
    (r) =>
      r.vsLive !== null ||
      (r.kind === 'table' && rows.some((c) => c.table === r.id && c.vsLive !== null)),
  );
}
```

- [ ] **Step 4: Run** the test → PASS; eslint, typecheck, prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/outputRows.ts apps/web/test/output-rows.test.ts
git commit -m "Workbench web: compare the draft's outputs with the live version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Pure Steps derivations (`steps.ts`)

**Files:**
- Create: `apps/web/src/workbench/steps.ts`
- Test: `apps/web/test/steps-derive.test.ts` (create)

**Interfaces:**
- Consumes: `OutputCoverage` (Task 1), `TemplateMetrics` (`apps/web/src/api/client.ts`). Step kinds are `extract` and `check` (`StepSchema` in `packages/shared/src/template.ts`).
- Produces:
  - `RETRY_WARN_ATTEMPTS = 1.5` — average attempts per run at which a step's attempts figure turns warn and its card explains retries (with the default `maxAttempts: 2`, 1.5 means at least half the runs needed a retry).
  - `type StepMetric = TemplateMetrics['steps'][number]`
  - `interface StepCard { number: number; id: string; kind: 'EXTRACT' | 'CHECK'; model: string | null; fills: string[]; reads: string[]; chunkPages: number | null; compares: string | null }`
  - `stepCards(definition: Record<string, unknown>): StepCard[]`, `sectionIds(definition): string[]`, `outputsLine(definition): string`
  - `coverageHeadline(now: OutputCoverage, after: OutputCoverage | null): { tone: 'ok' | 'warn'; text: string }`
  - `stepFigures(m: StepMetric | undefined): { runs: string; failed: string; attempts: string; avgTime: string; failedWarn: boolean; attemptsWarn: boolean } | null`
  - `retryWarning(m: StepMetric | undefined): string | null`

- [ ] **Step 1: Write the failing test** — `apps/web/test/steps-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { OutputCoverage } from '@ih/shared';
import {
  coverageHeadline,
  outputsLine,
  RETRY_WARN_ATTEMPTS,
  retryWarning,
  sectionIds,
  stepCards,
  stepFigures,
} from '../src/workbench/steps.js';

const DEF = {
  document: { sections: [{ id: 'header' }, { id: 'line_items' }, { id: 'totals' }] },
  outputs: {
    fields: [{ id: 'supplier_name' }, { id: 'invoice_date' }],
    tables: [{ id: 'line_items', columns: [{ id: 'amount' }] }],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['supplier_name', 'invoice_date'], sections: ['header'] },
    {
      type: 'extract',
      id: 'line_items',
      table: 'line_items',
      sections: ['line_items'],
      chunkPages: 3,
      model: 'local/qwen3.8-27b-mtp',
    },
    { type: 'check', id: 'totals-match', values: 'line_items.amount', reference: 'subtotal' },
  ],
};

describe('stepCards', () => {
  it('numbers the steps and says what each fills and reads', () => {
    expect(stepCards(DEF)).toEqual([
      {
        number: 1,
        id: 'header',
        kind: 'EXTRACT',
        model: 'default',
        fills: ['supplier_name', 'invoice_date'],
        reads: ['header'],
        chunkPages: null,
        compares: null,
      },
      {
        number: 2,
        id: 'line_items',
        kind: 'EXTRACT',
        model: 'local/qwen3.8-27b-mtp',
        fills: ['line_items'],
        reads: ['line_items'],
        chunkPages: 3,
        compares: null,
      },
      {
        number: 3,
        id: 'totals-match',
        kind: 'CHECK',
        model: null,
        fills: [],
        reads: [],
        chunkPages: null,
        compares: 'line_items.amount = subtotal',
      },
    ]);
    expect(stepCards({})).toEqual([]);
  });

  it('lists the sections and the outputs line', () => {
    expect(sectionIds(DEF)).toEqual(['header', 'line_items', 'totals']);
    expect(outputsLine(DEF)).toBe('Outputs: 2 fields · line_items');
    expect(outputsLine({ outputs: { fields: [{ id: 'a' }] } })).toBe('Outputs: 1 field');
  });
});

const cov = (uncovered: string[], multiple: string[] = []): OutputCoverage => ({
  outputs: [],
  uncovered,
  multiple,
});

describe('coverageHeadline', () => {
  it.each<[OutputCoverage, OutputCoverage | null, { tone: 'ok' | 'warn'; text: string }]>([
    [cov([]), null, { tone: 'ok', text: 'Every output is filled by exactly one step' }],
    [cov([], ['total']), null, { tone: 'warn', text: '1 output is filled by more than one step' }],
    [cov(['due_date']), null, { tone: 'warn', text: '1 output not filled by any step' }],
    [
      cov(['due_date']),
      cov([]),
      { tone: 'warn', text: '1 output not filled by any step — the proposal fixes it' },
    ],
    [
      cov(['a', 'b']),
      cov([]),
      { tone: 'warn', text: '2 outputs not filled by any step — the proposal fixes them' },
    ],
    [
      cov(['a', 'b']),
      cov(['b']),
      { tone: 'warn', text: '2 outputs not filled by any step — the proposal fixes 1' },
    ],
    [
      cov(['a']),
      cov(['a']),
      { tone: 'warn', text: '1 output not filled by any step — the proposal does not fix it' },
    ],
  ])('%#', (now, after, expected) => {
    expect(coverageHeadline(now, after)).toEqual(expected);
  });
});

const metric = (avgAttempts: number, failures = 0, avgSeconds: number | null = 6) => ({
  stepId: 's',
  runs: 18,
  reruns: 0,
  failures,
  avgAttempts,
  avgOutputTokens: null,
  avgSeconds,
});

describe('step figures', () => {
  it('formats the figures and flags failures and retries', () => {
    expect(stepFigures(metric(1.1))).toEqual({
      runs: '18',
      failed: '0',
      attempts: '1.1',
      avgTime: '6 s',
      failedWarn: false,
      attemptsWarn: false,
    });
    expect(stepFigures(metric(2, 1, null))).toEqual({
      runs: '18',
      failed: '1',
      attempts: '2.0',
      avgTime: '—',
      failedWarn: true,
      attemptsWarn: true,
    });
    expect(stepFigures(undefined)).toBeNull();
  });

  it('explains a step that keeps retrying, in plain words', () => {
    expect(retryWarning(metric(1.4))).toBeNull();
    expect(retryWarning(undefined)).toBeNull();
    expect(retryWarning(metric(RETRY_WARN_ATTEMPTS))).toBe(
      'Needs a retry on many runs (1.5 attempts on average): the first answer often fails the checks. Narrow the sections it reads or add instructions on the Template tab.',
    );
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/steps-derive.test.ts` → FAIL.

- [ ] **Step 3: Implement** `apps/web/src/workbench/steps.ts`:

```ts
import type { OutputCoverage } from '@ih/shared';
import type { TemplateMetrics } from '../api/client.js';

/** Average attempts per run at which a step's figures turn warn and its card explains retries. */
export const RETRY_WARN_ATTEMPTS = 1.5;

export type StepMetric = TemplateMetrics['steps'][number];

export interface StepCard {
  number: number;
  id: string;
  kind: 'EXTRACT' | 'CHECK';
  /** Extract steps: the model ref (`default` when unset); check steps call no model. */
  model: string | null;
  fills: string[];
  reads: string[];
  chunkPages: number | null;
  /** Check steps: "values = reference". */
  compares: string | null;
}

type Def = Record<string, unknown>;
const obj = (v: unknown): Def => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {});
const list = (v: unknown): Def[] => (Array.isArray(v) ? v.map(obj) : []);
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The draft's pipeline as the Steps tab's cards, numbered in order. */
export function stepCards(definition: Def): StepCard[] {
  return list(definition.pipeline)
    .filter((s): s is Def & { id: string } => typeof s.id === 'string')
    .map((s, i) =>
      s.type === 'check'
        ? {
            number: i + 1,
            id: s.id,
            kind: 'CHECK' as const,
            model: null,
            fills: [],
            reads: [],
            chunkPages: null,
            compares: `${String(s.values)} = ${String(s.reference)}`,
          }
        : {
            number: i + 1,
            id: s.id,
            kind: 'EXTRACT' as const,
            model: typeof s.model === 'string' ? s.model : 'default',
            fills: typeof s.table === 'string' ? [s.table] : ids(s.fields),
            reads: ids(s.sections),
            chunkPages: typeof s.chunkPages === 'number' ? s.chunkPages : null,
            compares: null,
          },
    );
}

export function sectionIds(definition: Def): string[] {
  return ids(list(obj(definition.document).sections).map((s) => s.id));
}

/** The pipeline's last line: "Outputs: 9 fields · line_items". */
export function outputsLine(definition: Def): string {
  const outputs = obj(definition.outputs);
  const tables = ids(list(outputs.tables).map((t) => t.id));
  return [`Outputs: ${plural(list(outputs.fields).length, 'field')}`, ...tables].join(' · ');
}

/** The coverage strip's headline; `after` is the coverage with the selected changes applied. */
export function coverageHeadline(
  now: OutputCoverage,
  after: OutputCoverage | null,
): { tone: 'ok' | 'warn'; text: string } {
  const n = now.uncovered.length;
  if (n === 0) {
    return now.multiple.length === 0
      ? { tone: 'ok', text: 'Every output is filled by exactly one step' }
      : {
          tone: 'warn',
          text: `${plural(now.multiple.length, 'output')} ${now.multiple.length === 1 ? 'is' : 'are'} filled by more than one step`,
        };
  }
  const base = `${plural(n, 'output')} not filled by any step`;
  if (after === null) return { tone: 'warn', text: base };
  const fixed = now.uncovered.filter((id) => !after.uncovered.includes(id)).length;
  const them = n === 1 ? 'it' : 'them';
  const tail =
    fixed === n
      ? `the proposal fixes ${them}`
      : fixed > 0
        ? `the proposal fixes ${fixed}`
        : `the proposal does not fix ${them}`;
  return { tone: 'warn', text: `${base} — ${tail}` };
}

export function stepFigures(m: StepMetric | undefined) {
  if (!m) return null;
  return {
    runs: String(m.runs),
    failed: String(m.failures),
    attempts: m.avgAttempts.toFixed(1),
    avgTime: m.avgSeconds === null ? '—' : `${Math.round(m.avgSeconds)} s`,
    failedWarn: m.failures > 0,
    attemptsWarn: m.avgAttempts >= RETRY_WARN_ATTEMPTS,
  };
}

export function retryWarning(m: StepMetric | undefined): string | null {
  if (!m || m.runs === 0 || m.avgAttempts < RETRY_WARN_ATTEMPTS) return null;
  return `Needs a retry on many runs (${m.avgAttempts.toFixed(1)} attempts on average): the first answer often fails the checks. Narrow the sections it reads or add instructions on the Template tab.`;
}
```

- [ ] **Step 4: Run** the test → PASS; eslint, typecheck, prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/steps.ts apps/web/test/steps-derive.test.ts
git commit -m "Workbench web: step cards, coverage headline and per-step figures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Outputs tab — definitions, banners, summary chips, outputs table

**Files:**
- Create: `apps/web/src/workbench/useDefinitions.ts`, `apps/web/src/workbench/OutputsView.tsx`
- Modify: `apps/web/src/workbench/StagePanel.tsx`, `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/OutputsTab.test.tsx` (create), `apps/web/test/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 4, 5; `api.getTemplate(id, version)` → `TemplateRecordView.record.definition`; `Segmented`.
- Produces:
  - `useDefinitions(api: Api, projectId: string, draft: number | null, published: number | null, enabled: boolean): { draftDef: Record<string, unknown> | null; liveDef: Record<string, unknown> | null; error: string | null; reload: () => Promise<Record<string, unknown> | null> }`
  - `OutputsView({ draftVersion, liveVersion, draftDef, liveDef }: { draftVersion: number; liveVersion: number | null; draftDef: Record<string, unknown>; liveDef: Record<string, unknown> | null })`
  - `StagePanel` gains optional `draft?: number | null`, `published?: number | null`, `briefVersion?: number | null`. Definitions load only for `outputs`/`steps` when `draft` is a number (existing callers and tests that omit it are unchanged).
  - `TabHeader` description per stage (`DESCRIPTION`).

- [ ] **Step 1: Write the failing tests** — `apps/web/test/OutputsTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, templateView } from './fake-api.js';

const LIVE = {
  id: 'letter',
  version: 3,
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR'] },
      { id: 'supplier_address', type: 'text' },
    ],
    tables: [{ id: 'line_items', columns: [{ id: 'description' }, { id: 'amount' }] }],
  },
};
const DRAFT = {
  id: 'letter',
  version: 4,
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'due_date', type: 'date' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR', 'USD'] },
    ],
    tables: [
      {
        id: 'line_items',
        columns: [{ id: 'description' }, { id: 'amount', description: 'Line total' }],
      },
    ],
  },
};

function outputsPanel(
  overrides: Partial<Api> = {},
  props: Partial<Parameters<typeof StagePanel>[0]> = {},
) {
  const api = fakeApi({
    listProposals: vi.fn(async () => [
      changeProposalView({ status: 'accepted', acceptedChanges: [0, 1], briefVersion: 3 }),
    ]),
    getTemplate: vi.fn(async (_id: string, version: number) =>
      version === 4 ? templateView(DRAFT) : templateView(LIVE, 'published'),
    ),
    ...overrides,
  });
  render(
    <StagePanel
      api={api}
      projectId="letter"
      stage="outputs"
      title="Outputs"
      dataPolicy="local"
      hasDraft
      draft={4}
      published={3}
      briefVersion={3}
      pollMs={1}
      onApplied={vi.fn()}
      onSkipped={vi.fn()}
      {...props}
    />,
  );
  return api;
}

describe('Outputs tab', () => {
  it('summarises the draft outputs against the live version', async () => {
    const api = outputsPanel();
    expect(await screen.findByText('3 fields')).toBeInTheDocument();
    expect(api.getTemplate).toHaveBeenCalledWith('letter', 4);
    expect(api.getTemplate).toHaveBeenCalledWith('letter', 3);
    expect(screen.getByText('1 table · 2 columns')).toBeInTheDocument();
    expect(screen.getByText('+1 added')).toBeInTheDocument();
    expect(screen.getByText('~2 changed')).toBeInTheDocument();
    expect(screen.getByText('−1 removed')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Outputs in draft v4' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Compared with live v3')).toBeInTheDocument();
  });

  it('tags each output against live, with removed outputs struck through', async () => {
    outputsPanel();
    const added = await screen.findByRole('row', { name: /due_date/ });
    expect(within(added).getByText('+ ADDED')).toBeInTheDocument();
    const removed = screen.getByRole('row', { name: /supplier_address/ });
    expect(within(removed).getByText('− REMOVED')).toBeInTheDocument();
    expect(removed).toHaveClass('removed');
    expect(screen.getByRole('columnheader', { name: 'vs v3' })).toBeInTheDocument();
  });

  it('filters to the outputs changed since live', async () => {
    outputsPanel();
    await screen.findByRole('row', { name: /due_date/ });
    await userEvent.click(screen.getByRole('button', { name: 'Changed since v3' }));
    expect(screen.queryByRole('row', { name: /supplier_name/ })).toBeNull();
    expect(screen.getByRole('row', { name: /line_items/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /amount/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /description/ })).toBeNull();
  });

  it('has no comparison before the first publish', async () => {
    outputsPanel({}, { published: null });
    expect(await screen.findByText('3 fields')).toBeInTheDocument();
    expect(screen.queryByText(/added$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Changed since/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /^vs v/ })).toBeNull();
  });

  it('says when the proposal used an older brief', async () => {
    outputsPanel(
      {
        listProposals: vi.fn(async () => [changeProposalView({ briefVersion: 2 })]),
      },
      { briefVersion: 3 },
    );
    expect(await screen.findByRole('note')).toHaveTextContent(
      'This proposal used brief v2; the brief is now v3.',
    );
  });

  it('names what changed when the stage is stale', async () => {
    outputsPanel(
      {},
      {
        item: {
          stage: 'outputs',
          state: 'stale',
          status: 'Stale — Survey changed after it was accepted',
          metrics: [],
        },
      },
    );
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Stale — Survey changed after it was accepted.',
    );
  });

  it('keeps the proposal when the draft cannot be loaded', async () => {
    outputsPanel({
      getTemplate: vi.fn(async () => {
        throw new Error('store down');
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load draft v4: store down');
    expect(screen.getByRole('region', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('says what the tab does', async () => {
    outputsPanel();
    expect(
      await screen.findByText(
        'The fields and tables every document of this type produces. The model proposes them from the brief and survey; you choose which to apply.',
      ),
    ).toBeInTheDocument();
  });
});
```

In `apps/web/test/ProjectPage.test.tsx` (the `ProjectPage` describe) add:

```tsx
  it('loads the draft and live definitions on the Outputs tab', async () => {
    const getTemplate = vi.fn(async (_id: string, version: number) =>
      templateView({ id: 'letter', version, outputs: { fields: [], tables: [] } }),
    );
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ draft: 2, published: 1 })),
      getTemplate,
    });
    render(
      <ProjectPage api={api} projectId="letter" tab="outputs" onNavigate={vi.fn()} pollMs={60_000} role="admin" />,
    );
    await waitFor(() => expect(getTemplate).toHaveBeenCalledWith('letter', 2));
    expect(getTemplate).toHaveBeenCalledWith('letter', 1);
  });
```

(add `templateView` to the `./fake-api.js` import).

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/OutputsTab.test.tsx apps/web/test/ProjectPage.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/workbench/useDefinitions.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api/client.js';

type Def = Record<string, unknown>;

/** The open draft's definition and, when given, the live (published) one; reload after applying. */
export function useDefinitions(
  api: Api,
  projectId: string,
  draft: number | null,
  published: number | null,
  enabled: boolean,
) {
  const [draftDef, setDraftDef] = useState<Def | null>(null);
  const [liveDef, setLiveDef] = useState<Def | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<Def | null> => {
    if (!enabled || draft === null) return null;
    try {
      const [d, l] = await Promise.all([
        api.getTemplate(projectId, draft),
        published === null ? Promise.resolve(null) : api.getTemplate(projectId, published),
      ]);
      setDraftDef(d.record.definition);
      setLiveDef(l?.record.definition ?? null);
      setError(null);
      return d.record.definition;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [api, projectId, draft, published, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { draftDef, liveDef, error, reload };
}
```

`apps/web/src/workbench/OutputsView.tsx`:

```tsx
import { useId, useState } from 'react';
import { Segmented } from '../ui/Segmented.js';
import { changedRows, outputRows, outputSummary, type VsLive } from './outputRows.js';

const VS_LABEL: Record<Exclude<VsLive, null>, string> = {
  added: '+ ADDED',
  changed: '~ CHANGED',
  removed: '− REMOVED',
};
const VS_TONE: Record<Exclude<VsLive, null>, string> = {
  added: 'ok',
  changed: 'info',
  removed: 'danger',
};

/** Handoff §4: summary chips and the draft's outputs compared with the live version. */
export function OutputsView({
  draftVersion,
  liveVersion,
  draftDef,
  liveDef,
}: {
  draftVersion: number;
  liveVersion: number | null;
  draftDef: Record<string, unknown>;
  liveDef: Record<string, unknown> | null;
}) {
  const headingId = useId();
  const [filter, setFilter] = useState<'all' | 'changed'>('all');
  const compared = liveVersion !== null && liveDef !== null;
  const rows = outputRows(draftDef, compared ? liveDef : null);
  const s = outputSummary(rows);
  const shown = compared && filter === 'changed' ? changedRows(rows) : rows;
  return (
    <>
      <ul className="summary-chips" aria-label="Outputs summary">
        <li className="tone-neutral">
          {s.fields} {s.fields === 1 ? 'field' : 'fields'}
        </li>
        <li className="tone-neutral">
          {s.tables} {s.tables === 1 ? 'table' : 'tables'} · {s.columns}{' '}
          {s.columns === 1 ? 'column' : 'columns'}
        </li>
        {compared && (
          <>
            <li className="tone-ok">+{s.added} added</li>
            <li className="tone-info">~{s.changed} changed</li>
            <li className="tone-danger">−{s.removed} removed</li>
          </>
        )}
      </ul>
      <section className="card outputs-card" aria-labelledby={headingId}>
        <header className="outputs-card-head">
          <h3 id={headingId}>Outputs in draft v{draftVersion}</h3>
          {compared && <span className="muted">Compared with live v{liveVersion}</span>}
          {compared && (
            <Segmented
              label="Show outputs"
              options={[
                { value: 'all', label: 'All outputs' },
                { value: 'changed', label: `Changed since v${liveVersion}` },
              ]}
              value={filter}
              onChange={setFilter}
            />
          )}
        </header>
        <div className="outputs-scroll">
          <table className="outputs-table">
            <thead>
              <tr>
                {compared && <th scope="col">vs v{liveVersion}</th>}
                <th scope="col">Id</th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Values</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={`${r.table ?? ''}/${r.kind}/${r.id}`}
                  className={r.vsLive === 'removed' ? 'removed' : undefined}
                >
                  {compared && (
                    <td>
                      {r.vsLive && (
                        <span className={`kind-tag tone-${VS_TONE[r.vsLive]}`}>{VS_LABEL[r.vsLive]}</span>
                      )}
                    </td>
                  )}
                  <td className={r.kind === 'column' ? 'output-id output-column' : 'output-id'}>
                    {r.kind === 'table' && <span className="kind-tag tone-ok">TABLE</span>}
                    <code>{r.id}</code>
                  </td>
                  <td className="output-name">{r.name}</td>
                  <td>
                    <code className="type-chip">{r.type}</code>
                  </td>
                  <td>{r.values}</td>
                  <td>{r.description}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={compared ? 6 : 5} className="muted">
                    {compared ? `Nothing changed since v${liveVersion}.` : 'No outputs yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
```

(Ruling: the screenshot's per-row pencil is left out — edits by hand stay on the Template tab, linked from the card footer.)

`StagePanel.tsx`:
- New imports: `useDefinitions`, `OutputsView`, `StaleBanner`.
- New props (destructure with defaults `draft`, `published = null`, `briefVersion = null`):

```ts
  /** Outputs/Steps: the open draft and live versions shown beside the proposal; omit to hide. */
  draft?: number | null;
  published?: number | null;
  /** The project's current brief version (stale-proposal banner). */
  briefVersion?: number | null;
```

- Descriptions (above the component):

```ts
const DESCRIPTION: Record<ChangeStage, string | undefined> = {
  outputs:
    'The fields and tables every document of this type produces. The model proposes them from the brief and survey; you choose which to apply.',
  sections:
    'Where each section of the text starts. The model proposes anchors from the dev samples; you choose which to apply.',
  steps:
    'Each step sends some sections of the text to a model and fills some outputs; check steps compare values.',
  revise: undefined,
};
```

  and pass `description={DESCRIPTION[stage]}` to both `TabHeader` renders.

- After the existing state hooks:

```ts
  const showsDefinition = (stage === 'outputs' || stage === 'steps') && typeof draft === 'number';
  const definitions = useDefinitions(
    api,
    projectId,
    typeof draft === 'number' ? draft : null,
    stage === 'outputs' ? published : null,
    showsDefinition,
  );
  const draftDef = showsDefinition ? definitions.draftDef : null;
```

- In `accept`, reload after the decision (Task 8 extends this):

```ts
      setProposal(await api.decideProposal(projectId, proposal.id, 'accepted', chosen));
      onApplied();
      await definitions.reload();
```

- Pass `definition={draftDef}` and `draftVersion={typeof draft === 'number' ? draft : null}` to `ProposalCard`, and assign it to `const card = body && proposal ? <ProposalCard … /> : null;` instead of rendering inline.
- Banners and body, replacing `{card}`'s place after the `message` line:

```tsx
      {title !== undefined && item?.state === 'stale' && (
        <StaleBanner>
          {item.status}. Propose again to draft from the latest information; the draft keeps what you
          applied until you apply new changes.
        </StaleBanner>
      )}
      {title !== undefined &&
        proposal?.briefVersion != null &&
        briefVersion !== null &&
        briefVersion > proposal.briefVersion && (
          <StaleBanner tone="info">
            This proposal used brief v{proposal.briefVersion}; the brief is now v{briefVersion}.
            Propose again to draft from the latest brief; what you applied stays in the draft until
            you apply new changes.
          </StaleBanner>
        )}
      {showsDefinition && definitions.error && (
        <p role="alert">
          Could not load draft v{draft}: {definitions.error}
        </p>
      )}
      {stage === 'outputs' && draftDef && typeof draft === 'number' ? (
        <>
          {proposal?.status === 'ready' && card}
          <OutputsView
            draftVersion={draft}
            liveVersion={definitions.liveDef ? published : null}
            draftDef={draftDef}
            liveDef={definitions.liveDef}
          />
          {proposal?.status !== 'ready' && card}
        </>
      ) : (
        card
      )}
```

  (`proposal?.briefVersion != null` follows `ProposalView.briefVersion: number | null` with an absent proposal; if eslint's `eqeqeq` rejects `!= null`, write `proposal !== null && proposal !== undefined && proposal.briefVersion !== null`.)

`ProjectPage.tsx`: for the `outputs`/`steps` `StagePanel` change `key={`${tab}-${revision}`}` to `key={tab}` (the panel reloads the definitions itself after an apply, and keeping it mounted keeps JUST ADDED; see Review Focus 3) and add

```tsx
              draft={draft}
              published={published}
              briefVersion={view.brief?.version ?? null}
```

  For the `sections` `StagePanel` add only `briefVersion={view.brief?.version ?? null}` (no definitions on Sections in this PR; it keeps its `revision` key).

`stages.css` (append):

```css
.summary-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}
.summary-chips li {
  padding: 3px 10px;
  border-radius: var(--ih-radius-pill);
  font-size: var(--ih-text-sm);
  font-weight: 600;
}
.outputs-card {
  margin-bottom: 16px;
  padding: 0;
  overflow: hidden;
}
.outputs-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--ih-border);
}
.outputs-card-head h3 {
  margin: 0;
  font-size: var(--ih-text-md);
}
.outputs-card-head .segmented {
  margin-left: auto;
}
.outputs-scroll {
  overflow-x: auto;
}
.outputs-table {
  width: 100%;
  border-collapse: collapse;
}
.outputs-table th,
.outputs-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--ih-border-soft);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.outputs-table th {
  color: var(--ih-muted);
  font-size: var(--ih-text-sm);
  font-weight: 500;
}
.output-id .kind-tag {
  margin-right: 6px;
}
.output-column {
  padding-left: 36px !important;
}
.type-chip {
  padding: 1px 6px;
  border-radius: var(--ih-radius-sm);
  background: var(--ih-neutral-bg);
  color: var(--ih-neutral-fg);
}
.outputs-table tr.removed {
  background: var(--ih-danger-bg);
}
.outputs-table tr.removed .output-id code,
.outputs-table tr.removed .output-name {
  text-decoration: line-through;
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/OutputsTab.test.tsx apps/web/test/StagePanel.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/test/ReviseTab.test.tsx` → PASS; eslint, typecheck, prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/useDefinitions.ts apps/web/src/workbench/OutputsView.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/OutputsTab.test.tsx apps/web/test/ProjectPage.test.tsx
git commit -m "Workbench web: Outputs tab compares the draft with the live version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Steps tab — coverage strip, pipeline, figures, JUST ADDED

**Files:**
- Create: `apps/web/src/workbench/StepsView.tsx`
- Modify: `apps/web/src/workbench/StagePanel.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/StepsTab.test.tsx` (create)

**Interfaces:**
- Consumes: `outputCoverage`, `applyChanges` (`@ih/shared`); Task 6 (`stepCards`, `sectionIds`, `outputsLine`, `coverageHeadline`, `stepFigures`, `retryWarning`, `StepMetric`); `SectionChip` (Task 2); `api.getMetrics(projectId).steps`.
- Produces: `StepsView({ projectId, draftVersion, definition, after, metrics, justAdded, card }: { projectId: string; draftVersion: number; definition: Record<string, unknown>; after: Record<string, unknown> | null; metrics: StepMetric[] | null; justAdded: ReadonlySet<string>; card: ReactNode })`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/StepsTab.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, templateView } from './fake-api.js';

const BEFORE = {
  id: 'letter',
  version: 4,
  name: 'Letter',
  document: {
    sections: [
      { id: 'header', anchor: '^INVOICE' },
      { id: 'totals', anchor: 'Total' },
      { id: 'payment', anchor: 'Pay' },
    ],
  },
  outputs: {
    fields: [{ id: 'supplier_name' }, { id: 'due_date', type: 'date' }, { id: 'total' }],
    tables: [],
  },
  pipeline: [
    { type: 'extract', id: 'header', fields: ['supplier_name'], sections: ['header'] },
    { type: 'extract', id: 'totals', fields: ['total'], sections: ['totals', 'payment'] },
  ],
};
const HEADER = {
  type: 'extract',
  id: 'header',
  fields: ['supplier_name', 'due_date'],
  sections: ['header'],
};
const CHECK = { type: 'check', id: 'totals-match', values: 'total', reference: 'total' };
const AFTER = { ...BEFORE, pipeline: [HEADER, BEFORE.pipeline[1], CHECK] };
const PROPOSAL = changeProposalView({
  stage: 'steps',
  body: {
    notes: 'Adds due_date to the header step.',
    changes: [
      { op: 'putStep', reason: 'due_date has no step', step: HEADER },
      { op: 'putStep', reason: 'Catches dropped lines', step: CHECK },
    ] as unknown as DraftChange[],
  },
});
const METRICS = {
  templateId: 'letter',
  versions: [],
  topEdited: [],
  steps: [
    { stepId: 'header', runs: 18, reruns: 0, failures: 0, avgAttempts: 1.1, avgOutputTokens: null, avgSeconds: 6 },
    { stepId: 'totals', runs: 18, reruns: 0, failures: 0, avgAttempts: 2, avgOutputTokens: null, avgSeconds: 5 },
  ],
};

function stepsPanel(metrics = METRICS) {
  let current: Record<string, unknown> = BEFORE;
  const api = fakeApi({
    listProposals: vi.fn(async () => [PROPOSAL]),
    getTemplate: vi.fn(async () => templateView(current)),
    getMetrics: vi.fn(async () => metrics),
    decideProposal: vi.fn(async () => {
      current = AFTER;
      return { ...PROPOSAL, status: 'accepted' as const, acceptedChanges: [0, 1] };
    }),
  });
  render(
    <StagePanel
      api={api}
      projectId="letter"
      stage="steps"
      title="Extraction steps"
      dataPolicy="local"
      hasDraft
      draft={4}
      published={null}
      pollMs={1}
      onApplied={vi.fn()}
      onSkipped={vi.fn()}
    />,
  );
  return api;
}

describe('Steps tab', () => {
  it('shows which step fills each output and whether the proposal fixes the gaps', async () => {
    stepsPanel();
    expect(
      await screen.findByText('1 output not filled by any step — the proposal fixes it'),
    ).toBeInTheDocument();
    const gap = screen.getByText(': not filled by any step').closest('li')!;
    expect(gap).toHaveAttribute('data-tone', 'warn');
    expect(within(gap).getByText('due_date')).toBeInTheDocument();
    expect(screen.getByText(': step 1').closest('li')).toHaveTextContent('supplier_name');
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Apply: Extract step header: supplier_name, due_date from header',
      }),
    );
    expect(
      screen.getByText('1 output not filled by any step — the proposal does not fix it'),
    ).toBeInTheDocument();
  });

  it('draws the pipeline with sections, figures and a retry warning', async () => {
    stepsPanel();
    expect(await screen.findByText('Prepared text, split into 3 sections')).toBeInTheDocument();
    const totals = screen.getByRole('listitem', { name: 'Step 2: totals' });
    expect(within(totals).getByText('EXTRACT')).toBeInTheDocument();
    expect(within(totals).getByText('default')).toBeInTheDocument();
    expect(within(totals).getByText('payment')).toBeInTheDocument();
    expect(within(totals).getByText('2.0')).toBeInTheDocument();
    expect(within(totals).getByText(/^Needs a retry on many runs/)).toBeInTheDocument();
    const header = screen.getByRole('listitem', { name: 'Step 1: header' });
    expect(within(header).getByText('1.1')).toBeInTheDocument();
    expect(within(header).queryByText(/Needs a retry/)).toBeNull();
    expect(screen.getByText('Outputs: 3 fields')).toBeInTheDocument();
  });

  it('marks the steps the proposal added and turns coverage green once applied', async () => {
    const api = stepsPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Apply 2 selected changes' }));
    expect(api.decideProposal).toHaveBeenCalledWith('letter', PROPOSAL.id, 'accepted', [0, 1]);
    const added = await screen.findByRole('listitem', { name: 'Step 3: totals-match' });
    expect(within(added).getByText('JUST ADDED')).toBeInTheDocument();
    expect(within(added).getByText('CHECK')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Step 1: header' })).queryByText('JUST ADDED'),
    ).toBeNull();
    expect(screen.getByText('Every output is filled by exactly one step')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: '2 of 2 changes applied to draft v4' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run on dev samples' })).toHaveAttribute(
      'href',
      '#/workbench/letter/runs',
    );
  });

  it('says when a step has no runs yet', async () => {
    stepsPanel({ ...METRICS, steps: [METRICS.steps[0]!] });
    const totals = await screen.findByRole('listitem', { name: 'Step 2: totals' });
    expect(within(totals).getByText('No runs yet.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('listitem', { name: 'Step 1: header' })).queryByText('No runs yet.'),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/StepsTab.test.tsx` → FAIL.

- [ ] **Step 3: Implement** `apps/web/src/workbench/StepsView.tsx`:

```tsx
import { useId, type ReactNode } from 'react';
import { outputCoverage } from '@ih/shared';
import { TONE_COLOR } from '../ui/stageStyle.js';
import {
  coverageHeadline,
  outputsLine,
  retryWarning,
  sectionIds,
  stepCards,
  stepFigures,
  type StepCard,
  type StepMetric,
} from './steps.js';
import { SectionChip } from './tags.js';

function Figures({ metric }: { metric: StepMetric | undefined }) {
  const f = stepFigures(metric);
  if (!f) return <p className="muted step-none">No runs yet.</p>;
  const warning = retryWarning(metric);
  return (
    <>
      <dl className="step-figures">
        <div>
          <dt>Runs</dt>
          <dd>{f.runs}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd data-tone={f.failedWarn ? 'warn' : undefined}>{f.failed}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd data-tone={f.attemptsWarn ? 'warn' : undefined}>{f.attempts}</dd>
        </div>
        <div>
          <dt>Avg time</dt>
          <dd>{f.avgTime}</dd>
        </div>
      </dl>
      {warning && <p className="step-warning">{warning}</p>}
    </>
  );
}

function Step({
  card,
  sections,
  metric,
  justAdded,
}: {
  card: StepCard;
  sections: string[];
  metric: StepMetric | undefined;
  justAdded: boolean;
}) {
  return (
    <li
      className={justAdded ? 'step-card just-added' : 'step-card'}
      aria-label={`Step ${card.number}: ${card.id}`}
    >
      <div className="step-head">
        <span className="step-number" aria-hidden="true">
          {card.number}
        </span>
        <span className={`kind-tag tone-${card.kind === 'EXTRACT' ? 'info' : 'neutral'}`}>
          {card.kind}
        </span>
        <code className="step-id">{card.id}</code>
        {justAdded && <span className="kind-tag tone-ok">JUST ADDED</span>}
        {card.model && <code className="step-model muted">{card.model}</code>}
      </div>
      {card.kind === 'EXTRACT' ? (
        <>
          <dl className="step-facts">
            <dt>Fills</dt>
            <dd>
              {card.fills.map((f) => (
                <code key={f} className="fill-chip">
                  {f}
                </code>
              ))}
            </dd>
            <dt>Reads</dt>
            <dd>
              {card.reads.map((s) => (
                <SectionChip key={s} id={s} index={sections.indexOf(s)} />
              ))}
              {card.chunkPages !== null && (
                <span className="muted">
                  {' '}
                  · {card.chunkPages} {card.chunkPages === 1 ? 'page' : 'pages'} per call
                </span>
              )}
            </dd>
          </dl>
          <Figures metric={metric} />
        </>
      ) : (
        <>
          <dl className="step-facts">
            <dt>Checks</dt>
            <dd>
              <code className="fill-chip">{card.compares}</code>
            </dd>
          </dl>
          <p className="muted">compares values; no model call</p>
        </>
      )}
    </li>
  );
}

/** Handoff §6: coverage strip, then the pipeline beside the proposal card. */
export function StepsView({
  projectId,
  draftVersion,
  definition,
  after,
  metrics,
  justAdded,
  card,
}: {
  projectId: string;
  draftVersion: number;
  definition: Record<string, unknown>;
  /** The draft with the selected changes applied, while a proposal is open. */
  after: Record<string, unknown> | null;
  metrics: StepMetric[] | null;
  justAdded: ReadonlySet<string>;
  card: ReactNode;
}) {
  const coverageId = useId();
  const pipelineId = useId();
  const coverage = outputCoverage(definition);
  const headline = coverageHeadline(coverage, after ? outputCoverage(after) : null);
  const cards = stepCards(definition);
  const numberOf = new Map(cards.map((c) => [c.id, c.number]));
  const sections = sectionIds(definition);
  const byStep = new Map((metrics ?? []).map((m) => [m.stepId, m]));
  return (
    <>
      <section className="card coverage" data-tone={headline.tone} aria-labelledby={coverageId}>
        <div className="coverage-head">
          <h3 id={coverageId}>Which step fills each output</h3>
          <p style={{ color: TONE_COLOR[headline.tone] }}>{headline.text}</p>
        </div>
        <ul className="coverage-chips">
          {coverage.outputs.map((o, i) => {
            const steps = o.steps.map((s) => numberOf.get(s) ?? '?');
            return (
              <li
                key={`${o.kind}-${o.id}-${i}`}
                className="coverage-chip"
                data-tone={o.steps.length === 1 ? undefined : 'warn'}
              >
                <code>{o.id}</code>
                {o.steps.length === 0 ? (
                  <span className="coverage-badge" aria-hidden="true">
                    !
                  </span>
                ) : (
                  steps.map((n, j) => (
                    <span key={j} className="coverage-badge" aria-hidden="true">
                      {n}
                    </span>
                  ))
                )}
                <span className="visually-hidden">
                  {o.steps.length === 0 ? ': not filled by any step' : `: step ${steps.join(', ')}`}
                </span>
              </li>
            );
          })}
        </ul>
        {coverage.uncovered.length > 0 && (
          <p className="muted">
            Propose again, or{' '}
            <a href={`#/workbench/${projectId}/template`}>add a step by hand on the Template tab</a>.
          </p>
        )}
      </section>
      <div className="steps-layout">
        <section className="card pipeline" aria-labelledby={pipelineId}>
          <div className="pipeline-head">
            <h3 id={pipelineId}>Pipeline in draft v{draftVersion}</h3>
            <span className="muted">Per-step figures from every run of this type (cached runs left out)</span>
          </div>
          <p className="pipeline-end">
            Prepared text, split into {sections.length} {sections.length === 1 ? 'section' : 'sections'}
          </p>
          <ol className="pipeline-steps">
            {cards.map((c) => (
              <Step
                key={c.id}
                card={c}
                sections={sections}
                metric={byStep.get(c.id)}
                justAdded={justAdded.has(c.id)}
              />
            ))}
          </ol>
          <p className="pipeline-end">{outputsLine(definition)}</p>
        </section>
        {card}
      </div>
    </>
  );
}
```

`StagePanel.tsx`:
- Imports: `applyChanges` from `@ih/shared`; `StepsView`; `stepCards`, `type StepMetric` from `./steps.js`.
- State and metrics:

```ts
  const [metrics, setMetrics] = useState<StepMetric[] | null>(null);
  const [justAdded, setJustAdded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (stage !== 'steps' || typeof draft !== 'number') return;
    api.getMetrics(projectId).then(
      (m) => setMetrics(m.steps),
      () => setMetrics(null),
    );
  }, [api, projectId, stage, draft]);
```

- `accept` records the step ids before and compares after the reload (replaces the Task 7 version):

```ts
  const accept = () =>
    act(async () => {
      if (!proposal) return;
      const before = new Set(stepCards(draftDef ?? {}).map((c) => c.id));
      const chosen = [...selected].sort((a, b) => a - b);
      setProposal(await api.decideProposal(projectId, proposal.id, 'accepted', chosen));
      onApplied();
      const now = await definitions.reload();
      if (now && draftDef) {
        setJustAdded(new Set(stepCards(now).map((c) => c.id).filter((id) => !before.has(id))));
      }
    });
```

  (`now` shadows the `now` prop inside the callback — name it `reloaded` if eslint's `no-shadow` is on.)

- The draft with the selected changes, while a proposal is open:

```ts
  const after =
    proposal?.status === 'ready' && body && draftDef
      ? applyChanges(
          draftDef,
          body.changes.filter((_, i) => selected.has(i)),
        )
      : null;
```

- Extend the body branch from Task 7:

```tsx
      ) : stage === 'steps' && draftDef && typeof draft === 'number' ? (
        <StepsView
          projectId={projectId}
          draftVersion={draft}
          definition={draftDef}
          after={after}
          metrics={metrics}
          justAdded={justAdded}
          card={card}
        />
      ) : (
        card
      )}
```

`stages.css` (append):

```css
.coverage {
  margin-bottom: 16px;
}
.coverage[data-tone='warn'] {
  border-color: var(--ih-warn-fg);
}
.coverage-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}
.coverage-head h3,
.coverage-head p {
  margin: 0;
}
.coverage-head h3 {
  font-size: var(--ih-text-md);
}
.coverage-head p {
  font-size: var(--ih-text-sm);
  font-weight: 600;
}
.coverage-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.coverage-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 10px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-pill);
  overflow-wrap: anywhere;
}
.coverage-chip[data-tone='warn'] {
  border-color: var(--ih-warn-fg);
  background: var(--ih-warn-bg);
  color: var(--ih-warn-fg);
}
.coverage-badge {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ih-accent);
  color: var(--ih-accent-text);
  font-size: var(--ih-text-xs);
  font-weight: 700;
}
.coverage-chip[data-tone='warn'] .coverage-badge {
  background: var(--ih-warn-fg);
  color: var(--ih-surface);
}
.steps-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1100px) {
  .steps-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.pipeline-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
}
.pipeline-head h3 {
  margin: 0;
  font-size: var(--ih-text-md);
}
.pipeline-end {
  width: fit-content;
  margin: 12px 0 0;
  padding: 3px 10px;
  border-radius: var(--ih-radius-pill);
  background: var(--ih-info-bg);
  color: var(--ih-info-fg);
  font-size: var(--ih-text-sm);
}
.pipeline-steps {
  margin: 0;
  padding: 0 0 0 12px;
  border-left: 2px solid var(--ih-flow);
  list-style: none;
}
.step-card {
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-md);
  background: var(--ih-surface);
}
.step-card.just-added {
  border: 1.5px solid var(--ih-ok-fg);
}
.step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.step-number {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ih-accent);
  color: var(--ih-accent-text);
  font-size: var(--ih-text-xs);
  font-weight: 700;
}
.step-id {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.step-model {
  margin-left: auto;
  font-size: var(--ih-text-sm);
}
.step-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 12px;
  margin: 10px 0 0;
}
.step-facts dt {
  color: var(--ih-muted);
  font-size: var(--ih-text-sm);
}
.step-facts dd {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
}
.fill-chip {
  padding: 1px 6px;
  border-radius: var(--ih-radius-sm);
  background: var(--ih-neutral-bg);
  overflow-wrap: anywhere;
}
.step-figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--ih-border-soft);
}
.step-figures dt {
  color: var(--ih-muted);
  font-size: var(--ih-text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.step-figures dd {
  margin: 2px 0 0;
  font-weight: 600;
}
.step-figures dd[data-tone='warn'],
.step-warning {
  color: var(--ih-warn-fg);
}
.step-warning {
  margin: 8px 0 0;
  font-size: var(--ih-text-sm);
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/StepsTab.test.tsx apps/web/test/OutputsTab.test.tsx apps/web/test/StagePanel.test.tsx apps/web/test/ProjectPage.test.tsx` → PASS; eslint, typecheck, prettier. Look at the Steps tab in light and dark at 1440 px and 390 px (`npm run dev:web` against `npm run dev:api`, or the Browser pane) against `06-steps.png` / `06b-steps-applied.png`: cards stack below 1100 px, nothing scrolls the page sideways.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/StepsView.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/styles/stages.css apps/web/test/StepsTab.test.tsx
git commit -m "Workbench web: Steps tab with coverage, pipeline cards and per-step figures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and the full check

**Files:**
- Modify: `CLAUDE.md` (UI bullet)

- [ ] **Step 1: Docs** — in `CLAUDE.md`, at the end of the **UI** bullet (after "…is [docs/design/workbench-redesign/](docs/design/workbench-redesign/WORKBENCH-HANDOFF.md)."), append:

```markdown
 The Workbench tabs redesign is [docs/design/workbench-tabs/](docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md): tabs share `ProposalCard` (proposal → "N of M changes applied" card), `StaleBanner`, `SampleTag`/`SectionChip` (`workbench/`), `Meter` and `sectionTone` (section colours by order, `ui/`); Outputs compares the draft with the live version client-side (`outputRows`), and Steps' coverage strip uses the shared `outputCoverage` (`packages/shared/src/template.ts`), the same code as the template's "is not filled by any step" check.
```

- [ ] **Step 2: Run** `npm run check` → green (lint, typecheck, all TS tests, worker lint and tests — the worker is untouched). Then `npm run format:check`; fix with `npx prettier --write` on the reported files only.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Docs: Workbench tab primitives, Outputs and Steps in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`: `config/llm-providers.yaml` has an unrelated local change.)
