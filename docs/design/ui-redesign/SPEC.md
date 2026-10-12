# Screen spec

Reference images: `screenshots/{light,dark}/NN-*.png`. Exact styles: `design-source/Main.dc.html`
and `design-tokens/tokens.css`. Existing components to evolve are named per screen.

---

## 0. App shell (all signed-in screens) — `App.tsx`

**Top bar** (surface, bottom border, 12 px × 24 px padding, wraps on narrow screens):

| Element | Detail |
| --- | --- |
| Brand | 30 px accent square with three bars icon + "Ingestion Harness" (600, 15 px). Links to Jobs. |
| Search | 40 px field, `aria-label="Search jobs, results and document types"`, `Ctrl K` hint (`<kbd>`). Phase 1: filters the current list client-side; phase 2: global search API. |
| Colour mode | Segmented group `role=group aria-label="Colour mode"`: Light / Dark / System buttons with `aria-pressed`. |
| Upload PDF | Primary button; navigates to Jobs and focuses the upload strip (opens file picker). |
| User chip | Initials avatar + `me.label` + `me.role`; icon button `aria-label="Sign out"` → `api.logout()` then sign-in screen. |

**Left nav** (`nav aria-label="Main"`, 220 px basis, stacks above content below ~800 px):
Jobs (badge = count of jobs needing attention: `awaiting_review + needs_review + failed`,
`aria-label="N need attention"`, amber), Results, Document types; then an uppercase "Admin"
label and **Access** (only when `me.role === 'admin'`). Active item: accent-soft background,
600 weight, `aria-current="page"`. Review highlights Jobs; Editor highlights Document types.

**Page header pattern:** H1 22 px/600 + one-line muted description; optional back link
("‹ Jobs") above the H1 on child screens; right-aligned actions.

---

## 1. Jobs — `components/UploadForm.tsx`, `JobsTable.tsx`, `JobCleanup.tsx`
Screenshot: `01-jobs.png`, `01-jobs-mobile.png`

- **Header:** "Jobs" + "Upload a PDF, watch it run, review what was extracted." Right: live
  indicator (green dot, "Live · refreshes every 3 s"; switch to warn "Reconnecting…" when the
  poll fails).
- **Upload strip** (`form aria-label="Upload document"`, dashed border): drop zone label
  ("Drop PDFs here or browse", sub "Several at once — each becomes its own job"; accepts
  multiple files and drag-and-drop), Document type select, Model select (remembered as today),
  Upload button. Multiple files → one `upload()` per file, sequentially, with a per-file status.
- **Filter chips** (`role=group aria-label="Filter jobs by status"`): All · Needs attention ·
  In progress (queued, running) · Finished (succeeded, rejected, cancelled) — each with a count.
  Needs attention count is always amber.
- **Job list** (scroll box; columns: Document · Document type · model · Status · Created · Actions):
  - Document cell is a button (`aria-label="Show details for <file>"`) that selects the row;
    second line = context note (progress text, first review reason, or error) — amber/red
    for attention statuses.
  - Status pill: Queued (neutral), Running (info), Awaiting review (warn), Needs review (alert),
    Failed (danger), Succeeded (ok), Rejected (neutral), Cancelled (neutral).
  - **One primary action per status:** awaiting_review → **Review** (filled accent, goes to
    Review); succeeded → View (Review read-only); failed / needs_review / cancelled → Retry
    (uses the upload strip's model, as today); queued / running → Cancel (inline confirm).
    Plus ⋯ "More actions for <file>" menu: Retry with another model…, Open PDF, Delete (inline
    confirm, deletable statuses only).
  - Selected row: `selRow` background. Footer: "Showing N of M jobs" + "Clean up finished
    jobs…" (opens the existing JobCleanup flow in a dialog/popover).
- **Detail panel** (`aside aria-label="Job details"`): file name, status pill; callout for
  non-finished jobs ("Needs a reviewer" / "Stopped — operator action needed" / "Failed" …)
  with the reason; **pipeline progress** list (Text & OCR → Sections → Extraction →
  Validation → Review & publish; states done ✓ / running / waiting for you / stopped ! / todo);
  meta grid (Document type, Model, Attempts, Created); outputs (draft before review,
  published after) as download links with row counts; status-specific actions
  (e.g. awaiting_review: **Review & approve** + Open PDF; failed: Retry, Retry with another
  model…, Delete).
- **Mobile:** upload strip fields stack; chips wrap; list scrolls horizontally inside its box
  (acceptable) — preferred: below 640 px render each job as a two-line card (file + status
  pill / note + primary action). Detail panel moves below the list.

## 2. Review — `review/ReviewPage.tsx`, `PageViewer.tsx`, `EditableValue.tsx`
Screenshot: `02-review.png`, `02-review-mobile.png`

- **Header:** back link "‹ Jobs", H1 = file name, meta row (Document type · vN, status pill,
  model in mono). Right: "1 of N awaiting review" + **Next document ›** (next
  `awaiting_review` job by createdAt; hidden when none).
- **"Why this needs review"** banner (warn tone, `role=note`) listing `reviewReasons`.
- **Two panes** (wrap below ~1000 px):
  - **Source PDF** (`section aria-label="Source PDF"`): toolbar with Previous/Next page icon
    buttons, "Page X of N", hint "Click a value to find it on the page"; page image on a
    recessed "page well" background. When a value is selected and it has a page, jump there.
    Phase 2: draw a labelled highlight box (accent; amber when flagged) at the evidence bbox.
  - **Extracted data** (`section aria-label="Extracted data"`): tabs `Fields (9)`,
    one per table `Line items (14)`, `Edits (n)`, `Steps (n)`; tabs with flagged content get an
    amber count. Right of tabs: **Next flagged (n)** cycles through flagged fields/cells
    (switching tabs as needed).
    - Fields grid: Field (name + `id · type` in mono, button selects), Value (boxed; amber
      border when flagged with flag text below; blue border + "Edited by X · was Y" when
      edited; pencil icon button `aria-label="Edit <name>"` → existing inline editor), Evidence
      (italic quote + "p. N" link).
    - Table tabs: "Flagged rows only" checkbox; flagged cells get warn background + tooltip.
    - Edits: chronological log (field/cell, old → new, who, when, reason).
    - Steps: per extract step id, what it fills, last run (model · attempts · status · tokens),
      **Re-run** opens the inline re-run form (model, pages as images, guidance, Queue re-run /
      Cancel) — same fields as today.
- **Decision bar** — sticky to the bottom of the viewport: Reviewer (remembered, as today),
  Note (optional), **Reject…** (secondary, danger text) and **Approve and publish** (primary,
  check icon). Reject… swaps the note for "Rejection reason (required — rejecting is final)"
  with danger border, plus **Keep reviewing** and **Reject document** (danger fill).
  For succeeded jobs the bar becomes "Save as reference" (name + button) as today; for
  rejected/other statuses a read-only line.

## 3. Results — `results/ResultsPage.tsx`, `ResultDetail.tsx`
Screenshot: `03-results.png`

- Header: "Results" + "Published outputs in the target store. Test runs and rejected documents
  never appear here."
- Toolbar: document-type filter chips (All types + one per type), filename filter field
  (`aria-label="Filter by file name"`).
- List (Document · Document type · Published · Reviewed by · Issues · Download): file name
  button selects the row into the preview; Issues shows "—" for 0, amber 600 otherwise;
  **CSV** / **JSON** download links per row (`aria-label="Download <file> as CSV"`).
  "Load more" keeps the existing cursor paging.
- Preview panel (`aside aria-label="Result preview"`): file, "type vN · published <when> ·
  reviewed by X | auto-approved", fields as a key/value list, first 3 rows of the first table,
  **Open full result** (→ existing ResultDetail) and **View source PDF**.

## 4. Document types — `templates/TemplatesPage.tsx`
Screenshot: `04-document-types.png`

- Header: "Document types" + "What each PDF looks like and what to extract. Published versions
  are immutable; edit a draft." Actions: **Import YAML** (opens the existing import form in a
  dialog, "Publish if valid" checkbox) and **New document type** (dialog: Id, Name).
- Card grid `repeat(auto-fit, minmax(min(340px,100%),1fr))`. Card: icon, name (H2 16 px), id
  in mono; pills "Published vN" (ok) or "Not published" (neutral) and "Draft vN" (info);
  shape line "5 sections · 9 fields · 1 table"; quality line (regression "x of n references
  match" / "Draft vN has k validation issues" in amber / "No reference documents yet").
  Actions: primary **Edit draft vN** or **New draft from vN**, **Test run** (file picker →
  `testRun`), icon **Export YAML**.

## 5. Document type editor — `templates/TemplateEditor.tsx`, `QualityPanel.tsx`
Screenshot: `05-editor-pipeline.png`

- Header: back "‹ Document types"; H1 name + "Draft vN" pill + "from published vM ·
  `<id>`". Right: unsaved indicator (amber dot "Unsaved changes"), icon Export YAML, ⋯ (Delete
  draft, inline confirm), **Publish vN** (disabled with `title`/tooltip explaining why: "Save
  the draft before publishing" or "Fix N validation issues"), **Save draft** (primary).
  Published versions: replace Save/Publish with **New draft from vN**. Validation issues list
  under the header (alert tone) when present.
- Tabs (underline style, counts): General · Sections 5 · Outputs 9 · 1 · Pipeline 4 · YAML ·
  Quality. Keep `role=tablist`/`tab`, `aria-selected`.
  - **General:** two-column form: Name, Review (`on_warnings` described as "only when a check
    flags something"), Description, Preamble (mono textarea + hint), OCR, Date order, Copy
    anchor (mono + hint), Page markers checkbox.
  - **Sections:** editable grid: order (up/down icon buttons), Section ID, Anchor (mono),
    Required checkbox, remove icon; "Add section" dashed button.
  - **Outputs:** Fields grid (ID mono, Name, Type tag, Description) + one card per table
    (columns grid) + "Add field" / "Add table".
  - **Pipeline:** ordered list of step cards. Collapsed: number badge, kind tag (EXTRACT info /
    CHECK neutral), id (mono), one-line summary ("Table line_items · 2 pages per call ·
    <model>"), up/down/remove. Header is a button with `aria-expanded`; one card open at a time,
    open card gets accent border. Extract body: Step id, Fills segmented (Fields | A table),
    Model (datalist of models), Chunk pages (table) or Page images (fields), Max attempts,
    chips-with-checkbox for fields/table it fills and sections it reads, Context (mono) and
    Instructions textareas. Check body: Check id, Values, Reference, Aliases, Max distance.
    "Add extract step" / "Add check step".
  - **YAML:** large mono textarea on `codeBg` + Apply YAML.
  - **Quality:** existing QualityPanel restyled — Metrics by version table (status pill per
    version), Changes (diff — keep it), Regression against references (Run regression on vN,
    rows with score coloured ok/warn and differences text), references management.
- **Right rail "Test this draft"** (`aside`): drop zone for a sample PDF ("Test runs are
  reviewable but never published"), primary "Run test on <last sample>" (phase 2, otherwise
  "Run test"), **Recent test runs** list (file, when, status pill) — each opens Review.

## 6. Access — `access/AccessPage.tsx`
Screenshot: `06-access.png`

- Header: "Access" + "People sign in with an access token. Issue a token per person or machine;
  revoking one ends its sessions immediately."
- **Issue a token** card (`form aria-label="New token"`): Label (maxLength 100, placeholder
  "e.g. Ken – laptop"), **Expires after** segmented buttons (1 day / 7 days / 30 days default /
  90 days / 1 year / Never, `aria-pressed`), **Create token**. Side note card "The admin token
  rotates" (info icon) explaining the API-log admin token.
- **New token panel** (after create; `role=region aria-label="New token"`, ok tone, 1.5 px
  ok border): "Token created for “<label>”" + "Copy it now — this is the only time it will be
  shown."; read-only mono input (select on focus) + **Copy** (→ "Copied") + **Done**; status line
  with the existing HTTPS clipboard fallback text.
- Filter chips: All · Active (incl. current admin) · Expired · Revoked with counts.
- Token list (Label · Role · Created · Expires · Last used · Status · Actions): role tag
  (admin = info, user = neutral); Expires shows date + relative ("in 2 days"); **amber 600 when
  expiring within 7 days**; expired/revoked rows on `surface2`; status pills Active (ok),
  Expired (neutral), Revoked (danger), Current admin (info). Actions for user tokens: Revoke
  (active only) + icon Delete. Inline confirm keeps the existing pattern: row turns danger-tinted,
  label sub-line becomes "Revoke? Its sessions end now." / "Delete this token record?", buttons
  **Keep** and **Revoke now** / **Delete** (danger fill), focus moves to the confirm button.
  Current admin row: no actions, "Rotates on restart".
- Non-admins never see the nav item; direct navigation shows "Admins only."

## 7. Sign in — `access/SignIn.tsx`
Screenshots: `07-sign-in.png`, `08-sign-in-session-ended.png`, `09-sign-in-invalid-token.png`

- Full-screen, no shell. Background `bg` with a 22 px dot grid (`radial-gradient(border 1px,
  transparent 1.2px)`). Colour-mode switch top-right.
- Centered 420 px column: 48 px brand mark + H1 "Ingestion Harness"; card
  (`form aria-label="Sign in"`, 28 px padding, 14 px radius, soft shadow):
  - Session-ended banner when `ended` (`role=status`, info tone): "Your session has ended" +
    "It expired, was revoked, or the admin token rotated. Sign in again to continue."
  - "Access token" field: key icon, password input (mono, `autocomplete=off`, autofocus,
    placeholder "Paste your token"), show/hide icon button (`aria-label` Show token / Hide token,
    `aria-pressed`).
  - Error (`role=alert`, danger, icon) under the field; field border turns danger and gets
    `aria-invalid`. Messages unchanged (401 invalid/expired, 429 too many attempts).
  - **Sign in** full-width 46 px primary.
- Hint under the card: "Ask an administrator for an access token. Administrators: the admin
  token is printed in the API log on each restart."
