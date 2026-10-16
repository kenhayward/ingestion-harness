# GitHub Recipe Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push published recipe versions (with label and note) to a document type's linked GitHub repository, pull and compare them, use another deployment's version as a draft, and import a new type from GitHub, all with each user's own GitHub account.

**Architecture:** A shared wrapper file format (`ct-recipe`) and path rules in `packages/shared`; in the API a `GitHubRepoApi` port (Git Data API, `HttpGitHub`, `FakeGitHubRepos` in tests), a `GitHubSyncRepo` (instance settings, per-type links, per-version push records; Memory + Pg, one contract), and a `github-sync/` service (push, remote listing, pull actions) behind documented routes. The web adds a GitHub strip and sync chips to `VersionsPanel`, three dialogs (link, pull, import) sharing one repository browser, an Integration section, and one help topic. The worker is untouched.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Zod, Fastify (`app.inject`), `yaml`, Postgres migrations, React + Testing Library, Vitest.

**Spec:** [docs/superpowers/specs/2026-10-16-github-recipe-sync-design.md](../specs/2026-10-16-github-recipe-sync-design.md)

## Global Constraints

- Every GitHub call uses the signed-in user's own token (`user_profiles.github_token_enc`, `decryptSecret`); never a shared token, never another user's.
- Admins only create, change or remove a type's link and its switches (routes `'x-admin': true`); anyone with a linked account can push and pull.
- Only published versions are pushed. Pull and import always produce a **draft**, never a published version.
- A published version's definition never changes on either side; a repeat push may only change the `version:` block's label and note.
- Publishing never depends on GitHub: a failed or skipped automatic push never fails the publish.
- Layout: `<root>/<instance>/instance.yaml` and `<root>/<instance>/<type-id>/v<N>.yaml`; default root `ct-studio`; `v<N>.draft.yaml` is reserved and ignored by pull and import.
- Wrapper: `format: ct-recipe`, `formatVersion: 1`, `instance`, `version: { number, status, label, note, labelSetBy, labelSetAt, publishedBy, publishedAt, basedOn, importedFrom, definitionSha256 }`, `definition`.
- `definitionSha256` = sha256 hex of `stableJson` of the definition **without `id` and `version`**.
- This deployment's folder is found by instance id; the instance name is locked once anything has been pushed.
- A different `instanceId` in `instance.yaml`: 409 `` `<instance>` in this repo belongs to another CT Studio deployment ``.
- A file changed on GitHub since the last push: 409 `changed on GitHub: pull first`.
- PR branch name `ct-studio/<instance>/<type-id>-v<N>`; commit message `<type-id> v<N>: <label> (CT Studio <instance>)` (`<type-id> v<N> (CT Studio <instance>)` without a label).
- Change-log summaries: `Imported from GitHub: <instance>/<type-id> v<N> @ <short commit>`.
- User messages: `Link your GitHub account in Profile to push.`, `Your GitHub account can read <owner/name> but not push to it.`
- Retired types: compare, take label and push allowed; *Use as draft* and Import under a retired id refused (`retiredProblem`).
- Wrapper through `POST /api/templates/import`: always a draft at the type's next free version; `publish: true` with a wrapper is a 400 `a CT Studio recipe file is always imported as a draft`; plain definitions unchanged.
- No real GitHub calls in tests or CI; every new route documented (tags, summary, `md` description, `operationId`, responses); UI text says recipe, not template.

## Review Focus

- A revoked or expired token mid-action (GitHub 401): the answer tells the user to link the account again in Profile, nothing is recorded as pushed (test in Task 4).
- Two pushes of different versions racing on one branch: the ref update without force fails for the second, which retries once on the new head, and both files end up there (test in Task 4).
- A malformed or foreign file under the root (bad YAML, wrong `format`, `formatVersion` 2, a `.draft.yaml`): listed as skipped with a reason, never a 500, never imported (test in Task 7).
- The link's branch or repository no longer exists, or was renamed: a 409 naming the branch or repository, not a 500 (test in Task 4).
- A large repository whose recursive tree GitHub truncates: the listing reads the type's folder directly instead of trusting the truncated tree (test in Task 3).

---

### Task 1: Shared recipe file format and sync schemas

**Files:**
- Create: `packages/shared/src/github-sync.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/test/github-sync.test.ts`

**Interfaces:**
- Produces:
  - `RECIPE_FILE_FORMAT = 'ct-recipe'`, `RECIPE_FILE_VERSION = 1`, `DEFAULT_SYNC_ROOT = 'ct-studio'`
  - `RecipeFileSchema` (strict Zod, the wrapper above; `importedFrom: { instance, typeId, version, commit: string|null } | null`), type `RecipeFile`
  - `definitionCanonical(definition: Record<string, unknown>): string` = `stableJson` (from `drafting.ts`) of the definition without `id` and `version`; the API hashes it (Task 4), so shared stays browser-safe
  - `recipeFilePath(root: string, instance: string, typeId: string, version: number): string`, `instanceFilePath(root, instance): string`, `parseRecipePath(root, path): { instance, typeId, version, draft: boolean } | null`
  - `SyncNameSchema` (instance names and roots: `^[a-z0-9][a-z0-9-]{0,62}$`; roots may contain `/`-separated segments of that form)
  - `GitHubLinkBodySchema` `{ repo: 'owner/name', branch, root, alwaysPr: boolean, pushOnPublish: boolean }`, `GitHubLinkViewSchema` (+ `setBy`, `setAt`)
  - `VersionSyncSchema` `{ version, state: 'on'|'label'|'absent'|'pr'|'differs', commit, commitUrl, prNumber, prUrl, pushedBy, pushedAt }`
  - `PushOutcomeSchema` discriminated on `kind`: `pushed` {commit, commitUrl} · `pr` {prNumber, prUrl} · `skipped` {reason} · `failed` {reason}
  - `SyncSettingsViewSchema` `{ instanceName, instanceId, defaultRoot, locked: boolean }`, `SyncSettingsBodySchema` `{ instanceName, defaultRoot }`
  - `RemoteVersionSchema` `{ instance, typeId, version, label, note, publishedBy, publishedAt, definitionSha256, commit, path, mine: boolean }`, `RemoteListingSchema` `{ versions: RemoteVersion[], skipped: { path, reason }[] }`

- [ ] **Step 1: Write the failing tests** (table-driven)

```ts
it.each([
  ['ct-studio', 'production', 'invoice', 3, 'ct-studio/production/invoice/v3.yaml'],
  ['data/ct', 'ken-dev', 'po', 12, 'data/ct/ken-dev/po/v12.yaml'],
])('recipeFilePath(%s,%s,%s,%d)', (root, inst, id, v, path) => {
  expect(recipeFilePath(root, inst, id, v)).toBe(path);
  expect(parseRecipePath(root, path)).toEqual({ instance: inst, typeId: id, version: v, draft: false });
});
it('reads a reserved draft file as draft and other files as null', () => {
  expect(parseRecipePath('ct-studio', 'ct-studio/production/invoice/v4.draft.yaml')?.draft).toBe(true);
  expect(parseRecipePath('ct-studio', 'ct-studio/production/instance.yaml')).toBeNull();
  expect(parseRecipePath('ct-studio', 'ct-studio/production/invoice/notes.md')).toBeNull();
});
it('canonical form ignores id, version and key order', () => {
  expect(definitionCanonical({ id: 'a', version: 1, name: 'X', outputs: { b: 1, a: 2 } }))
    .toBe(definitionCanonical({ outputs: { a: 2, b: 1 }, name: 'X', id: 'b', version: 9 }));
});
it('RecipeFileSchema refuses unknown keys and other format versions', () => {
  expect(RecipeFileSchema.safeParse({ ...sampleFile, extra: 1 }).success).toBe(false);
  expect(RecipeFileSchema.safeParse({ ...sampleFile, formatVersion: 2 }).success).toBe(false);
});
it.each(['Production', 'a b', '-x', ''])('refuses instance name %j', (n) =>
  expect(SyncNameSchema.safeParse(n).success).toBe(false));
```

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/github-sync.test.ts` — Expected: FAIL (module not found)
- [ ] **Step 3: Implement** `packages/shared/src/github-sync.ts` and export from the index.
- [ ] **Step 4: Run** the same command — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "shared: ct-recipe file format and GitHub sync schemas"`

### Task 2: Migration and `GitHubSyncRepo`

**Files:**
- Create: `db/migrations/0048_github_sync.sql`
- Create: `apps/api/src/github-sync/repo.ts` (`GitHubSyncRepo`, `MemoryGitHubSyncRepo`), `apps/api/src/github-sync/pg.ts` (`PgGitHubSyncRepo`)
- Modify: `apps/api/src/templates/repo.ts` (`publish(id, version, by?: string | null)` sets `published_by`; `TemplateRecord.publishedBy: string | null`), `apps/api/src/app.ts` (`AppDeps.githubSync: GitHubSyncRepo`), `apps/api/src/server.ts` (Pg wiring), `apps/api/test/helpers.ts` (Memory default)
- Test: `apps/api/test/github-sync-contract.ts`, `apps/api/test/github-sync-repo.test.ts`, `apps/api/test/integration/github-sync-pg.test.ts` (skips without `IH_TEST_DATABASE_URL`)

**Interfaces:**
- Produces (`GitHubSyncRepo`):
  - `settings(): Promise<{ instanceName: string; instanceId: string; defaultRoot: string; firstPushedAt: string | null }>` (a row is created on first read: name from env `CT_INSTANCE_NAME`, else `default`; id `gen_random_uuid()`; root `ct-studio`)
  - `setSettings(body: SyncSettingsBody, by: string): Promise<'locked' | SyncSettingsView>` (`'locked'` when the name changes and `firstPushedAt` is set)
  - `link(typeId): Promise<GitHubLinkView | null>`, `setLink(typeId, body: GitHubLinkBody, by: string)`, `removeLink(typeId): Promise<boolean>`
  - `pushes(typeId): Promise<VersionPush[]>`, `recordPush(p: VersionPush): Promise<void>` (upsert by type+version), where `VersionPush = { typeId, version, repo, branch, path, commit, blobSha, labelSha, prNumber: number|null, prUrl: string|null, prState: 'open'|'merged'|'closed'|null, pushedBy, pushedAt }`
  - `markPushed(): Promise<void>` (sets `firstPushedAt` once)
- Migration 0048: `github_sync_settings` (single row, `id boolean PRIMARY KEY DEFAULT true CHECK (id)`), `template_github_links` (`type_id text PRIMARY KEY`, repo, branch, root, always_pr, push_on_publish, set_by, set_at), `template_github_pushes` (PK `(type_id, version)`, columns above), `ALTER TABLE templates ADD COLUMN published_by text` (the 0003 triggers guard `definition`/`status` only; check the publish update sets it in the same statement). Comments name the design doc. No FK to `templates` (links outlive drafts; delete them in `WorkbenchRepo.deleteProject`'s children for never-published types).

- [ ] **Step 1: Write the contract** (`runGitHubSyncContract(make)`) with cases: settings created once with a uuid and `ct-studio`; `setSettings` renames before `markPushed`, returns `'locked'` after it but still changes `defaultRoot`; `setLink` then `link` round-trips with `setBy`/`setAt`; `removeLink` false the second time; `recordPush` twice for one version keeps the newest; `pushes` sorted by version; `publish(id, v, 'Ken')` sets `publishedBy`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/github-sync-repo.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** the migration, both repos and the wiring.
- [ ] **Step 4: Run** the unit test (PASS) and, with a throwaway Postgres as in CLAUDE.md, `IH_TEST_DATABASE_URL=… npx vitest run --config apps/api/vitest.integration.config.ts github-sync-pg` (PASS)
- [ ] **Step 5: Commit** `git commit -m "api: GitHub sync settings, links and push records (migration 0048)"`

### Task 3: `GitHubRepoApi` port, `HttpGitHub` and the fake

**Files:**
- Modify: `apps/api/src/profile/github.ts` (add `GitHubRepoApi` interface; `HttpGitHub implements GitHubOAuth, GitHubRepoApi`; `GitHubError` subclasses)
- Create: `apps/api/test/fake-github-repos.ts` (`FakeGitHubRepos implements GitHubRepoApi`: an in-memory git model: branches → head commit → `Map<path, content>`, protected branches, push/read permissions per token, PRs, a `truncateTrees` switch)
- Test: `apps/api/test/github-repos.test.ts` (HttpGitHub against a stub `fetch` asserting exact URLs, methods and bodies)

**Interfaces:**
- Produces (`GitHubRepoApi`, all take `token` first):
  - `permission(token, repo): Promise<'push' | 'read' | 'none'>`
  - `head(token, repo, branch): Promise<string>` (commit sha; `NotFoundError` for a missing branch or repo)
  - `listFiles(token, repo, commit, prefix): Promise<{ path: string; blobSha: string }[]>` (recursive tree; when GitHub sets `truncated`, list `prefix` with per-directory tree reads instead)
  - `readFile(token, repo, commit, path): Promise<{ content: string; blobSha: string } | null>`
  - `commit(token, { repo, branch, parent, files: { path, content }[], message }): Promise<string>` (blobs → tree with `base_tree` → commit → `PATCH refs/heads/<branch>` `force: false`; throws `ProtectedBranchError` on 403/422 naming protection, `StaleRefError` on 422 "not a fast forward")
  - `createBranch(token, repo, name, fromCommit): Promise<void>` (422 "already exists" is fine: it is reused)
  - `openPullRequest(token, { repo, head, base, title, body }): Promise<{ number: number; url: string }>` (an existing open PR for `head` is returned instead)
  - `pullRequestState(token, repo, number): Promise<'open' | 'merged' | 'closed'>`
  - `listRepos(token): Promise<GitHubRepo[]>` reading every repo the account can read (for import), alongside the existing push-only `repos`
- Errors: `GitHubError` (message for the user) with subclasses `UnauthorizedError` (`GitHub no longer accepts this link: link the account again in Profile`), `NotFoundError`, `ProtectedBranchError`, `StaleRefError`, `RateLimitedError` (`GitHub's rate limit was reached: try again after <time>` from `x-ratelimit-reset`).

- [ ] **Step 1: Write failing tests**: `commit` sends `POST …/git/blobs` per file, `POST …/git/trees` with `base_tree`, `POST …/git/commits` with `parents: [parent]`, `PATCH …/git/refs/heads/main` with `force: false`; a 422 "Update is not a fast forward" → `StaleRefError`; a 422/403 mentioning "protected branch" → `ProtectedBranchError`; 401 → `UnauthorizedError`; 403 with `x-ratelimit-remaining: 0` → `RateLimitedError`; `listFiles` with `truncated: true` falls back to reading the prefix's trees; `openPullRequest` 422 "A pull request already exists" → looks up and returns the open one.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/github-repos.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** in `github.ts`; add `githubRepos?: GitHubRepoApi | null` to `AppDeps` (server wires the same `HttpGitHub`); write `FakeGitHubRepos`.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "api: GitHub repository port (Git Data API) and fake"`

### Task 4: Push service

**Files:**
- Create: `apps/api/src/github-sync/token.ts` (`userToken(deps, userId): Promise<string | 'not_linked'>`)
- Create: `apps/api/src/github-sync/file.ts` (`recipeFileFor(record, settings, extras): RecipeFile`, `recipeFileYaml(file): string`, `parseRecipeFile(text): RecipeFile | { error: string }`, `definitionSha256(def)` hashing `definitionCanonical`)
- Create: `apps/api/src/github-sync/push.ts`
- Test: `apps/api/test/github-sync-push.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas/paths, Task 2 repo, Task 3 port.
- Produces: `pushVersion(deps: AppDeps, args: { typeId: string; version: number; user: { id: string; name: string }; origin: string }): Promise<PushOutcome>` (`origin` = the request's `protocol://host`, written as `instance.yaml`'s `url` beside `instanceId` and `name`)
  - `skipped`: not linked type, version not published, `Link your GitHub account in Profile to push.`, `Your GitHub account can read <repo> but not push to it.`
  - Reads head; reads `instance.yaml`: absent → written in the same commit; other `instanceId` → throws `SyncConflict` (409 text above).
  - Reads the version file: absent → write it; present with same `definitionSha256` → write only if label/note/`labelSet*` differ (else `pushed` with the existing commit, nothing written); present with a different sha → `SyncConflict` `v<N> on GitHub is a different recipe: see Pull`; present but its blob differs from the recorded `blobSha` → `SyncConflict` `changed on GitHub: pull first`.
  - Direct commit unless `alwaysPr`; `ProtectedBranchError` (or `alwaysPr`) → `createBranch` + commit there + `openPullRequest` → `pr`; `StaleRefError` → re-read head and retry once.
  - Records the push (`recordPush`, `markPushed`); `failed` never records.
  - `publishedBy` from `TemplateRecord.publishedBy`, `basedOn` from the version's `started` change when it names one, else null.

- [ ] **Step 1: Write failing tests** (FakeGitHubRepos + Memory repos): first push writes `instance.yaml` and `v1.yaml` in one commit with the commit message format; a second deployment (other `instanceId`) pushing to the same folder → 409 text; label change after push → only the `version:` block differs and the state becomes `on`; GitHub edit since push → `changed on GitHub: pull first`; protected `main` → branch `ct-studio/production/invoice-v1` and `pr` outcome; `alwaysPr` → `pr` even when unprotected; draft version → `skipped`; no linked account → the exact message; read-only account → the exact message; **Review Focus:** 401 → `failed` with the relink message and no push recorded; two racing pushes (fake moves head between read and ref update) → both files on the branch; missing branch → 409 `branch main does not exist in owner/name`.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/github-sync-push.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "api: push a published recipe version to GitHub"`

### Task 5: Settings, link, status and push routes

**Files:**
- Create: `apps/api/src/routes/github-sync.ts` (registered next to the profile routes, i.e. only with access control on), tag `GitHub` added to `TAGS` in `apps/api/src/openapi/document.ts`
- Test: `apps/api/test/github-sync-routes.test.ts`

**Interfaces:**
- Consumes: Task 4 `pushVersion`, Task 2 repo.
- Produces routes:
  - `GET /api/github/settings` (admin) → `SyncSettingsView`; `PUT /api/github/settings` (admin) → 200 view, 409 `the instance name is fixed once this deployment has pushed to GitHub`
  - `GET /api/templates/:id/github` (any user) → `{ link: GitHubLinkView | null, versions: VersionSync[], canPush: boolean, reason: string | null }` (`pr` states refreshed with `pullRequestState` on read when the reader has a token; failures leave the stored state)
  - `PUT /api/templates/:id/github` (admin; repo must be one the admin's account can read, else 400 `owner/name is not a repository your GitHub account can read`) · `DELETE /api/templates/:id/github` (admin, 204)
  - `POST /api/templates/:id/versions/:version/github/push` (any user) → 200 `PushOutcome`, 409 on `SyncConflict`, 404 unknown version
- Every route: `tags: ['GitHub']`, summary, `md` description, `operationId`, responses; admin ones `'x-admin': true`.

- [ ] **Step 1: Write failing tests** with `accessApp({ githubRepos: fake })`: a user's `PUT …/github` is 403; admin link then user push → 200 `pushed`; the user's push commit is authored with the user's token (the fake records the token per commit); status lists every version with the right `state`; settings rename after a push → 409 text; `openapi.test.ts` and conformance pass unchanged (they sweep new routes).
- [ ] **Step 2: Run** `npx vitest run apps/api/test/github-sync-routes.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement** the routes.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "api: GitHub sync settings, link and push routes"`

### Task 6: Automatic push at publish

**Files:**
- Modify: `apps/api/src/routes/templates.ts` (publish route), `apps/api/src/routes/workbench.ts` (`POST /workbench/projects/:id/publish`), both passing `req.auth.label` to `publish(…, by)` / `publishDraft({ publishedBy })` (Workbench already records it; set `templates.published_by` too)
- Test: extend `apps/api/test/github-sync-routes.test.ts`

**Interfaces:**
- Consumes: `pushVersion`.
- Produces: both publish responses gain `github: PushOutcome | null` (null when the type is not linked or `pushOnPublish` is off). A thrown `SyncConflict` or any error becomes `failed` with its message; the publish response stays 200.

- [ ] **Step 1: Write failing tests**: linked + `pushOnPublish` → publish answers `github.kind === 'pushed'`; publisher without a linked account → `skipped` with the message and the version is published; the fake throwing → `failed`, version published; `pushOnPublish: false` → `github: null`; the Workbench publish route behaves the same.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/github-sync-routes.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**, documenting the new response field.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "api: push each version when it is published"`

### Task 7: Remote listing and pull actions

**Files:**
- Create: `apps/api/src/github-sync/remote.ts`
- Modify: `apps/api/src/routes/github-sync.ts`
- Test: `apps/api/test/github-sync-pull.test.ts`

**Interfaces:**
- Produces:
  - `listRemote(deps, { token, repo, branch, root, typeId? }): Promise<RemoteListing>` (every `v<N>.yaml` under `root`, or only `<root>/*/<typeId>/` when given; `mine` = its folder's `instance.yaml` id equals this deployment's; skipped entries carry `not valid YAML`, `not a CT Studio recipe file`, `format version N is not supported`, `drafts are not imported yet`, `the file does not match its path`)
  - `GET /api/templates/:id/github/remote` → `RemoteListing` with each `mine` version compared: `same` | `label` | `differs` | `missing-here` (add `compare` to the view)
  - `POST /api/templates/:id/versions/:version/github/take-label` `{ commit }` → sets label/note with `setLabel(…, 'GitHub: <commit author>')`; 409 when the remote definition differs
  - `POST /api/templates/:id/github/use-as-draft` `{ instance, typeId, version, commit, baseUpdatedAt? }` → the draft (`updateDraft` with `expectedUpdatedAt` and an `import` change `Imported from GitHub: …`, or `createNextDraft` when none is open), label and note copied; 409 retired, stale draft (existing message)

- [ ] **Step 1: Write failing tests**: listing groups this deployment and others by `mine`; compare states for same/label/differs/missing; **Review Focus:** malformed YAML, `format: other`, `formatVersion: 2`, `v4.draft.yaml` and a path/content mismatch each appear in `skipped` with the reason and never 500; take-label sets `labelSetBy` `GitHub: Ken Hayward`; use-as-draft replaces the open draft and logs the summary; with a stale `baseUpdatedAt` → 409 `the draft changed since you opened it; reload it to see the changes`; retired type → 409 retired message.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/github-sync-pull.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "api: compare with GitHub, take a label, use a version as draft"`

### Task 8: Import (wrapper files and Import from GitHub)

**Files:**
- Modify: `apps/api/src/routes/templates.ts` (`POST /templates/import` accepts a wrapper)
- Modify: `apps/api/src/routes/github-sync.ts` (`GET /api/github/repos`, `GET /api/github/browse`, `POST /api/github/import`)
- Test: extend `apps/api/test/templates.test.ts`; `apps/api/test/github-sync-import.test.ts`

**Interfaces:**
- Produces:
  - `importRecipeFile(deps, file: RecipeFile, opts: { id?: string; name?: string; commit: string | null; by: string }): Promise<TemplateRecord>` (new type → v1 draft; existing type through Import YAML → its next free version as a draft; definition's `id`/`version` rewritten; label/note set; `started` change `Imported from GitHub: …` or `Imported from YAML (<instance>/<type> v<N>)`)
  - `GET /api/github/repos` → `GitHubRepo[]` the user can read; `GET /api/github/browse?repo&branch&root` → `RemoteListing`
  - `POST /api/github/import` `{ repo, branch, path, commit, id?, name?, link: boolean }` → 201 the new draft; 409 `<id> already exists: pull into it from its Versions tab, or import under another id`; 409 retired; `link: true` needs an admin (else ignored with `linked: false` in the answer) and stores the link with this repo, branch and root

- [ ] **Step 1: Write failing tests**: Import YAML with a wrapper creates a draft at the next free version with the label; with `publish: true` → 400 with the exact message; a plain definition behaves as before (existing tests untouched); Import from GitHub creates `v1` draft, label copied, change log summary with the short commit; id clash → 409 text; admin with `link: true` → the type is linked; non-admin with `link: true` → created, not linked.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/templates.test.ts apps/api/test/github-sync-import.test.ts` — Expected: FAIL
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "api: import CT Studio recipe files, from YAML and from GitHub"`

### Task 9: Web client, fake API and the Versions strip

**Files:**
- Modify: `apps/web/src/api/client.ts` (`getGitHubSync`, `setGitHubLink`, `removeGitHubLink`, `pushVersion`, `listGitHubRemote`, `takeGitHubLabel`, `useGitHubVersionAsDraft`, `getGitHubSettings`, `setGitHubSettings`, `listGitHubRepos`, `browseGitHub`, `importFromGitHub`; `publish…` results carry `github`), `apps/web/test/fake-api.ts`
- Create: `apps/web/src/templates/github/GitHubStrip.tsx`, `apps/web/src/templates/github/SyncChip.tsx`, `apps/web/src/templates/github/LinkDialog.tsx`
- Modify: `apps/web/src/templates/VersionsPanel.tsx` (strip above the list; a chip and *Push vN* / *Push label* per published row; drafts read `Drafts stay in CT Studio. Publish to push it.`), `apps/web/src/templates/TemplateEditor.tsx` (pass `me`/admin and the publish outcome)
- Test: `apps/web/test/VersionsPanel.test.tsx`, `apps/web/test/GitHubLinkDialog.test.tsx`

**Interfaces:**
- Consumes: Task 5 routes.
- Produces: `<GitHubStrip api templateId admin onPull />`, `<SyncChip sync={VersionSync} />` (labels *On GitHub*, *Label changed since push*, *Not on GitHub*, *PR #n open*, *Different on GitHub*), `<LinkDialog>` on `Dialog` (repository picker from `listGitHubRepos`, suggested repository first, branch, folder, *Always open a pull request*, *Push each version when it's published* on by default, *Unlink*).

- [ ] **Step 1: Write failing tests** (roles and labels, `fakeApi()`): unlinked + admin shows *Link to GitHub…*; unlinked + user shows no link button; linked shows `GitHub: owner/name · main · ct-studio/production/invoice/` and *Pull from GitHub…*; each chip text per state; *Push v1* calls `pushVersion` and shows the commit link; `canPush: false` disables buttons with the `reason` as their description; a `pr` outcome shows *PR #42 open*; the link dialog saves the body exactly.
- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/VersionsPanel.test.tsx apps/web/test/GitHubLinkDialog.test.tsx` — Expected: FAIL
- [ ] **Step 3: Implement**; after a publish, the editor's status line shows the outcome (`Published v4 · pushed to GitHub (commit a1b2c3d)`, `… · pull request #42 opened`, `… · not pushed: <reason>`, `… · GitHub push failed: try again from Versions.`).
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "web: GitHub strip, sync chips and link dialog on Versions"`

### Task 10: Pull and Import dialogs (one repository browser)

**Files:**
- Create: `apps/web/src/templates/github/RepoBrowser.tsx` (deployments → types → versions with label, author, time; skipped files listed under *Not readable*), `apps/web/src/templates/github/PullDialog.tsx`, `apps/web/src/templates/github/ImportDialog.tsx`
- Modify: `apps/web/src/templates/TemplatesPage.tsx` (*Import from GitHub…* beside Import YAML)
- Test: `apps/web/test/GitHubPullDialog.test.tsx`, `apps/web/test/GitHubImportDialog.test.tsx`

**Interfaces:**
- Consumes: Task 7 and 8 routes, Task 9 client.
- Produces: `<RepoBrowser listing onPick />` used by both dialogs.

- [ ] **Step 1: Write failing tests**: Pull lists *This deployment* with compare badges and *Take GitHub's label*; *Other deployments* rows have *Use as draft…*, disabled while the editor is dirty (`Save or discard your changes first`) or the type is retired; Import pre-fills id/name from the pick, shows the clash message from the 409, shows the link tick box (on) for admins only and names `ct-studio/<this instance>/` in its hint; success opens the new draft.
- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/GitHubPullDialog.test.tsx apps/web/test/GitHubImportDialog.test.tsx` — Expected: FAIL
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "web: pull from GitHub and import from GitHub"`

### Task 11: Integration settings, Profile wording and the help topic

**Files:**
- Create: `apps/web/src/access/GitHubSyncSection.tsx` (Integration: instance name, default root, instance id read-only; name read-only with `Fixed once this deployment has pushed to GitHub` when `locked`)
- Modify: `apps/web/src/access/IntegrationPage.tsx`, `apps/web/src/access/ProfileDialog.tsx` (picker label *Suggested repository*, hint `Offered first when a document type is linked or imported.`)
- Create: `apps/web/src/help/GitHubSyncHelp.tsx`; Modify: `apps/web/src/help/topics.tsx` (`'github-sync': { title: 'How GitHub sync works', body: <GitHubSyncHelp /> }`)
- Place `<HelpButton topic="github-sync" />` in: `VersionsPanel` heading, `LinkDialog`, `PullDialog`, `ImportDialog`, Profile's GitHub section, `GitHubSyncSection`
- Test: `apps/web/test/Help.test.tsx` (covers the new topic), one test per placement (`Help: How GitHub sync works` opens the dialog) in the files above plus `apps/web/test/IntegrationPage.test.tsx`, `apps/web/test/ProfileDialog.test.tsx`

The help body covers, in user words: your own account is used and GitHub shows who did what (link it in Profile); the folder layout and one folder per deployment; only published versions go to GitHub, drafts stay here; direct push or a pull request when the branch is protected or the type asks; push at publish never blocks publishing; published versions never change, only labels and notes; pull and import always arrive as a draft to check and publish here; what each chip means; only admins link a document type.

- [ ] **Step 1: Write failing tests** for each placement and the Integration section (save, locked name).
- [ ] **Step 2: Run** `npx vitest run --project web` — Expected: FAIL on the new tests
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -m "web: GitHub sync settings, help topic and Profile wording"`

### Task 12: Docs, contracts and the full check

**Files:**
- Modify: `docs/design/profile.md` (the YAML repository section: now the suggested repository; link to the design), `CLAUDE.md` (a Rules-of-the-road entry for GitHub sync naming the routes, tables, wrapper format, `definitionSha256` rule, instance lock, admin-only links, publish never blocked; a note under the template format row that the worker never reads `ct-recipe` files), `docs/openapi.json` (`npm run openapi`), `.env.example` (`CT_INSTANCE_NAME`)
- Modify: `apps/api/src/workbench/` `deleteProject` children (delete `template_github_links`/`template_github_pushes` for a never-published type) with a test in the existing delete-project tests

- [ ] **Step 1: Write the failing delete-project test** (links and pushes gone after deleting a never-published project).
- [ ] **Step 2: Run** it — Expected: FAIL; implement; run — Expected: PASS
- [ ] **Step 3: Update docs**, run `npm run openapi`.
- [ ] **Step 4: Run** `npm run check` — Expected: green
- [ ] **Step 5: Commit** `git commit -m "docs: GitHub recipe sync"`
