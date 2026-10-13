# Workbench stage tabs restyle (PR 5 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every project tab the handoff's header pattern (H2 + status icon and text), and restyle the drafting stages' proposal (`StagePanel`: Outputs, Sections, Steps, and the Revise tab's revision) as the proposal card of the handoff: meta strip, one row per change with kind tag and id, Details disclosure, and a footer with **Apply N selected changes**, **Reject all** and the Template-tab link.

**Architecture:** A small `TabHeader` component renders the H2, the status line (from the overview item PR 3 already loads) and an optional actions slot. `ProjectPage` renders it for every tab except Overview and the three `StagePanel` stages; `StagePanel` renders it itself when given a `title`, putting **Propose again** / **Skip this stage** in the header. A pure `changeParts(change)` gives each change's kind tag, tone, id and text.

**Tech Stack:** React 19, Vitest + Testing Library, CSS on `--ih-*` tokens.

**Spec:** `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` §4; screenshots `12-workbench-steps-tab.png` and `13-workbench-evaluate-tab-placeholder.png` in `docs/design/workbench-redesign/screenshots/{light,dark}/`.

## Global Constraints

- Tab header: H2 (e.g. "Extraction steps"), status icon + text in tone, data-policy note (`POLICY_NOTE`) for drafting stages. Right: **Propose again** (or the stage's first-run label), **Skip this stage** (when `canSkip`).
- Proposal card: `section aria-label="Proposal"`, border in the status tone; meta strip (model mono · brief vN · status · relative time) + the model's notes; one row per change: checkbox (`aria-label="Apply: <description>"`), kind tag (EXTRACT info / CHECK neutral / FIELD / TABLE / SECTION …), id in mono, the change text, reason (muted), **Details** disclosure (JSON). Sections keeps the "found in x of y dev samples (missed: …)" line.
- Footer: **Apply N selected changes** (primary, count live), **Reject all** (danger text), "Edit by hand on the Template tab" link.
- Other tabs keep their current components; only the header pattern is added above them.
- H2 titles: Samples "Samples", Brief "Brief", Survey "Survey", Outputs "Outputs", Sections "Section anchors", Steps "Extraction steps", References "References", Evaluate "Evaluate", Revise "Revise", Template "Template", Test runs "Test runs".
- Tests first; `npm run check` green; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never stage `config/llm-providers.yaml`.

## Review Focus

1. **Zero selected changes** — the primary button reads "Apply 0 selected changes" and is disabled; one selected reads "Apply 1 selected change" (Task 2 test).
2. **A decided proposal** (accepted / partly accepted / rejected) — checkboxes disabled and showing what was applied, no footer buttons, the card border in the decided tone (Task 2 test).
3. **Overview not loaded yet / failed** — headers still render the H2, without a status line (Task 1 and 3 tests).
4. **Revise** — no Skip button anywhere, and only one Propose button (Task 3 test).
5. **Very long change text or ids** (regexes, many fields) wrap inside the card at 390 px instead of scrolling the page sideways (`overflow-wrap: anywhere` on the row text; Task 2 CSS).

---

### Task 1: `TabHeader` and `changeParts`

**Files:**
- Create: `apps/web/src/workbench/TabHeader.tsx`, `apps/web/src/workbench/changes.ts`
- Modify: `apps/web/src/styles/stages.css`
- Test: `apps/web/test/TabHeader.test.tsx`, `apps/web/test/changes.test.ts` (create)

**Interfaces:**
- Consumes: `OverviewItem` (`@ih/shared`), `StageStatusIcon`, `stageStyle`, `TONE_COLOR` (PR 2), `DraftChange` (`@ih/shared`).
- Produces:
  - `TabHeader({ title, item, note?, actions? }: { title: string; item: OverviewItem | null; note?: string; actions?: ReactNode })`
  - `type ChangeKind = 'FIELD' | 'TABLE' | 'SECTION' | 'COPIES' | 'EXTRACT' | 'CHECK' | 'REMOVE' | 'PREAMBLE'`
  - `changeParts(c: DraftChange): { kind: ChangeKind; tone: 'info' | 'neutral' | 'ok' | 'alert'; id: string | null; text: string }`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/changes.test.ts` (build changes in the exact `DraftChange` shapes from `packages/shared/src/drafting.ts`; if a field below has a different name there, use the real one and keep the expected output):

```ts
import { describe, expect, it } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { changeParts } from '../src/workbench/changes.js';

describe('changeParts', () => {
  it.each([
    [
      { op: 'putStep', reason: 'r', step: { type: 'extract', id: 'header', fields: ['supplier_name', 'invoice_number'], sections: ['header', 'supplier'] } },
      { kind: 'EXTRACT', tone: 'info', id: 'header', text: 'fills supplier_name, invoice_number from header, supplier' },
    ],
    [
      { op: 'putStep', reason: 'r', step: { type: 'extract', id: 'line_items', table: 'line_items', fields: [], sections: ['line_items'] } },
      { kind: 'EXTRACT', tone: 'info', id: 'line_items', text: 'fills table line_items from line_items' },
    ],
    [
      { op: 'putStep', reason: 'r', step: { type: 'check', id: 'totals-match', values: 'line_items.amount', reference: 'subtotal' } },
      { kind: 'CHECK', tone: 'neutral', id: 'totals-match', text: 'line_items.amount against subtotal' },
    ],
    [
      { op: 'putField', reason: 'r', field: { id: 'currency', type: 'enum', enum: ['EUR', 'USD'] } },
      { kind: 'FIELD', tone: 'ok', id: 'currency', text: 'enum: EUR, USD' },
    ],
    [
      { op: 'putTable', reason: 'r', table: { id: 'lines', columns: [{ id: 'qty' }, { id: 'amount' }] } },
      { kind: 'TABLE', tone: 'ok', id: 'lines', text: 'columns qty, amount' },
    ],
    [
      { op: 'putSection', reason: 'r', section: { id: 'totals', anchor: 'Total', required: false } },
      { kind: 'SECTION', tone: 'info', id: 'totals', text: '/Total/ (optional)' },
    ],
    [{ op: 'removeStep', reason: 'r', id: 'old' }, { kind: 'REMOVE', tone: 'alert', id: 'old', text: 'remove this step' }],
    [{ op: 'removeOutput', reason: 'r', id: 'x' }, { kind: 'REMOVE', tone: 'alert', id: 'x', text: 'remove this output' }],
    [{ op: 'removeSection', reason: 'r', id: 's' }, { kind: 'REMOVE', tone: 'alert', id: 's', text: 'remove this section' }],
    [{ op: 'setPreamble', reason: 'r', preamble: 'Be careful' }, { kind: 'PREAMBLE', tone: 'neutral', id: null, text: 'Set the prompt preamble' }],
    [{ op: 'setCopies', reason: 'r', copies: null }, { kind: 'COPIES', tone: 'neutral', id: null, text: 'No copy selection' }],
  ])('%#', (change, parts) => {
    expect(changeParts(change as unknown as DraftChange)).toEqual(parts);
  });
});
```

`apps/web/test/TabHeader.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TabHeader } from '../src/workbench/TabHeader.js';

describe('TabHeader', () => {
  it('shows the title, the status in words and the note', () => {
    render(
      <TabHeader
        title="Extraction steps"
        item={{ stage: 'steps', state: 'proposed', status: 'Needs your decision', metrics: [] }}
        note="Runs on local models; holdout samples are never sent."
        actions={<button type="button">Propose again</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Extraction steps' })).toBeInTheDocument();
    expect(screen.getByText('Needs your decision')).toBeInTheDocument();
    expect(screen.getByText('Runs on local models; holdout samples are never sent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeInTheDocument();
  });

  it('has only the title while the overview is loading', () => {
    const { container } = render(<TabHeader title="Samples" item={null} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Samples' })).toBeInTheDocument();
    expect(container.querySelector('.tab-status')).toBeNull();
  });

  it('has no status line for a tab without status', () => {
    const { container } = render(<TabHeader title="Template" item={{ stage: 'template', state: 'none', status: 'Draft v2', metrics: [] }} />);
    expect(container.querySelector('.tab-status')).toBeNull();
  });
});
```

(If PR 4 has not added `metrics` to `OverviewItem` when this runs, drop the `metrics: []` keys.)

- [ ] **Step 2: Run** `npx vitest run apps/web/test/changes.test.ts apps/web/test/TabHeader.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/workbench/changes.ts`:

```ts
import type { DraftChange } from '@ih/shared';

export type ChangeKind = 'FIELD' | 'TABLE' | 'SECTION' | 'COPIES' | 'EXTRACT' | 'CHECK' | 'REMOVE' | 'PREAMBLE';

/** A change as the proposal card shows it: kind tag, tone, id (mono) and the rest in words. */
export function changeParts(c: DraftChange): {
  kind: ChangeKind;
  tone: 'info' | 'neutral' | 'ok' | 'alert';
  id: string | null;
  text: string;
} {
  switch (c.op) {
    case 'putField':
      return {
        kind: 'FIELD',
        tone: 'ok',
        id: c.field.id,
        text: c.field.type === 'enum' ? `enum: ${(c.field.enum ?? []).join(', ')}` : c.field.type,
      };
    case 'putTable':
      return { kind: 'TABLE', tone: 'ok', id: c.table.id, text: `columns ${c.table.columns.map((col) => col.id).join(', ')}` };
    case 'removeOutput':
      return { kind: 'REMOVE', tone: 'alert', id: c.id, text: 'remove this output' };
    case 'putSection':
      return {
        kind: 'SECTION',
        tone: 'info',
        id: c.section.id,
        text: `/${c.section.anchor}/${c.section.required ? '' : ' (optional)'}`,
      };
    case 'removeSection':
      return { kind: 'REMOVE', tone: 'alert', id: c.id, text: 'remove this section' };
    case 'setCopies':
      return {
        kind: 'COPIES',
        tone: 'neutral',
        id: null,
        text: c.copies ? `Keep the ${c.copies.select} copy, split at /${c.copies.anchor}/` : 'No copy selection',
      };
    case 'putStep':
      return c.step.type === 'extract'
        ? {
            kind: 'EXTRACT',
            tone: 'info',
            id: c.step.id,
            text: `fills ${c.step.table ? `table ${c.step.table}` : c.step.fields.join(', ')} from ${c.step.sections.join(', ')}`,
          }
        : { kind: 'CHECK', tone: 'neutral', id: c.step.id, text: `${c.step.values} against ${c.step.reference}` };
    case 'removeStep':
      return { kind: 'REMOVE', tone: 'alert', id: c.id, text: 'remove this step' };
    case 'setPreamble':
      return { kind: 'PREAMBLE', tone: 'neutral', id: null, text: c.preamble ? 'Set the prompt preamble' : 'Remove the prompt preamble' };
  }
}
```

(The field accesses mirror `describeChange` in `StagePanel.tsx`, which compiles today — keep them identical.)

`apps/web/src/workbench/TabHeader.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { OverviewItem } from '@ih/shared';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR } from '../ui/stageStyle.js';

/** Every project tab's header (handoff §4): H2, status icon + text in tone, a note, actions. */
export function TabHeader({
  title,
  item,
  note,
  actions,
}: {
  title: string;
  item: OverviewItem | null;
  note?: string;
  actions?: ReactNode;
}) {
  const showStatus = item !== null && item.state !== 'none';
  return (
    <header className="tab-header">
      <div className="tab-header-text">
        <h2>{title}</h2>
        {showStatus && (
          <p className="tab-status" style={{ color: TONE_COLOR[stageStyle(item.state).tone] }}>
            <StageStatusIcon state={item.state} size={18} decorative />
            {item.status}
          </p>
        )}
        {note && <p className="muted tab-note">{note}</p>}
      </div>
      {actions && <div className="tab-actions">{actions}</div>}
    </header>
  );
}
```

`stages.css` (append):

```css
.tab-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px 20px;
  margin-bottom: 16px;
}
.tab-header h2 {
  margin: 0;
  font-size: var(--ih-text-xl);
}
.tab-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  font-weight: 600;
}
.tab-note {
  margin: 6px 0 0;
  font-size: var(--ih-text-sm);
}
.tab-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
```

- [ ] **Step 4: Run** the two test files → PASS; lint, typecheck, prettier.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/TabHeader.tsx apps/web/src/workbench/changes.ts apps/web/src/styles/stages.css apps/web/test/TabHeader.test.tsx apps/web/test/changes.test.ts
git commit -m "Workbench web: tab header pattern and change parts for the proposal card"
```

---

### Task 2: `StagePanel` as the proposal card

**Files:**
- Modify: `apps/web/src/workbench/StagePanel.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/StagePanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`TabHeader`, `changeParts`); `relativeTime(iso, now)` from `apps/web/src/jobs/derive.ts`; `stageStyle`, `TONE_COLOR`, `DisplayState`.
- Produces: `StagePanel` gains optional props `title?: string` and `item?: OverviewItem | null` and `now?: number` (default `Date.now()`); with `title` it renders `TabHeader` (title, item, `POLICY_NOTE` as note, Propose/Skip as actions); without it (Revise) it keeps the actions as an inline row under the policy note as today. Exported `PROPOSAL_STATE: Record<ProposalStatus, DisplayState>` = `{ running: 'running', ready: 'proposed', accepted: 'accepted', partially_accepted: 'accepted', rejected: 'pending', failed: 'warn' }`.

Card markup (replace the current `<section aria-label="Proposal">` body):

```tsx
<section
  aria-label="Proposal"
  className="proposal-card"
  style={{ borderColor: TONE_COLOR[stageStyle(PROPOSAL_STATE[proposal.status]).tone] }}
>
  <div className="proposal-meta">
    <p>
      <code>{proposal.model ?? '—'}</code> · brief v{proposal.briefVersion ?? '–'} · {proposal.status.replace('_', ' ')} ·{' '}
      {relativeTime(proposal.createdAt, now)}
    </p>
    {body.notes && <p>{body.notes}</p>}
    {applied && <p role="status">{applied.length} of {body.changes.length} changes applied to the draft</p>}
  </div>
  <ul className="proposal-changes">
    {body.changes.map((c, i) => {
      const parts = changeParts(c);
      const line = anchorLine(c);
      return (
        <li key={`${i}-${c.op}`}>
          <input
            type="checkbox"
            aria-label={`Apply: ${describeChange(c)}`}
            disabled={proposal.status !== 'ready'}
            checked={proposal.status === 'ready' ? selected.has(i) : (applied ?? []).includes(i)}
            onChange={() => toggle(i)}
          />
          <div className="proposal-change">
            <p>
              <span className={`kind-tag tone-${parts.tone}`}>{parts.kind}</span>
              {parts.id && <code>{parts.id}</code>} {parts.text}
            </p>
            <p className="muted">{c.reason}</p>
            {line && <p className="muted">{line}</p>}
          </div>
          <details>
            <summary>Details</summary>
            <pre>{JSON.stringify(c, null, 2)}</pre>
          </details>
        </li>
      );
    })}
  </ul>
  {proposal.status === 'ready' && (
    <footer className="proposal-footer">
      <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={() => void accept()}>
        Apply {selected.size} selected {selected.size === 1 ? 'change' : 'changes'}
      </button>
      <button type="button" className="danger-text" disabled={busy} onClick={() => void reject()}>
        Reject all
      </button>
      <a className="proposal-edit" href={`#/workbench/${projectId}/template`}>
        Edit by hand on the Template tab
      </a>
    </footer>
  )}
</section>
```

(If `.danger-text` does not exist in `styles.css`, add it to `stages.css`: transparent background, `--ih-danger-fg` text, 1 px `--ih-border` border. Check what `danger` / `danger-fill` already look like and keep the visual family.)

- [ ] **Step 1: Update the tests first** — in `apps/web/test/StagePanel.test.tsx`:
  - Checkbox queries use the new names: `getByRole('checkbox', { name: 'Apply: <describeChange text>' })` (the descriptions are unchanged, only prefixed).
  - The apply button is `Apply 2 selected changes` (or the count the test selects); after unticking one, `Apply 1 selected change`; with none, `Apply 0 selected changes` and disabled — add this as a new test.
  - New test: rendering with `title="Extraction steps"` and an `item` shows the H2, the status text, and **Propose again** / **Skip this stage** inside the header (`within(screen.getByRole('banner'))` will not work — the header is not a landmark inside a section; query `container.querySelector('.tab-header')` and `within(...)`).
  - New test: a decided proposal (`status: 'partially_accepted'`, `acceptedChanges: [0]`) shows disabled checkboxes with only the first checked, no **Reject all**, and the card's `style.borderColor` is `var(--ih-ok-fg)`.
  - New test: the footer link "Edit by hand on the Template tab" points to `#/workbench/<project>/template`.
  - Each kind tag renders (e.g. `EXTRACT` and `CHECK` text for a steps proposal).
  Run `npx vitest run apps/web/test/StagePanel.test.tsx` → FAIL.

- [ ] **Step 2: Implement** the props, header and card as above; keep `describeChange` exported (other code may import it). Append to `stages.css`:

```css
.proposal-card {
  border: 1.5px solid;
  border-radius: var(--ih-radius-lg);
  background: var(--ih-surface);
  overflow: hidden;
}
.proposal-meta {
  padding: 12px 18px;
  background: var(--ih-surface2);
  border-bottom: 1px solid var(--ih-border);
}
.proposal-meta p {
  margin: 0 0 4px;
}
.proposal-changes {
  margin: 0;
  padding: 0;
  list-style: none;
}
.proposal-changes li {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 12px 18px;
  border-bottom: 1px solid var(--ih-border-soft);
}
.proposal-change p {
  margin: 0 0 4px;
  overflow-wrap: anywhere;
}
.kind-tag {
  display: inline-block;
  margin-right: 8px;
  padding: 1px 6px;
  border-radius: var(--ih-radius-sm);
  font-size: var(--ih-text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.proposal-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 18px;
}
.proposal-edit {
  margin-left: auto;
}
```

(`.tone-info` / `.tone-neutral` / `.tone-ok` / `.tone-alert` already set pill colours in `styles.css`; check they give background + text colour and reuse them for `.kind-tag`.)

- [ ] **Step 3: Run** `npx vitest run apps/web/test/StagePanel.test.tsx apps/web/test/ReviseTab.test.tsx apps/web/test/ProjectPage.test.tsx` → PASS (update the ReviseTab/ProjectPage assertions that used the old button and checkbox names, deliberately); lint, typecheck, prettier.
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/workbench/StagePanel.tsx apps/web/src/styles/stages.css apps/web/test/StagePanel.test.tsx apps/web/test/ReviseTab.test.tsx apps/web/test/ProjectPage.test.tsx
git commit -m "Workbench web: the drafting proposal as a card with kind tags and a live apply count"
```

---

### Task 3: Headers on every tab

**Files:**
- Modify: `apps/web/src/workbench/ProjectPage.tsx`, `CLAUDE.md` (one clause in the Project page sentence), `docs/design/workbench.md` (one sentence)
- Test: `apps/web/test/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: `TabHeader`, `StagePanel` (`title`, `item`), the page's `overview` state.

- [ ] **Step 1: Write the failing tests** — in `ProjectPage.test.tsx` add a table test: for each tab in `['samples','brief','survey','outputs','sections','steps','references','evaluate','revise','template','runs']` the page shows one `heading level 2` with the title from the Global Constraints (Outputs "Outputs", Sections "Section anchors", Steps "Extraction steps", Test runs "Test runs", …) and, with an overview whose item for that tab has state `accepted` and status `Accepted` (Template excluded), the text `Accepted` near it. Add: on `tab="revise"` there is no `Skip this stage` button and exactly one `Propose a revision` / `Propose again` button. Add: with `getProjectOverview` rejecting, the `Samples` H2 still renders.
  Run → FAIL.

- [ ] **Step 2: Implement** in `ProjectPage.tsx`:
  - `const itemOf = (t: ProjectTab) => overview?.stages.find((s) => s.stage === t) ?? null;`
  - `const TAB_TITLE: Record<Exclude<ProjectTab, 'overview'>, string>` with the titles above.
  - For `outputs`, `sections`, `steps`: pass `title={TAB_TITLE[tab]}` and `item={itemOf(tab)}` to `StagePanel`; remove the separate "Edit by hand on the Template tab" paragraph after the outputs/steps `StagePanel` (it is now in the card footer).
  - For every other tab except `overview`: render `<TabHeader title={TAB_TITLE[tab]} item={itemOf(tab)} />` above the tab's existing content (Survey and References also get `note={POLICY_NOTE[dataPolicy]}` only if they do not already print the policy note themselves — check and avoid printing it twice).
  - Docs: in CLAUDE.md's Project page sentence add "every tab opens with `TabHeader` (H2 + status), and drafting proposals are cards (`StagePanel`: kind tags, Apply N selected changes)"; same in `docs/design/workbench.md`.

- [ ] **Step 3: Run** `npx vitest run --project web` → PASS; `npm run check`; `npm run format:check`.
- [ ] **Step 4: Commit**

```bash
git add apps/web/src/workbench/ProjectPage.tsx apps/web/test/ProjectPage.test.tsx CLAUDE.md docs/design/workbench.md
git commit -m "Workbench web: every project tab opens with its title and status"
```
