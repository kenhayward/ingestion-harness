# Workbench redesign — handoff for Claude Code

Scope: **only what is not in the repo yet** —
1. the Workbench **document type (project) list**, built for 100–1,000 projects;
2. the Workbench **document type screen** redesign: icon-only main menu on project pages,
   vertical tab rail with status icons, a new **Overview** process map tab, and the restyled
   stage-tab proposal card;
3. the **API calls** both need (W1–W4).

Everything else in `apps/web` stays as it is. Follow the repo's CLAUDE.md (test first,
ports and adapters, contracts changed on both sides in one PR, forward-only migrations).

## Contents of this pack

| Path | What it is |
| --- | --- |
| `WORKBENCH-HANDOFF.md` | This document |
| `screenshots/light/`, `screenshots/dark/` | 4 reference screens per theme, 1440 px wide (index below) |
| `design-tokens/tokens-workbench.css` | Only the **new** CSS variables (light, dark, System) — add to `apps/web/src/styles/tokens.css` |
| `prototype/prototype.html` | Clickable offline prototype of the whole app; open with `?screen=wblist` (list) or `?screen=workbench&wtab=overview` (project), add `&theme=dark` |

| Screenshot | Section |
| --- | --- |
| `10-workbench-list.png` | §1 Project list |
| `11-workbench-overview-map.png` | §2 Project screen, §3 Overview map |
| `12-workbench-steps-tab.png` | §4 Stage tab (proposal card) |
| `13-workbench-evaluate-tab-placeholder.png` | §4 Header pattern for the other tabs (body = existing component) |

All names, counts and scores in the screenshots are illustrative. Copy exact values from this
document and the tokens file, not from the PNGs.

## New design tokens

Existing tokens (`--ih-bg`, `--ih-surface`, `--ih-accent`, the `neutral/info/warn/alert/danger/ok`
tones, `--ih-page-well` …) are reused. New:

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--ih-skip-bg` / `--ih-skip-fg` | `#EDE8FB` / `#5B3BB0` | `#261D44` / `#C7B8FF` | Skipped stage (violet) |
| `--ih-lock-bg` / `--ih-lock-fg` | `#FBE6F0` / `#9B1D58` | `#3D1729` / `#F7A8CC` | Publish locked by the gate (rose) |
| `--ih-flow` | `#0A5BB0` | `#6FB0F5` | Main-flow connectors on the map |
| `--ih-side` | `#0E7C72` | `#3DD6C2` | Dashed "changes the draft" connectors |
| `--ih-band` / `--ih-band-bd` | `rgba(255,255,255,0.72)` / `#C9D2DE` | `rgba(255,255,255,0.035)` / `#2A374A` | Phase panels on the map |

All text/fill pairs measure ≥ 4.5:1 in both themes; connector colours ≥ 4:1 against the map
backdrop.

## 1. Workbench — project list — `workbench/WorkbenchPage.tsx`
Screenshot: `10-workbench-list.png`

Designed for **100–1,000 projects**: the server pages, filters, sorts and counts; the client never
holds the whole catalogue.

- **Header:** "Workbench" + existing description. Actions: **Import bundle** (secondary → the
  existing ImportBundle flow in a dialog) and **New project** (primary → dialog with Id, Name and
  the "leave the name empty to open an existing document type" hint).
- **Pinned and recent** (`section aria-label="Pinned and recent"`): up to 3 cards in an
  auto-fit grid (min 280 px). Each card: star, name, last activity, 10-segment progress strip +
  phase text, next action (status icon + text, tone coloured). Whole card opens the project.
  Pinned first, then most recently active, de-duplicated.
- **Filter chips** (`role=group aria-label="Filter projects"`), counts from the server facets,
  formatted `1,000`: **All · Needs you** (amber count) **· Running · Ready to publish · In
  progress · Published, no draft**. Selecting one resets to page 1.
- **Toolbar:** search (`aria-label="Search projects by name or id"`, debounce 250 ms, server
  side), **Phase** (Any / Prepare / Draft with the model / Verify and publish / Published, no
  draft), **Models** (Any / Local only / External allowed), **Sort** (Last activity — default /
  Name A–Z / Holdout score, lowest first / Fewest samples). Right-aligned range text
  "Showing 1–25 of 1,000".
- **Table** (`section aria-label="Projects"`, scroll box, sticky header row, min-width 1060 px):
  | Column | Content |
  | --- | --- |
  | Pin | Star toggle button, `aria-pressed`, `aria-label="Pin <name>"`; filled amber when pinned |
  | Document type | Name (600) + id (mono 11 px) stacked; `EXT` tag (warn tone) when `dataPolicy='external'`. Link → project Overview |
  | Progress | 10 segments (13×10 px, 2 px radius, 3 px gap) = Samples, Brief, Survey, Outputs, Sections, Steps, References, Evaluate, Revise, Publish; each `title="<Stage>: <state>"`; phase line under it ("Draft · 5 of 10 done"); cell `aria-label` spells out every stage |
  | Next action | Status icon (same set as the project page) + verb phrase, tone coloured; link → the right tab |
  | Versions | "Draft vN" (500) over "Live vM" / "Not published" (muted) |
  | Holdout score | % (ok when ≥ threshold, warn below, "—" when none) + 84 px bar with a 2 px tick at the project's `publishThreshold` |
  | Samples | total over "N dev · M hold" |
  | Activity | relative time |
- **Footer** (`nav aria-label="Pages"`): rows per page 25 / 50 / 100 (persist in `localStorage`
  `ih.wbPageSize`), legend of the segment colours + "Score tick = publish threshold", pager
  (‹ 1 2 3 … N ›, current page `aria-current="page"`).
- **Segment colours** (tokens): done = `ok-fg`; needs you = `warn-fg`; running = `accent`;
  stale = `alert-fg`; skipped = `skip-bg` fill + `skip-fg` border; ready (publish allowed) =
  `ok-bg` + `ok-fg` border; locked = `lock-bg` + `lock-fg` border; not started = transparent +
  dashed `border-strong`.
- **Next action rules** (pure function, table-tested) — first match wins:
  stale stage → "Refresh <Stage>"; proposed stage → "Decide on <Stage>"; brief empty → "Write the
  brief"; samples none/failed → "Add samples" / "Fix samples"; running → "<Stage> running";
  gate fails → "Holdout below <threshold>%"; gate passes → "Publish v<draft>"; no draft →
  "Start v<published+1>" (muted).
- **Empty / no match:** "No document types match. Clear the search or pick another filter."
- **Mobile:** pinned cards stack; toolbar wraps; table scrolls in its box. Preferred below 640 px:
  render rows as cards (name, progress strip, next action).

## 2. Workbench — project page shell — `workbench/ProjectPage.tsx`
Screenshots: `11-workbench-overview-map.png`, `12-workbench-steps-tab.png`,
`13-workbench-evaluate-tab-placeholder.png`

- **App nav collapses to icons** (68 px rail, tooltips + `aria-label` on each link) on project
  pages, to make room for the project's own tab rail. Labels return on every other screen.
- **Header:** back link "‹ Workbench"; H1 project name; "Developing vN" (info pill); "vM published
  · `<id>`". Right: data-policy pill ("Local models only", ok tone, lock icon / "External models
  allowed", warn tone), admin button **Allow external models…** / **Restrict to local models**
  (keep the existing confirm), **Publish vN** (shows a lock and is disabled-looking until the gate
  passes; `title` = gate reason; clicking opens Evaluate → Publish panel).
- **Vertical tab rail** (`nav aria-label="Project steps"`, 236 px, bordered panel) replaces the
  horizontal `workbench-tabs`. Groups with uppercase headings:
  - *(no heading)* **Overview** (new, default)
  - **Prepare:** Samples, Brief
  - **Draft with the model:** Survey, Outputs, Sections, Steps
  - **Verify:** References, Evaluate, Revise
  - **By hand:** Template, Test runs

  Each item: 17 px tab icon, label, and a **20 px status icon instead of the "· accepted" text**.
  Accessible name and tooltip carry the full status ("Sections: Stale — outputs changed after
  the anchors were accepted"). Active item: accent-soft background, 600 weight,
  `aria-current="page"`. A legend (2-column grid) sits at the bottom of the rail.
- **Status icon set** (20×20 viewBox, circle r 8.25 + glyph, stroke 2, round caps) — use one
  `StageStatusIcon` component everywhere (rail, map boxes, list, legends):
  | State (`StageState` / derived) | Circle | Glyph | Tone |
  | --- | --- | --- | --- |
  | `accepted` (and samples ready, brief saved, references verified) | filled | ✓ `M6 10.5l2.7 2.7L14 7.8` | ok |
  | `proposed` / needs you (incl. gate failing) | filled | ! `M10 5.6v5.2M10 14.1v.2` | warn |
  | `running` | `border` ring | ¾ arc `M10 3.6a6.4 6.4 0 1 1-6.4 6.4` | accent (animate rotation, respect `prefers-reduced-motion`) |
  | `stale` | filled | refresh `M13.6 8.2a4 4 0 1 0 .3 3.4M14 5v3.3h-3.3` | alert |
  | `skipped` | ring | arrow `M6 10h7M10.4 7l3 3-3 3` | skip (violet) |
  | `pending` | dashed ring `2.6 2.6` | — | border-strong |
  | locked (Publish, gate not passed) | filled | padlock `M7.4 9.4V8a2.6 2.6 0 0 1 5.2 0v1.4M6.6 9.4h6.8v4.8H6.6z` | lock (rose) |
  | none (Overview, Template) | — | — | — |
  Glyphs on filled circles use `--ih-surface`.
- **Tab → status mapping:** Survey/Outputs/Sections/Steps/References/Revise use `StageView.state`.
  Derived: Samples (all ready → accepted; any preparing → running; any failed or none → warn),
  Brief (saved → accepted; empty → warn), Evaluate (gate passes → accepted; latest evaluation
  running → running; below threshold → warn; never run → pending), Test runs (any unfinished →
  running; any awaiting review → warn; else accepted / pending), Template → none.
- **Router:** add `'overview'` to `PROJECT_TABS` (first) and make it the default when the hash has
  no tab: `#/workbench/<id>` → overview.

## 3. Workbench — Overview map (new tab)
Screenshot: `11-workbench-overview-map.png`

- **Next banner** (`role=note`): icon tile in the tone of the most urgent stage, title "Next:
  …", one-line reason, primary link to that tab. Urgency: stale > proposed (needs you) > gate
  failing > failed samples > empty brief > not started.
- **Map** — fixed 1020×640 canvas centred in a scroll box (`overflow-x: auto`), backdrop
  `--ih-page-well` with a 20 px dot grid (`radial-gradient(var(--ih-border-strong) 1px,
  transparent 1.2px)`).
  - **Phase panels** (rounded 14 px, `--ih-band` fill, `--ih-band-bd` border) group the boxes;
    label + stage range **top-right** so connectors never cross it:
    Prepare *stages 1–2* (x 8, y 8, 484×172) · Edit and test by hand *any time* (x 528, y 8,
    484×172) · Draft with the model *stages 3–6* (x 8, y 208, 1004×172) · Verify and publish
    *stages 7–10* (x 8, y 408, 1004×172).
  - **Boxes** 200×124, columns x = 20 + 260·c, rows y = 44 / 244 / 444:
    | Row | c0 | c1 | c2 | c3 |
    | --- | --- | --- | --- | --- |
    | 0 | 01 Samples | 02 Brief | Template | Test runs |
    | 1 | 03 Survey | 04 Outputs | 05 Sections | 06 Steps |
    | 2 | 07 References | 08 Evaluate | 09 Revise | 10 Publish vN |
    Each box is an `<a>` (`aria-label="<Title>: <status>. Open the <Tab> tab"`): header =
    28 px icon tile (surface fill, status-tone icon and inset border) + title + status icon;
    status line = mono stage number + status text in tone; two key/value metric rows at the
    bottom. **Fill by state:** accepted `ok-bg`, needs you `warn-bg`, running `info-bg`, stale
    `alert-bg`, skipped `skip-bg`, locked `lock-bg`, pending `surface` (dashed border), none
    `accent-soft`. Border: 1.5 px in the status tone (1 px `border` for accepted). Shadow
    `0 1px 2px rgba(15,27,45,.08), 0 6px 16px rgba(15,27,45,.10)`; the "Next" box adds a 4 px
    `alert-bg` ring. Publish opens Evaluate (Publish panel).
  - **Connectors** — one inline SVG under the boxes (`aria-hidden`):
    main flow **3 px `--ih-flow`** with filled arrowhead markers (markerWidth 4.5); side routes
    **2.5 px dashed (7 5) `--ih-side`** (teal). Paths:
    `H` arrows within rows (Samples→Brief, Template→Test runs, Survey→Outputs→Sections→Steps,
    References→Evaluate→Revise); Brief→Survey `M380 168V206H190V242`; Steps→References
    `M900 368V404H190V442`; Evaluate→Publish `M380 568V606H900V570` (label "publish when the
    gate passes", flow colour); Template→Sections dashed `M640 168V242` ("hand edits change the
    draft"); Revise→Sections dashed `M640 444V370` ("revision changes the draft"). Edge labels:
    11 px italic 600 in the line's colour on a `page-well` chip.
  - **Box metrics** (two each):
    | Box | Metric 1 | Metric 2 |
    | --- | --- | --- |
    | Samples | Dev · holdout counts | OCR pages of total pages |
    | Brief | Answers filled | Updated (relative) |
    | Template | Steps · sections | Last hand edit |
    | Test runs | Runs | Awaiting review |
    | Survey | Questions (answered) | Candidate fields · tables |
    | Outputs | Fields · tables | Changes applied (x of y) |
    | Sections | Sections | Anchors found (x / y dev) |
    | Steps | Proposed / applied changes | Model |
    | References | Dev verified x / y | Holdout verified x / y |
    | Evaluate | Dev score | Holdout score |
    | Revise | Feedback items | Last revision |
    | Publish | Needs holdout ≥ threshold | Live version |
- **Caption** under the map explains panels, colours of the arrows and what the Draft phase means.
- **Mobile:** banner and rail stack; the map scrolls horizontally inside its box. Preferred below
  760 px: replace the map with a vertical list of the same boxes in stage order (no connectors),
  grouped under the phase headings; the tab rail becomes a `<select>` or horizontally scrolling
  chip row.

## 4. Workbench — stage tabs
Screenshot: `12-workbench-steps-tab.png` (Steps as the reference design for Outputs, Sections,
Steps and Revise — all `StagePanel` users)

- Tab header: H2 (e.g. "Extraction steps"), status icon + text in tone, data-policy note
  (`POLICY_NOTE`). Right: **Propose again** (or the stage's first-run label), **Skip this stage**
  (when `canSkip`).
- **Proposal card** (`section aria-label="Proposal"`, border in the status tone): meta strip
  (model mono · brief vN · status · relative time) + the model's notes; one row per change:
  checkbox (`aria-label="Apply: <description>"`), kind tag (EXTRACT info / CHECK neutral /
  FIELD / TABLE / SECTION …), id in mono, `describeChange()` text, reason (muted), **Details**
  disclosure (JSON). For Sections keep the "found in x of y dev samples (missed: …)" line.
- Footer: **Apply N selected changes** (primary, count live), **Reject all** (danger text),
  "Edit by hand on the Template tab" link.
- Other tabs keep their current components, restyled with the tokens; the placeholder screenshot
  (`13-…`) only shows the header pattern every tab should use: H2 + status icon/text line.

## 5. API changes

### W1 — paged, filtered project list with facets (Workbench list, phase 1)

Today `GET /api/workbench/projects` returns every project unpaged with versions and sample count
only. Replace (keep the old shape behind `?all=1` until callers move):

```
GET /api/workbench/projects
  ?q=<name or id substring, ≤100 chars>
  &filter=all|attention|running|ready|progress|published
  &phase=prepare|draft|verify|published
  &policy=local|external
  &sort=activity|name|score|samples        (activity = lastActivityAt desc; score = asc, nulls last)
  &page=1&size=25|50|100
→ {
    items: ProjectListItem[];
    total: number;                                  // after all filters
    facets: { all; attention; running; ready; progress; published: number };  // ignore `filter`, honour q/phase/policy
  }
```

```ts
// packages/shared/src/workbench.ts
export interface ProjectListItem extends ProjectSummary {
  stages: { stage: OverviewStage; state: OverviewState }[];  // 10 entries, fixed order (below)
  phase: 'prepare' | 'draft' | 'verify' | 'published';
  done: number;                                              // stages complete, 0–10
  next: { kind: NextActionKind; stage: OverviewStage | null; label: string } | null;
  holdoutScore: number | null;                               // latest complete holdout iteration of the draft (else of the live version)
  devSamples: number;
  holdoutSamples: number;
  lastActivityAt: string;                                    // max of proposal/decision/sample/iteration/publication/brief times
}
export const OVERVIEW_STAGES = ['samples','brief','survey','outputs','sections','steps',
  'references','evaluate','revise','publish'] as const;
export type OverviewStage = (typeof OVERVIEW_STAGES)[number];
export type OverviewState = StageState | 'ready' | 'locked' | 'warn';   // ready = gate passes; locked = gate fails; warn = needs you (non-proposal)
export type NextActionKind = 'refresh' | 'decide' | 'brief' | 'samples' | 'running'
  | 'below_threshold' | 'publish' | 'start_version';
```

Facet definitions: **attention** = any stage `stale`/`proposed`/`warn` or gate failing with a
complete evaluation; **running** = any stage running or unfinished dev/holdout runs; **ready** =
gate passes on the open draft; **progress** = has an open draft; **published** = no open draft.

Implementation notes: compute per-project state in SQL where possible (stage states are derived
from proposals + skips + references — add a `workbench_project_state` view or a cached
`project_overview` jsonb column refreshed on every stage/sample/iteration/publication event).
At 1,000 projects do **not** compute stage states in a per-row loop on every request without
that cache. Add indexes for `lower(name)`/`id` search (`pg_trgm`) and `last_activity_at`.

### W2 — project overview aggregate (Overview map + rail icons, phase 1)

The map needs ~7 existing calls (`getProject`, `listStages`, `listProposals`, `listSamples`,
`listReferenceRows` ×2, `listIterations`, `getPublishGate`, `listJobs`). Add one:

```
GET /api/workbench/projects/:id/overview
→ {
    project: ProjectView;
    stages: { stage: OverviewStage | 'template' | 'runs'; state: OverviewState | 'none';
              status: string;                         // "Stale — outputs changed after the anchors were accepted"
              metrics: { label: string; value: string }[];   // exactly 2, as in the §3 metrics table
            }[];
    next: { stage: OverviewStage; title: string; reason: string } | null;
    gate: GateView;
  }
```

Polled every `pollMs` (3 s) while any stage is `running`, otherwise on focus. The rail uses the
same payload, so switching tabs never refetches it.

### W3 — pinned projects (Workbench list)

Per signed-in token, server-side so pins follow the person across browsers:

```
GET    /api/workbench/pins            → string[]   (project ids, most recent first)
PUT    /api/workbench/pins/:projectId → 204
DELETE /api/workbench/pins/:projectId → 204
```

Migration `NNNN_workbench_pins.sql`: `(token_id, project_id, pinned_at)`, PK (token_id,
project_id), FK cascade on project delete. Phase 0 fallback: `localStorage` key `ih.wbPins`
(try/catch). "Recent" = the 3 most recently active projects the token opened
(`ih.wbRecent`, client-side).

### W4 — router / UI only (no API)

- `PROJECT_TABS` gains `'overview'` first; default tab = overview.
- App nav compact mode on `route.name === 'project'`.
- `StageStatusIcon`, `ProgressStrip` (10 segments), `NextAction` and `PhasePanel` primitives in
  `apps/web/src/ui/` with tests (role/label queries; every icon state has an accessible label).

### Derived client logic (pure functions, table-driven tests)

| Function | Input → output |
| --- | --- |
| `overviewState(stage, inputs)` | → `OverviewState`, incl. derived Samples / Brief / Evaluate / Test runs (§2) |
| `nextAction(states, gate, draft)` | → `{kind, stage, label}` (rules in §1) |
| `phaseOf(states, draft)` | → prepare / draft / verify / published + `done` count |
| `urgency(states)` | → most urgent stage for the Next banner (§3) |
| `stageStyle(state)` | → `{fill, ring, glyph, path, tone}` — the single mapping used by rail icons, map boxes, list segments and legends |

## 6. Implementation plan (one PR each)

1. **Tokens + primitives** — add the new tokens; `StageStatusIcon`, `ProgressStrip`
   (10 segments), `NextAction`, `PhasePanel` in `apps/web/src/ui/`; the derive functions above.
   Tests: every state renders with an accessible label; one `stageStyle` mapping feeds all.
2. **Project screen shell** — `PROJECT_TABS` gains `overview` (default); app nav compact mode on
   project routes; vertical tab rail with status icons and legend replacing `workbench-tabs`;
   header with data-policy pill and gated **Publish vN**. Works on existing calls first.
3. **API W2** — `GET /api/workbench/projects/:id/overview` + `fakeApi()`; switch the rail to it.
4. **Overview map** — phase panels, boxes, connectors, Next banner; below 760 px a stacked list.
5. **Stage tabs** — `StagePanel` proposal card restyle; other tabs adopt the header pattern.
6. **API W1** — paged/filtered/sorted list with facets and cached project state
   (`project_overview`), `pg_trgm` search index, seed script for 1,000 projects.
7. **Project list UI** — chips, toolbar, table, pager; pins via `localStorage` (`ih.wbPins`).
8. **API W3** — server-side pins + migration; move the list to it.

## Definition of done

- Both screens match their screenshots in light, dark and System modes.
- `GET /api/workbench/projects` p95 < 200 ms with 1,000 seeded projects on dev-infra
  (integration test).
- Rail icons, map boxes, list segments and legends all use the same state → style mapping.
- At 390 px: nothing scrolls the page sideways; map becomes a list, tabs a select, list rows cards.
- Contract changes in `packages/shared` and the worker/API in the same PR; `npm run check` green.
