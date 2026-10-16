# CT Studio — Administration modal + Models tab redesign — handoff for Claude Code

> Implemented in one PR. Decisions made then: messages that named the old pages now say
> *Administration > Models* / *Linked data* / *Access*; the menu item carries no Admin tag; the
> offline prototype is not kept in the repo. The screenshots still show the old top-bar upload
> button, removed earlier, and Profile for the admin from the log, which it does not get.

Scope:

1. Move **Models**, **Linked data** and **Access** out of the left nav and the account menu into
   one **Administration** modal opened from the account menu (admins only).
2. **Delete** the `#/models`, `#/linked-data` and `#/access` routes. No redirects.
3. Re-lay out the **Models** tab (it was too busy): choices as a list with an **Add choice ▾**
   dropdown; endpoints as collapsible rows; offered models as a list with an
   **Offer a model ▾** dropdown.

**No new API calls, no new fields, no new colours** (existing tokens only). Linked data and
Access keep their current content and behaviour; they just render inside the modal.
Follow the repo's CLAUDE.md (test first, small PRs). Suggested PRs: (a) modal + menu + route
removal, (b) Models tab layout.

## Contents

| Path | What it is |
| --- | --- |
| `HANDOFF.md` | This document |
| `screenshots/light/`, `screenshots/dark/` | Same set in both themes |

| Screenshot | Shows |
| --- | --- |
| `01-account-menu.png` | Account menu with **Administration** first |
| `02-models-tab.png` | Models tab, resting state |
| `03-models-add-choice-dropdown.png` | Add choice ▾ open: offered models grouped by endpoint |
| `04-models-name-new-choice.png` | A model picked: inline form to name the choice |
| `05-models-row-actions-menu.png` | `⋯` row menu: Make default / Edit / Remove |
| `06-models-endpoint-expanded.png` | `local` endpoint expanded: connection + models offered |
| `07-models-offer-a-model-dropdown.png` | Offer a model ▾ open: discovered models + add by id |
| `08-linked-data-tab.png`, `09-access-tab.png` | The other two tabs inside the modal |
| `10-models-tab-1024.png` | 1024 × 768: modal fills the viewport minus 16 px |

Mock data (endpoints `local` / `anthropic`, choices Main Model / Fast / Vision / Claude Sonnet,
model display names) is illustrative. Use the real data.

---

## 1. Account menu (`shell/AppShell.tsx`, `AccountMenu`)

- Remove the three admin `<a role="menuitem" href="#/models|#/linked-data|#/access">` items.
- Add, **first**, for `me.role === 'admin'` only: a `button role="menuitem"` with
  `Icon name="shieldCheck"` and "Administration", plus a small `tag tone-info` "Admin"
  on the right (optional; drop it if it reads as noise). Clicking closes the menu and calls a new
  prop `onAdmin()`.
- The rest is unchanged: Profile (still only when `me.email !== null`; the prototype shows it for
  the token admin, ignore that), Install (admin && onInstall), separator, Sign out.
- The admin signed in with the startup token (no email) **does** get Administration.

## 2. Left nav (`AppShell`)

Delete the `me.role === 'admin'` block: the "Admin" `nav-heading` and the three `NavLink`s.
Nothing replaces it.

## 3. Routes — delete, no redirect

- `router.ts`: remove `{ name: 'models' }`, `{ name: 'linked-data' }`, `{ name: 'access' }` from
  `Route`, and the three `parseHash` lines. `#/models` etc. now fall through to Home like any
  unknown hash. Update the doc comment on `useHashRoute` if it lists them.
- `shell/derive.ts`: remove `'access' | 'models' | 'linked-data'` from `Section` and their
  entries in `SECTION` and `PAGE`.
- `App.tsx`: remove the three `route.name === …` branches. The page components stay (they become
  tab bodies, §4).
- Fix any tests that navigate to those hashes.

## 4. Administration modal (`access/AdminDialog.tsx`, new)

Same structure and classes as `ProfileDialog` so it inherits the look; only the size differs.

```tsx
type AdminTab = 'models' | 'linked-data' | 'access';
<AdminDialog api={api} me={me} onClose={() => setAdmin(false)} />
```

- **App.tsx**: `const [admin, setAdmin] = useState(false)`; pass `onAdmin={() => setAdmin(true)}`
  to `AppShell`; render `{admin && <AdminDialog …/>}` next to `ProfileDialog`. No route, no hash.
- **Shell**: `<div className="dialog-backdrop">` with **no** click handler, and Escape does
  **not** close it (same as Profile). Only the footer **Close** closes. `useModalFocus(box)`
  for the focus trap; return focus to the account trigger on close.
- **Box**: `.dialog.profile-dialog.admin-dialog` with
  `width: min(1180px, 100vw - 32px); height: min(820px, 100vh - 32px)`.
- **Side panel** (`.profile-side`, 260 px, `--ih-surface2`): `.profile-id` with
  `Avatar size="large"` + `me.label` (token admin → initials "AD" and "Admin token").
  `role="tablist" aria-label="Administration sections" aria-orientation="vertical"` with
  Models (`chip`), Linked data (`link`), Access (`key`); arrow-key navigation exactly as Profile.
  Default tab: Models. Optional: remember the last tab per browser (`ih.adminTab`, try/catch)
  like other view prefs.
- **Main** (`.profile-main`): `.profile-header` = `h2` "Administration" + muted "/ {tab}" and,
  right-aligned, the tab's primary action (Models → **Add endpoint**, Access → **Add user**,
  Linked data → none). Move each page's `page-header` button here; drop the page's own `h1`
  and keep its description as the first line of the body.
- **Body** (`.profile-body`, `role="tabpanel"`, scrolls, `padding: 20px 24px`): render
  `ModelsPage` / `LinkedDataPage` / `AccessPage` with a new `embedded` prop that skips their
  page header (or extract the bodies into `ModelsPanel` etc.; your call).
- **Footer** (`.profile-footer`): Close.
- **AccessPage `query`**: it filtered by the top-bar search, which is now behind the scrim. Pass
  `query=""`; the status filter chips still work. Don't add a new search box here.
- Nested dialogs (Add endpoint, Add user, confirmations) open above the admin modal; their
  Escape must not bubble to the admin modal (`Dialog` already calls `stopPropagation`).

## 5. Models tab — new layout

Three sections, `gap: 26px`. Section head: `h3` 15 px / 600 (with a muted " · n" count where
shown) and a one-line 13 px muted description. Every behaviour and API call is unchanged
except where noted.

### 5.1 Model choices (`models/ChoicesSection.tsx`)

**Head row**: title + description left; **Add choice ▾** right (secondary 34 px, `plus` icon,
`chevronDown`; open state: `--ih-accent-soft` bg, `--ih-accent` border).

**List** (`ul aria-label="Model choices"`, card border/radius 12). Each `li` one row,
`padding: 12px 16px`, `border-bottom: --ih-border-soft`:

| Part | Spec |
| --- | --- |
| Tile | 32 × 32, radius 8, `chip` 18 px. Default choice: `--ih-accent-soft` / `--ih-accent-soft-text`; others `--ih-surface2` / `--ih-muted`. `aria-hidden` |
| Text | **Label** 14 px 600 + `tag tone-ok` "Default"; description below, 12 px muted, one line with ellipsis |
| Model (right, max 260 px) | Model **display name** 13 px, endpoint name below 12 px muted (`anthropic · external` when external). Ref (`endpoint/model-id`) only in `title`. Fallback to the ref when no display name is known |
| `⋯` | 32 px icon button, `aria-label="Actions for {label}"`, `aria-haspopup="menu"` |

**Row menu** (popover 190 px, radius 10, `--ih-surface`, shadow): **Make default** (`check`;
hidden for the default row), **Edit** (`pencil`), separator, **Remove** (`trash`,
`--ih-danger-fg`; hidden for the default row, as today). Edit swaps the row for today's inline
edit form (label, description, `ModelSelect`, Save/Cancel), laid out like §5.1's new-choice form.
Remove keeps today's confirm.

**Add choice ▾ dropdown** (`role="dialog" aria-label="Add a model choice"`, 400 px,
right-aligned under the button):

- Search input at the top (focused on open), filters by display name and model id.
- `role="listbox"` grouped by endpoint (`role="group"`, small-caps head: endpoint name in mono +
  "· local/external"). Items = `offeredRefs(endpoints)`, the same source as today's
  `ModelSelect`. Each `role="option"`: display name 13 px 500, model id mono 11 px muted, a muted
  "Used by {label}" when a choice already uses that ref (still selectable), `plus` icon right.
- Footer note on `--ih-surface2`: "Only models an endpoint offers are listed. Offer more under
  Endpoints."
- Keyboard: ↑/↓ moves, Enter picks, Escape closes the dropdown only.

**After picking**: the dropdown closes and an inline form appears as the **first** item of the
list (`--ih-accent-soft` background): the model (tile, display name, `endpoint · model-id`) with
**Change model** (reopens the dropdown); **Label** (pre-filled with the display name, max 80,
focused and selected) and **Description (optional)** (max 300) side by side; **Cancel** /
**Add choice** (primary). Submit = today's `createModelChoice`. Validation and errors unchanged.

### 5.2 Pipeline models (`PipelineSection`)

One card with a 3-column grid (`repeat(auto-fit, minmax(220px, 1fr))`): **OCR model**,
**Drafting model**, **Embedding model**, 12 px muted labels over 36 px selects. Options show
"{display name} · {endpoint}" (value stays the ref). Keep "Not set" and
"None (lexical retrieval)". Saves on change via `setLlmSettings` as today. Keep the existing
section description text (the prototype's line is a placeholder).

### 5.3 Endpoints (`ModelsPage` / `EndpointCard`)

One card holding a row per endpoint (`border-bottom: --ih-border-soft`).

**Collapsed row** = a full-width `button aria-expanded`: `chevronDown` (rotated −90° when
collapsed) · **name** (mono 14 px 600) · `tag tone-neutral` kind (`KIND_LABEL`) · muted
"Local|External · {sourceText}" · right: "{offered} of {known} offered" 13 px + status pill
(`tone-ok` "Enabled" / `tone-neutral` "Disabled"). All collapsed by default; several may be open.
Expanded row background `--ih-surface2`.

**Expanded body** (`padding: 4px 16px 16px 50px`, two flex columns, wrap):

- **Connection** (small-caps label), `dl` grid:
  - Base URL: mono value + `pencil` icon button → today's inline edit.
  - Location: today's `Segmented` (Local / External) + hint.
  - Key: today's key text + **Set key** / **Remove key**.
  - Buttons: **Discover models** (refresh icon), **Enable/Disable**, and **Remove endpoint**
    (UI-sourced only, with today's confirm). For `.env` endpoints show the muted note
    "Set in .env, so it can't be removed here."
  - Notices and errors under the buttons, as today.
- **Models offered · n** (small-caps label) with **Offer a model ▾** (30 px secondary) at the
  right, then a list (`ul`, border `--ih-border-soft`, radius 10). Each offered (curated) model
  is one row: display name 13 px 500 + model id mono 11 px muted · "Max output [n] tokens"
  (today's `OutputLimit`, 76 px right-aligned number input, MIN/MAX and save unchanged) ·
  `×` icon button `aria-label="Stop offering {name}"`.

**Offer a model ▾ dropdown** (380 px): small-caps "Discovered on {endpoint}", then a listbox of
known-but-not-offered models (today's unchecked checkboxes), with `tag tone-info` "Suggested"
where today shows "suggested"; then a footer on `--ih-surface2`: "Not listed? Add by model id"
+ input (mono) + **Add** (today's add-model-id).

**Behaviour change (only one):** there is no **Save models** button any more. Offering (pick or
add-by-id) and `×` each call `setLlmEndpointModels(name, nextSelected)` immediately with the full
new list; disable the controls while it runs and show errors in the endpoint's notice line.
Removing a model that a choice or pipeline setting uses: keep whatever the API does today
(error or stale ref), and surface its message.

### 5.4 Add endpoint

Unchanged dialog, opened from the modal header button.

## 6. Narrow screens

The modal uses the viewport minus 16 px each side (`10-…`). At ≤ 760 px it inherits Profile's
existing `@media (max-width: 760px)` rules (column layout, small avatar in a row, horizontal
scrolling tab strip), since it reuses the `profile-*` classes. Pipeline selects stack; endpoint body columns wrap; choice
rows keep the model column but let it shrink with ellipsis.

## 7. Accessibility

- `role="dialog" aria-modal="true" aria-labelledby` the `h2`; tabs/tabpanel wired as in Profile.
- Dropdowns: trigger `aria-haspopup` + `aria-expanded`; listbox options are buttons with
  `role="option"`; Escape closes the dropdown, not the modal; focus returns to the trigger.
- Row menu: `role="menu"`/`menuitem`, arrow keys, Escape closes.
- Endpoint rows: `button aria-expanded`, body follows in DOM order.
- Refs remain available via `title` wherever a display name replaces them.

## 8. Tests (minimum)

- Account menu: admin sees Administration first (token admin too); a `user` does not. Models /
  Linked data / Access links are gone from the menu and nav.
- `parseHash('#/models' | '#/linked-data' | '#/access')` → `{ name: 'home' }`.
- AdminDialog: opens on Models; tabs switch panels and the header action (Add endpoint / none /
  Add user); backdrop click and Escape do **not** close; Close does; focus returns to the trigger.
- Choices: rows show label, Default tag, display name (ref in `title`); `⋯` menu hides Make
  default and Remove on the default row; Add choice dropdown lists `offeredRefs` grouped by
  endpoint with "Used by …"; picking pre-fills Label and Add calls `createModelChoice`.
- Pipeline: three selects save via `setLlmSettings` as before.
- Endpoints: collapsed by default with "n of m offered"; expanding shows Connection + offered
  list; `×` and Offer call `setLlmEndpointModels` with the right list; add-by-id works; `.env`
  endpoints show no Remove; OutputLimit still saves.
- Linked data and Access behave as before inside the modal.
- Visual: light and dark match `screenshots/` at 1440 × 900.
