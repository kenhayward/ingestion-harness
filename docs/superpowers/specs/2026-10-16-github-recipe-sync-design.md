# GitHub recipe sync: design

Status: agreed in conversation 2026-10-16, ready for review, not yet planned. Builds on the Profile's GitHub link
([docs/design/profile.md](../../design/profile.md), migration 0044) and version labels (issue
#144, migration 0045).

## Intent

People keep their transformation recipes in a GitHub repository, next to source code if they
like, so that:

- published recipe versions have a durable, reviewable home outside CT Studio, with their labels
  and notes;
- a recipe can move between **deployments** (dev, staging, production) through the repo: one
  deployment pushes, another imports or pulls;
- GitHub records **who** did what, because everyone pushes with their own account.

A document type must never be tied to one person: whoever links it, anyone with their own linked
GitHub account and access on GitHub can sync it.

## Goals

- Link a document type to a repository, branch and root folder; anyone can push and pull.
- Push published versions (manually, and automatically at publish when the type opts in), with
  label and note, as one commit per push.
- Branch protection is handled, not refused: a protected branch (or no direct push right) falls
  back to a branch plus a pull request; a type can ask for a PR every time.
- Pull into an existing type: compare versions, take GitHub's label and note, use another
  deployment's version as this type's draft.
- Import from GitHub on the Document types page: a new type from any deployment's version.
- Several deployments share one repo without clashing.
- In-app help that explains all of it, on every GitHub dialog and on the Versions sub-tab.

## Non-goals (for this first cut)

- **Drafts on GitHub.** Only published versions are pushed. Work in progress travels by Export
  YAML or bundle as today. The file naming reserves `v<N>.draft.yaml` so draft snapshots
  (design option "B": push replaces a per-deployment snapshot, pull replaces the local draft,
  never a merge) can be added later without a format change; pull and import ignore such files
  for now.
- Webhooks or any GitHub → CT Studio push (would need a public inbound endpoint).
- Merging definitions. Anything that differs is shown, never combined.
- Syncing Workbench state (brief, samples, references, proposals): the bundle covers that.

## Anti-goals

- Pushing with anyone's account but the signed-in user's, or a shared/service token.
- Ever changing a published version's definition, on either side.
- Importing a version as published: an import or pull is always a **draft**, so the person checks
  it is the right one and this deployment's own checks (validation, model offering, and for a
  Workbench type the Workbench publish route) run at publish.
- A GitHub problem making a publish fail. Publish never depends on GitHub.
- Pushing into `specs/` of this repo by default (the API seeds `specs/*/template.yaml` into every
  deployment on start).

## Decisions

### Ownership and accounts

- The **document type** owns the link: repository (`owner/name`), branch, root folder, "always
  open a pull request", "push each version when published". Stored per type id (not per
  version), so it survives new versions; a new table, forward-only migration.
- **Admins only** create, change or remove a type's link and its switches (always PR, push at
  publish): the link routes are admin-only (`x-admin`), and non-admins see the strip read-only
  (no *Link to GitHub…* / *Change…*). Anyone with a linked account and access on GitHub can push
  and pull.
- Every GitHub call uses the **signed-in user's** token from their Profile link. No account
  linked: GitHub actions are disabled with "Link your GitHub account in Profile to push." The
  account can read but not push: "Your GitHub account can read owner/name but not push to it."
  (pull and import still work).
- The Profile's chosen repository becomes the **suggested repository**: offered first when
  linking a type or importing. Wording on Profile changes accordingly.

### Deployments ("instances") and layout

- A tenant is a separate deployment. Each deployment has an **instance name** (admin setting,
  Administration → Integration, defaulting from an env var) and a generated **instance id**
  (uuid). It writes only under `<root>/<instance>/`.
- The first push creates `<root>/<instance>/instance.yaml` (`instanceId`, name, URL). A push that
  finds a different `instanceId` there is refused: 409 "`<instance>` in this repo belongs to
  another CT Studio deployment".
- "This deployment's folder" is found by **instance id** (`instance.yaml`), and the instance name
  is **locked once anything has been pushed** (Integration shows it read-only with the reason);
  renaming or moving a deployment's folder is out of scope. *(Builder-check call.)*
- Default root folder `ct-studio` (Integration sets the default; each type's link can change
  it). No spaces.

```
ct-studio/
  production/
    instance.yaml
    invoice/
      v1.yaml
      v2.yaml
  ken-dev/
    instance.yaml
    invoice/
      v1.yaml
```

### The file: one atomic file per version

`<root>/<instance>/<type-id>/v<N>.yaml`, a wrapper around the existing export:

```yaml
format: ct-recipe
formatVersion: 1
instance: production
version:
  number: 3
  status: published
  label: "Q3 supplier layout"
  note: "Adds the remittance table…"
  labelSetBy: Ken Hayward
  labelSetAt: 2026-10-14T09:12:00Z
  publishedBy: Ken Hayward
  publishedAt: 2026-10-14T09:30:00Z
  basedOn: 2
  importedFrom: null        # or { instance, typeId, version, commit } when it came from GitHub
  definitionSha256: 9f2c…
definition:                 # exactly what Export YAML gives today
  id: invoice
  version: 3
  …
```

- One file per version, not one file holding every version: published files are written once,
  pushes of different versions never touch the same file, and label history is git's history.
- After the first push, a push may only change the `version:` block's label and note.
  `definitionSha256` (of the definition as exported) lets both sides detect a differing recipe.
- `definitionSha256` is the sha256 of the definition's canonical JSON (`stableJson`) **without
  `id` and `version`**, so the same recipe is recognised across deployments and type ids ("same
  as production v3") and export formatting changes never move it. *(Builder-check call.)*
- `POST /api/templates/import` (and the web's Import YAML) accept this wrapper as well as a
  plain definition. A wrapper always arrives as a **draft**: `publish: true` with a wrapper is a
  400; the version is this type's next free number (v1 for a new type), not the file's; label and
  note are copied; `importedFrom` is recorded from the wrapper's instance, type and version with
  `commit: null` for an uploaded file. A plain definition keeps today's behaviour. *(Builder-check
  call.)*

### Push

- One commit per push through GitHub's Git Data API (blobs, tree, commit, ref update without
  force), so `v<N>.yaml` and, the first time, `instance.yaml` land together, and the ref update
  is compare-and-swap.
- Direct to the link's branch. If refused as protected or for lack of rights, or the type asks
  for a PR every time: create branch `ct-studio/<instance>/<type-id>-v<N>`, commit there, open a
  pull request; the version row shows `PR #n open` until GitHub reports it merged or closed.
- CT Studio remembers, per version, the last pushed commit, blob and path. If the file on the
  branch changed since (someone edited it on GitHub), the push is 409 "changed on GitHub: pull
  first" rather than overwriting.
- A version already on GitHub with the same definition: a push sends label and note only
  ("Push label"). Different definition on GitHub: refused, shown on Pull.
- Commit messages name the type, version and label, e.g.
  `invoice v3: Q3 supplier layout (CT Studio production)`; the author is the user's GitHub
  account (their token).
- **Automatic push at publish**: per type, on by default once linked. After a successful
  publish (Templates route and Workbench publish route) the API pushes as the publisher. The
  publish answer and UI say what happened: pushed (commit link), PR opened, not pushed (no linked
  account / no push right: someone who has can push from Versions), or failed (try again from
  Versions). The publish itself always stands.

### Pull (existing type, Versions sub-tab)

Lists the type's folder of **this** deployment and the same type id in **other** deployments'
folders on the link's branch:

- This deployment, same `definitionSha256`, same label/note: *same*.
- Same definition, label or note differs: show both, *Take GitHub's label* (sets label/note,
  `labelSetBy` = `GitHub: <commit author>`).
- Definition differs: shown, never applied ("Published versions never change").
- A version on GitHub that this deployment does not have: offered as draft (as below).
- Another deployment's version: *Use as draft…* replaces the open draft (or starts the next
  draft) as an `import` change with `baseUpdatedAt` (the existing stale-draft 409 applies;
  Restore undoes it), summary `Imported from GitHub: ken-dev/invoice v4 @ a1b2c3d`. Disabled while
  the editor has unsaved edits. Label and note are copied to the draft. The version number is
  this deployment's own.

### Import from GitHub (Document types page)

Beside Import YAML. The same repository browser as Pull: repository (suggested first, any the
account can read), branch, then root → deployments → types → versions with labels, authors and
times.

- Creates a **plain document type** like Import YAML does (no Workbench project; a Workbench
  project can be made from it later as today), as **v1 draft**, label and note copied, change log
  `Imported from GitHub: <instance>/<type> v<N> @ <commit>`; `importedFrom` is recorded so a later
  push carries it.
- Id and name editable; an id that exists here is refused with "already exists: pull into it from
  its Versions tab, or import under another id".
- Tick box (on): link the new type to this repository; it writes under this deployment's folder,
  never the one it came from.

### Where it lives (UI)

- **Administration → Integration** (admins): instance name, default root folder, instance id
  (read-only).
- **Recipe editor → Versions sub-tab**: everything per type. A strip at the top: "GitHub:
  owner/name · branch · root/instance/type/" with *Change…* (link dialog: repository, branch,
  folder, always PR, push at publish; also unlink), or *Link to GitHub…* when not linked; *Pull
  from GitHub…*. Each version row has a sync chip: *On GitHub* (pushed by, commit link), *Label
  changed since push* (+ *Push label*), *Not on GitHub* (+ *Push vN*), *PR #n open*. Drafts:
  "Drafts stay in CT Studio. Publish to push it."
- **Document types page**: *Import from GitHub…* beside Import YAML.
- **Profile**: the repository picker reads "Suggested repository".
- Both recipe editors (standalone and the Workbench Recipe tab) show the same Versions panel.

### In-app help (people will forget)

One help topic, `github-sync` (`HELP_TOPICS` in `apps/web/src/help/topics.tsx`, body
`GitHubSyncHelp` in `apps/web/src/help/`), placed with `<HelpButton topic="github-sync" />` on:
the Versions sub-tab heading, the link (*Change…*) dialog, *Pull from GitHub…*, *Import from
GitHub…*, the Profile's GitHub section and Integration's GitHub section. Written in user words
(recipe, document type, deployment). It covers:

- your own GitHub account is used, so GitHub shows who did what; link it in Profile;
- the folder layout and why each deployment has its own folder;
- only published versions go to GitHub; drafts stay here;
- push: direct, or a pull request when the branch is protected or the type asks; push at publish
  never blocks publishing;
- published versions never change; only labels and notes are updated;
- pull and import always arrive as a draft, so you check it and publish it here;
- what each sync chip means.

Each placement gets a test that its button opens the topic (the convention in
`test/Help.test.tsx`).

## Constraints

- API only talks to GitHub (no LLM logic); the worker is untouched.
- Routes documented (OpenAPI tags, `x-admin` for Integration settings), Zod at the boundary,
  shared schemas in `packages/shared` (the wrapper format, the link, sync status).
- GitHub is behind a port (extend `GitHubOAuth`, or a new `GitHubRepoApi` port) with a fake in
  tests; no real GitHub calls in tests or CI.
- Retired types: reading, Pull's comparison, taking GitHub's label and pushing are allowed;
  *Use as draft* is refused (the retired recipe editor is read-only and new drafts are refused);
  Import from GitHub under a retired id is refused like other new work (`retiredProblem`).
  *(Builder-check call.)*
- Existing Import YAML and Export YAML keep working with plain definitions.

## Left to the builder

- Table shapes for the link and per-version sync record; how PR state is refreshed (on opening
  Versions is enough).
- Exact GitHub error mapping (protected branch, rate limit, missing repo, revoked token: the
  last asks the user to relink in Profile).
- The help body's wording and worked example.
- Whether Export YAML downloads the wrapper by default or offers both.
