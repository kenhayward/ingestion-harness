> **In this repo:** the Markdown and `tokens.json` from the UI handoff. The screenshots, prototype and
> design source stay out of git (size); `tokens.css` lives at `apps/web/src/styles/tokens.css`.
> Decisions that differ from this handoff are recorded in the PR plans under
> `docs/superpowers/plans/2026-10-12-ui-*.md`.

# UI redesign handoff — Ingestion Harness

Handoff for Claude Code: implement the new look and feel across `apps/web` (and the small API
additions it needs). Read this file first, then `SPEC.md`, then `FEATURES_AND_API.md`.

## What's in this folder

| Path | What it is |
| --- | --- |
| `README.md` | This file: goals, principles, implementation order, definition of done |
| `SPEC.md` | Screen-by-screen spec: layout, components, states, behaviour, a11y |
| `FEATURES_AND_API.md` | Every new feature, whether it needs API/worker/contract changes, and the exact calls |
| `design-tokens/tokens.css` | Light + dark colour tokens, type, radius, spacing — drop into `apps/web/src/styles/` |
| `design-tokens/tokens.json` | Same values as data (for tests or a TS constant) |
| `screenshots/light/*.png`, `screenshots/dark/*.png` | Rendered reference for every screen (1440 px desktop; `-mobile` = 390 px) |
| `prototype/prototype.html` | Self-contained clickable prototype (fonts embedded, works offline). Query params: `?theme=light\|dark\|system&screen=jobs\|review\|results\|types\|editor\|access\|signin&signin=default\|ended\|error&density=comfortable\|compact` |
| `design-source/Main.dc.html` | The design source the prototype is generated from (all colours, copy, spacing, sample data in one file) |

The screenshots and prototype are the **visual source of truth**. Copy exact values (colours,
radii, paddings, font sizes) from `tokens.css` / `Main.dc.html` rather than eyeballing PNGs.
All data shown (filenames, invoice values, metrics, scores, token labels) is **illustrative**.

## Design principles (keep these when making judgement calls)

1. **Most actions are one or two clicks away.** Upload is always in the top bar. Each list row
   shows the single most likely action for its status (Review / Retry / Cancel / View); the rest
   go in a ⋯ menu. Destructive actions (Delete, Reject, Revoke) always take a second,
   deliberate click (inline confirm — the existing pattern, keep it).
2. **List + detail panel, not page hops.** Jobs and Results select a row into a right-hand panel;
   Review and Editor are full screens with a back link to their parent.
3. **Status is colour + label + shape.** Pills always carry text; tones differ in lightness, not
   just hue. Six tones: `neutral`, `info`, `warn` (awaiting reviewer), `alert` (needs_review,
   operator problem), `danger` (failed/revoked), `ok`.
4. **Light, dark and System.** A three-way segmented switch in the top bar (and on sign-in).
   Persist the choice per browser in `localStorage` key `ih.theme` (wrap in try/catch like
   `ih.uploadModel`). `system` = no `data-theme` attribute → `prefers-color-scheme` decides.
5. **Calm, dense, readable.** IBM Plex Sans (UI) + IBM Plex Mono (ids, model refs, regex, tokens,
   file names in output lists). 14 px base. No gradients, no emoji, inline stroke SVG icons.
6. **Accessible as drawn.** Real `<button>`/`<a>`/`<input>`+`<label>`; icon-only buttons get
   `aria-label`; text contrast ≥ 4.5:1 in both themes (tokens are chosen for this); 40–44 px
   targets for primary controls.

## Fonts

Google Fonts is fine for production, but for offline/LAN deploys prefer self-hosting:
`npm i -w apps/web @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono` and import weights
400/500/600 (sans) and 400/500 (mono) in `main.tsx`.

## Suggested implementation order (one PR each, TDD per CLAUDE.md)

1. **Foundations** — `tokens.css`, theme hook (`useTheme`: `light|dark|system`, persisted,
   sets `document.documentElement.dataset.theme`), base element styles, shared primitives:
   `Button` (primary/secondary/danger/ghost/icon), `StatusPill`, `Chip`/`FilterChips` (with
   counts, `aria-pressed`), `Segmented`, `Panel`, `Tabs` (role=tablist), `DataGrid` row layout.
2. **App shell** — top bar (brand, search box, theme switch, Upload PDF, user chip + sign out),
   left nav with "needs attention" badge and Admin section, responsive stacking.
3. **Jobs** — upload strip (multi-file), filter chips, job list, detail panel.
4. **Review** — PDF viewer + data tabs + sticky decision bar.
5. **Results** — filters, list, preview panel (+ API: outputs in summary, `q` filter).
6. **Document types** — card grid (+ API: list summary).
7. **Editor** — header actions, tabs, pipeline step cards, test rail.
8. **Access + Sign in.**
9. **Optional follow-ups** — job progress, evidence bounding boxes, global search, re-run test
   on last sample (see `FEATURES_AND_API.md` → "Optional / phase 2").

## Testing notes (match the repo's conventions)

- Web components keep taking the `Api` port; extend `fakeApi()` for any new method/field.
  Query by role/label, never class names — the spec lists the accessible names to use.
- Theme: test that the switch sets/clears `data-theme`, persists to `ih.theme`, survives blocked
  storage, and that `aria-pressed` reflects the choice.
- Derived client logic (attention counts, chip filters, "next awaiting review", "next flagged",
  "expires soon", primary-action-per-status) should be pure functions with table-driven tests.
- Any API/DTO change: update `packages/shared` Zod schemas + the Python side in the same PR
  (cross-language contract table in CLAUDE.md), add route tests via `app.inject()`.

## Definition of done (in addition to CLAUDE.md's)

- Every screen matches its screenshot in both themes and in System mode.
- At 390 px width: nav stacks above content, toolbars wrap, wide lists scroll inside their box
  (or render as cards — see SPEC), nothing scrolls the page horizontally.
- `npm run check` green.
