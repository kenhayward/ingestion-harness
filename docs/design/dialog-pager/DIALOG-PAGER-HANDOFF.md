# CT Studio — New project dialog + Samples page pager — handoff for Claude Code

Two small, independent UI redesigns. **No API changes, no new fields, no new colours** — only
existing tokens from `apps/web/src/styles/tokens.css`. Follow the repo's CLAUDE.md (test first,
small PRs; these can be two PRs).

| # | Redesign | Files |
| --- | --- | --- |
| 1 | New project dialog (Workbench list) | `workbench/WorkbenchPage.tsx` (`NewProjectDialog`), `ui/Dialog.tsx`, `styles.css` |
| 2 | Page pager in the Samples text preview | `workbench/SampleText.tsx` (`paged` branch), `styles.css` |

## Contents

| Path | What it is |
| --- | --- |
| `HANDOFF.md` | This document |
| `screenshots/light/`, `screenshots/dark/` | Same set in both themes (list below) |
| `prototype/prototype.html` | Offline prototype (not kept in the repo; the screenshots show every state) |

| Screenshot | Shows |
| --- | --- |
| `01-new-project-empty.png` / `01b-…-closeup.png` | Dialog on open: Id focused-style ring, Create disabled |
| `02-new-project-filled.png` / `02b-…-closeup.png` | Id and Name entered, Create enabled |
| `03-samples-tab-pager.png` | Whole Samples tab, pager in the text preview |
| `03b-pager-first-page.png` | Page 1 of 3 — previous disabled |
| `03c-pager-middle-page.png` | Page 2 of 3 — both enabled |
| `03d-pager-last-page.png` | Page 3 of 3 — next disabled |

---

## 1. New project dialog

Today the labels and inputs sit right-aligned in a narrow column and the hint floats loose
(see `NewProjectDialog` in `WorkbenchPage.tsx`). Behaviour stays exactly as it is:
`api.createProject(id.trim(), name.trim() || undefined)`, navigate to the project, show the
error in the dialog, disable while busy. Escape / backdrop / Cancel / focus trap come from
`Dialog` unchanged.

### Layout (max-width 480 px, radius 14 px)

1. **Header** (`padding: 24px 24px 20px`, flex row, `gap: 16px`, centred vertically)
   - **Workbench icon at double size**: the existing `Icon name="workbench"` (the bench glyph)
     at **36 px** (nav uses 18 px), stroke width 1.6, inside a **60 × 60 tile**,
     `border-radius: 14px`, `background: var(--ih-accent-soft)`,
     `color: var(--ih-accent-soft-text)`. `aria-hidden`.
   - Title `h2` "New project": 19 px, weight 600, `letter-spacing: -0.01em`.
   - Description under the title (13 px, `--ih-muted`, `id` used for `aria-describedby` on the
     dialog): *"A Workbench project drafts a document type with the model, step by step."*
2. **Form** (`padding: 4px 24px 24px`, column, `gap: 18px`) — fields full width, stacked:
   - **Id** — label row: "Id" (13 px, 600) left, **REQUIRED** right (11 px, 600, uppercase,
     `letter-spacing: 0.04em`, `--ih-muted`). Input 42 px high, `--ih-font-mono` 14 px,
     `background: var(--ih-surface2)`, `border: 1px solid var(--ih-border)`, radius 8 px,
     placeholder `e.g. supplier-invoice`, `autocomplete="off"`, `spellcheck={false}`.
     While empty it shows the focus treatment: `border-color: var(--ih-accent)` +
     `box-shadow: 0 0 0 3px var(--ih-accent-soft)` (use the same for `:focus-visible` on both
     inputs).
   - **Name** — same label row with **OPTIONAL**. Input 42 px, sans 14 px, placeholder
     `e.g. Supplier invoice`, `aria-describedby` → the hint.
   - **Hint** directly under Name (12 px, `--ih-muted`, 14 px info-circle icon before it):
     *"Leave the name empty to open an existing document type."*
   - Error (`role="alert"`, `--ih-danger-fg`) under the hint when the API call fails.
3. **Footer** (`Dialog`'s `.dialog-actions`): full-bleed strip, `padding: 14px 24px`,
   `border-top: 1px solid var(--ih-border-soft)`, `background: var(--ih-surface2)`,
   buttons right-aligned, `gap: 8px`:
   - **Cancel** (secondary, 40 px).
   - **Create project** (primary, 40 px, `+` icon before the text, `type="submit"
     form="new-project"`). Disabled until Id has a non-blank value or while busy; when
     disabled: `--ih-surface` background, `--ih-muted` text, `--ih-border` border,
     `cursor: not-allowed`, `title="Enter an id first"`.

Dialog shell: `border: 1px solid var(--ih-border)`, `background: var(--ih-surface)`,
`box-shadow: 0 24px 64px rgba(0,0,0,.28)`, `overflow: hidden` so the footer strip reaches the
rounded edges. Backdrop: keep the existing `.dialog-backdrop` scrim.

### Implementation notes

- Extend `Dialog` with two optional props, used only here for now:
  `icon?: ReactNode` (rendered in the tile left of the title) and
  `description?: ReactNode` (rendered under the title; wire `aria-describedby`). Other
  dialogs render exactly as before when the props are absent.
- Move the hint from a loose `<p>` to the Name field's `aria-describedby` target.
- Narrow screens (< 480 px): dialog full width minus 16 px gutters; header stays a row (tile
  shrinks to 48 px / icon 28 px if needed); footer buttons may wrap, Create stays last.
- Tests: Create disabled with an empty / whitespace Id and enabled after typing; Name hint is
  the input's description; the dialog is labelled by the title and described by the
  description; Escape still closes; an API error shows in the dialog.

---

## 2. Samples text preview — page pager

Replace the row of **Page 1 · Page 2 · …** buttons (`.page-chips`) with one pager:
**‹ Page *n* of *N* ›**. It stays one size however many pages the sample has. Only the
`paged` branch changes; the all-pages view used by Sections is untouched.

### Spec

- `nav aria-label="Pages"`, flex row, `justify-content: space-between`:
  - **Pager** (left): an inline group with `border: 1px solid var(--ih-border)`,
    `radius-md`, `background: var(--ih-surface2)`, `padding: 2px`, `gap: 2px`:
    - **Previous** button: 32 × 32, chevron-left 16 px, `aria-label="Previous page"`,
      disabled on page 1.
    - **Label**: "**Page n**" (600) + " of N" (`--ih-muted`), 13 px, tabular numbers,
      `min-width: 92px`, centred, `aria-live="polite"` so screen readers hear the change.
    - **Next** button: chevron-right, `aria-label="Next page"`, disabled on the last page.
    - Buttons: transparent, `--ih-text`; hover `--ih-neutral-bg`; disabled colour
      `--ih-border-strong`, `cursor: not-allowed`.
  - **OCR tag** (right): the existing `tag tone-info` "OCR", only when the **current** page
    was read by OCR, `title="This page was read by OCR"`.
- Page state clamps to 1…N. Reset to page 1 when the selected sample changes (key the
  component by sample id, or reset in an effect).
- Optional, recommended: ← / → change page when focus is inside the text panel.

### Code

```tsx
if (paged) {
  const total = text.pages.length;
  const current = text.pages.find((p) => p.number === page) ?? text.pages[0];
  const n = current?.number ?? 1;
  const go = (to: number) => setPage(Math.min(Math.max(to, 1), total));
  return (
    <div className="sample-text paged" ref={root}>
      <nav className="page-pager" aria-label="Pages">
        <span className="pager">
          <button type="button" aria-label="Previous page" disabled={n <= 1} onClick={() => go(n - 1)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span className="pager-label" aria-live="polite">
            <strong>Page {n}</strong> <span className="muted">of {total}</span>
          </span>
          <button type="button" aria-label="Next page" disabled={n >= total} onClick={() => go(n + 1)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </span>
        {current?.ocr && <span className="tag tone-info" title="This page was read by OCR">OCR</span>}
      </nav>
      {current && (
        <section aria-label={`Page ${current.number}`}>
          <PageBody text={`[page ${current.number}]\n${current.text}`}
            marks={(marks ?? []).filter((m) => m.page === current.number)} wrap />
        </section>
      )}
    </div>
  );
}
```

If `Icon.tsx` has (or gains) `chevron-left` / `chevron-right`, use those instead of inline SVG.

```css
.page-pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pager { display: inline-flex; align-items: center; gap: 2px; padding: 2px;
  border: 1px solid var(--ih-border); border-radius: var(--ih-radius-md); background: var(--ih-surface2); }
.pager button { width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--ih-radius-sm);
  background: transparent; color: var(--ih-text); display: flex; align-items: center; justify-content: center; }
.pager button:hover:not(:disabled) { background: var(--ih-neutral-bg); }
.pager button:disabled { color: var(--ih-border-strong); cursor: not-allowed; }
.pager-label { min-width: 92px; padding: 0 6px; text-align: center;
  font-size: var(--ih-text-md); font-variant-numeric: tabular-nums; }
.pager-label strong { font-weight: 600; }
```

Remove the old `.page-chips` rules.

### Tests

- One page: both buttons disabled, label "Page 1 of 1".
- Three pages: Previous disabled on 1; Next moves to 2 (both enabled); Next to 3 disables
  Next; label updates each time.
- OCR tag follows the current page's `ocr` flag.
- Marks still render on the current page; `focus` still scrolls to its mark.
- Switching sample returns to page 1.
- The Sections (non-paged) view still shows every page.
