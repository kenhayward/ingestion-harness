# CT Studio — Home page layout — handoff for Claude Code

Scope: **layout only** for `apps/web/src/home/HomePage.tsx` and the `wide` variant of
`apps/web/src/jobs/JobDetailPanel.tsx`, plus one display rule for model names.
**No new fields, features, API calls or colours.** Every value shown already exists on the
page today; this work regroups it, adds section headings and lays progress out across the
card. Follow the repo's CLAUDE.md (test first, small PR).

## Contents

| Path | What it is |
| --- | --- |
| `HOME-HANDOFF.md` | This document |
| `screenshots/home-<state>-<theme>.png` | 1440 px, states `review` (awaiting review), `running`, `done` (succeeded), light and dark |
| `prototype/prototype.html` | Offline prototype; open `?screen=home&homejob=review\|running\|done&theme=light\|dark` |

Names and values in the screenshots are mock data. Use the real job data.

---

## 1. Page order (top to bottom)

The page follows what the user does: upload, then watch the result.

1. **Page header** (unchanged): `h1` "Home", the muted description, live indicator on the
   right ("Live · refreshes every 3 s" / "Reconnecting…").
2. **Upload documents**: section heading, then the existing `UploadStrip` inside a card.
3. **Latest job**: one card holding the job (layout in §3).
4. Error and empty states stay where they are (load error above the job card; "No jobs yet:
   upload a document to start." in place of the card).

**Remove the "All jobs" link** and its wrapper `.home-latest-head` (and its CSS). Jobs is one
click away in the main menu.

## 2. Headings — two levels, existing tokens only

| Level | Used for | Style |
| --- | --- | --- |
| Section heading (`h2`) | "Upload documents" | `font-size: var(--ih-text-lg)` (15 px), weight 600, `color: var(--ih-text)`, `margin: 0 0 10px` |
| Card label (`h3`, small caps style) | "Latest job", "Progress", "Status and actions", "Details", "Published outputs" | `font-size: var(--ih-text-xs)` (11 px), weight 600, `letter-spacing: 0.06em`, `text-transform: uppercase`, `color: var(--ih-muted)`, `margin: 0` — the same look as the nav's "ADMIN" heading |

Add one shared class (e.g. `.card-label`) rather than per-section rules. Each labelled block
is a `section` with `aria-labelledby` pointing at its heading. The old `.eyebrow` "Latest job"
becomes the `h3.card-label` "Latest job"; the `eyebrow` prop can be dropped if nothing else
uses it.

## 3. Upload documents

- `section aria-labelledby` + `h2` "Upload documents".
- The upload strip becomes a **solid card**: `border: 1px solid var(--ih-border)`,
  `border-radius: var(--ih-radius-lg)`, `background: var(--ih-surface)`, `padding: 16px`,
  `gap: 16px`. The **drop zone alone** keeps the dashed outline
  (`1.5px dashed var(--ih-border-strong)`, `radius-md`), so the dashed edge marks only the
  part you drop files on. Drag-over keeps today's accent styling.
- Controls stay on one row at desktop width: drop zone (flex 2) · Document type · Model ·
  Upload. The per-file upload list stays under the row, full width.
- No change to the strip's behaviour. (The top bar's "Upload document" button, which went to Home and opened the picker, has since been removed: Home is where uploads start.)

## 4. Latest job card

Card: `border: 1px solid var(--ih-border)`, `radius-lg`, `surface`, no inner padding on the
card itself; blocks below are padded `24px` left/right.

### 4.1 Header (padding `18px 24px 0`)
- `h3.card-label` "Latest job".
- Row: file name (`font-size: 20px`, weight 600, wraps/breaks long names) followed by the
  existing `StatusPill`, `gap: 10px`, wrapping on narrow screens.

### 4.2 Progress (margin `18px 24px 0`)
- An inset panel: `background: var(--ih-surface2)`, `border: 1px solid var(--ih-border-soft)`,
  `radius: 10px` (or `--ih-radius-lg`), `padding: 18px 16px 14px`, `gap: 16px`.
- `h3.card-label` "Progress", then the **same five steps** from `progressSteps()` laid out
  **horizontally**: `ol` as a 5-column grid; each `li` centred: icon, label, state text.
  - Icon 28 px (today 20 px in the side panel), same state styling as now
    (`.step-done/current/wait/fail/todo`).
  - A 2 px connector between consecutive icons, `var(--ih-ok-fg)` when the step to its left
    is done, otherwise `var(--ih-border)`. Draw it with a `::before` on each `li` after the
    first (from the previous icon's edge to this icon's edge); purely decorative
    (`aria-hidden`).
  - The current / waiting / stopped step's label is weight 600; state text uses the existing
    tone colour (Running = info, Waiting for you = warn, Stopped = danger, Done = muted).
  - Keep `aria-label="Progress"` on the `ol` and the visible state text per step.
- This horizontal layout is **Home only** (`.job-panel.wide`). The side panel on Jobs keeps
  the vertical list.

### 4.3 Status and actions | Details (padding `20px 24px 22px`)
Two columns (`grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))`, `gap: 24px 32px`).

- **Status and actions** (left): `h3.card-label`, then the existing callout (unchanged
  content and tone; absent for running/succeeded jobs), then `JobActions variant="panel"`.
  Buttons keep their natural width on Home (`flex: 0 0 auto; min-width: 120px`) — today's
  "first button full width" rule applies only to the side panel.
  If the job has published outputs: below the buttons, `h3.card-label` "Published outputs",
  the existing "Download outputs (ZIP)" link and the "n files: …" line.
- **Details** (right): `h3.card-label` "Details", then the existing `dl.meta` (Document type,
  Model, Attempts, Created, Queued by). A `1px solid var(--ih-border-soft)` left border and
  `padding-left: 24px` separate it from the left column; drop both when the columns stack.

## 5. Model names: show the label, not the ref

Show the **model choice label** ("Main Model") wherever a job's model is displayed, never the
`endpoint/model-id` ref ("local/qwen3.8-27b-mtp").

- Add a helper in `apps/web/src/jobs/derive.ts` (or `ui/ModelPicker.tsx` next to
  `typeModelLabel`):

  ```ts
  /** "Main Model" for a ref or choice id; falls back to the ref when no choice matches. */
  export function modelDisplayName(nameOrRef: string, choices: readonly ModelChoice[]): string {
    const choice =
      pickedChoice(nameOrRef, choices) ?? choices.find((c) => c.ref === nameOrRef) ?? null;
    return choice?.label ?? nameOrRef;
  }
  ```

- Change `modelLabel(job)` to take `choices` and map each entry of `job.modelsUsed` (and
  `job.modelOverride`) through `modelDisplayName`, de-duplicated, joined with ", ". With
  neither, keep the existing fallback text.
- `JobDetailPanel` already receives `models` — pass it in. Drop the `mono` class on the
  Model `dd` (a label is plain text); put the ref(s) in a `title` attribute so the exact model
  is still one hover away.
- Apply the same helper to the Jobs list "Document type · model" cell so both pages agree.
  The pickers' "Runs `<ref>`" hint under a model select stays as it is (it explains what the
  label maps to).

## 6. Narrow screens (< 640 px)

- Upload controls stack (already the case via flex-wrap); Upload button full width.
- Progress switches back to the **vertical** list (the horizontal grid is too cramped at
  phone width): reuse the side-panel `.progress` styles inside the inset panel.
- Status and Details stack; Details loses its left border and padding.

## 7. Tests (minimum)

- `HomePage`: renders "Upload documents" before the latest job; no "All jobs" link.
- `JobDetailPanel wide`: headings Latest job / Progress / Status and actions / Details, and
  Published outputs only when there are published outputs.
- `progressSteps` unchanged; the wide panel renders five steps with their state text.
- `modelDisplayName`: choice id → label; `default` → default choice's label; ref → label;
  unknown ref → ref. `modelLabel` de-duplicates.
- Visual: light and dark match `screenshots/` at 1440 px.
