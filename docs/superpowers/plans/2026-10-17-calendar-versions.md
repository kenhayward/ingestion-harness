# Calendar Versions and Timestamped Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every merge to `main` gets a `YYYY.MM.DD.N` git tag that the deploy scripts bake into the images; the app shows it at the bottom of the nav linking to GitHub's comparison with the previous tag, the API serves it, and new migrations are named by timestamp.

**Architecture:** One dependency-free Node script, `deploy/scripts/version.mjs`, owns all version logic (next tag for CI, resolving the build's version for deploys, waiting for the tag); CI and both deploy scripts call it, and its pure functions are unit-tested. The resolved values travel as compose build args into the `api`, `worker` and `app` images. Link-building lives in `@ih/shared` for the web.

**Tech Stack:** Node 24 (plain ESM `.mjs`, builtins only), GitHub Actions, Docker Compose, PowerShell + bash, Fastify + Zod, React + Vite, Python 3.13, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-17-calendar-versions-design.md`

## Global Constraints

- Tag format `YYYY.MM.DD.N`, UTC date of tagging, `N` from 1 each day, no `v` prefix on the tag; the nav displays `v` + version.
- Untagged build: `<nearest tag>+<short hash>`; no tag in history: `dev+<short hash>`; uncommitted changes to tracked files: `+dirty` on a tagged build, `.dirty` appended to an untagged build part (`2026.10.17.3+dirty`, `2026.10.17.2+abc1234.dirty`).
- `IMAGE_TAG` default: the version when `HEAD` is tagged and clean, else the short hash. `-ImageTag` still overrides.
- Wait for the tag: only when `HEAD` is on `origin/main` and untagged; fetch every 30 s, give up after 15 min with an error naming the commit; `-Untagged` / `--untagged` skips.
- Build-arg defaults: version `dev`, previous empty, commit `unknown`.
- `GET /api/version` is public, tag `Health`, returns `{ version, previous, commit }`, `previous` null when empty.
- Repository URL: `https://github.com/kenhayward/ingestion-harness`.
- Migrations: existing `0001`–`0049` keep their names; new ones `^\d{12}_[a-z0-9_]+\.sql$` (UTC `YYYYMMDDHHMM`); the runner `apps/api/src/db/migrate.ts` is unchanged.
- No file a feature PR edits holds a version or counter (`package.json` versions untouched).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Two merges within seconds: both must end up tagged with distinct numbers (CI run grouping must not cancel or replace a pending `main` run; tag push retries on a taken name).
2. A deploy of a commit on a branch or a local-only commit: must not wait for a tag that will never come.
3. `git fetch` failing (offline host): deploy goes on with a warning, version from local tags.
4. A tag from another day or a non-calendar tag (`v1`, `2026.10.17.x`) in the repo: ignored by every lookup.
5. The collapsed nav: the version is still reachable (tooltip, accessible name) and the link still opens in a new tab.

Each line has a test in the owning task (Task 2 for 1–4 where the logic is pure; Task 4 for 5). The CI grouping in line 1 is a YAML change verified by reading, noted in Task 7.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/version.ts` (create) | `VersionInfoSchema`, `DEV_VERSION`, `REPO_URL`, `versionLink` |
| `deploy/scripts/version.mjs` (create) | pure version functions + CLI `tag` / `resolve` |
| `deploy/scripts/version.d.mts` (create) | types for the pure exports, so tests typecheck |
| `apps/api/test/deploy-version.test.ts` (create) | tests for `version.mjs` |
| `apps/api/src/routes/version.ts` (create) | `GET /api/version` |
| `apps/web/src/version.ts` (create) | `BUILD_VERSION` from `import.meta.env` |
| `apps/web/src/shell/NavVersion.tsx` (create) | the nav footer version link |
| `worker/src/ingest_worker/version.py` (create) | `app_version()` |
| `apps/api/src/db/migration-names.ts` (create) | `migrationNameProblems` |
| `.github/workflows/ci.yml`, `deploy.yml`, `deploy/scripts/deploy.ps1`, `deploy.sh`, `deploy/docker-compose.yml`, three Dockerfiles (modify) | wiring |
| `CLAUDE.md`, `deploy/README.md`, `docs/adr/0014-calendar-versions.md`, `docs/openapi.json` | docs |

---

### Task 1: Shared version type and link

**Files:**
- Create: `packages/shared/src/version.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/test/version.test.ts`

**Interfaces:**
- Produces:
  - `VersionInfoSchema = z.object({ version: z.string(), previous: z.string().nullable(), commit: z.string() })`, `type VersionInfo`
  - `DEV_VERSION: VersionInfo = { version: 'dev', previous: null, commit: 'unknown' }`
  - `REPO_URL = 'https://github.com/kenhayward/ingestion-harness'`
  - `versionLink(info: VersionInfo, repo = REPO_URL): string | null`

- [ ] **Step 1: Write the failing table test** `versionLink` (`it.each`):

| info | expected |
| --- | --- |
| `{ version: '2026.10.17.3', previous: '2026.10.17.2', commit: 'abc1234' }` | `${REPO_URL}/compare/2026.10.17.2...2026.10.17.3` |
| `{ version: '2026.10.17.3+dirty', previous: '2026.10.17.2', commit: 'abc1234' }` | same as above |
| `{ version: '2026.10.17.1', previous: null, commit: 'abc1234' }` | `${REPO_URL}/tree/2026.10.17.1` |
| `{ version: '2026.10.17.2+abc1234', previous: '2026.10.17.2', commit: 'abc1234' }` | `${REPO_URL}/compare/2026.10.17.2...abc1234` |
| `{ version: '2026.10.17.2+abc1234.dirty', previous: '2026.10.17.2', commit: 'abc1234' }` | `${REPO_URL}/compare/2026.10.17.2...abc1234` |
| `{ version: 'dev+abc1234', previous: null, commit: 'abc1234' }` | `null` |
| `DEV_VERSION` | `null` |

Plus: `VersionInfoSchema.parse({ version: 'dev', previous: null, commit: 'x' })` succeeds and rejects a missing `commit`.

- [ ] **Step 2:** `npx vitest run packages/shared/test/version.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** in `packages/shared/src/version.ts`. Rule: split `version` at the first `+`; the base is a calendar tag (`/^\d{4}\.\d{2}\.\d{2}\.\d+$/`) and the suffix is absent or `dirty` → tagged (compare `previous...base`, or `tree/base` without previous); base is a calendar tag with any other suffix → `compare/previous...commit` (null without previous); anything else → null.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `Shared: VersionInfo and versionLink`.

---

### Task 2: The version tool

**Files:**
- Create: `deploy/scripts/version.mjs`, `deploy/scripts/version.d.mts`
- Test: `apps/api/test/deploy-version.test.ts` (imports `../../../deploy/scripts/version.mjs`; `apps/api/tsconfig.json` already includes `test`)

**Interfaces:**
- Produces (exports of `version.mjs`, declared in `version.d.mts`):
  - `isCalendarTag(tag: string): boolean` — `/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/`
  - `compareCalendarTags(a: string, b: string): number` — by date, then `N` numerically
  - `nextCalendarTag(now: Date, tags: string[]): string` — UTC date of `now`; `N` = 1 + highest `N` among that date's calendar tags
  - `resolveVersion(input: { headTag: string | null; nearestTag: string | null; previousTag: string | null; commit: string; dirty: boolean }): { version: string; previous: string; commit: string; imageTag: string }`
  - `shouldWait(input: { headTag: string | null; onMain: boolean; untagged: boolean }): boolean`
  - `waitForTag(opts: { check: () => Promise<string | null>; sleep: (ms: number) => Promise<void>; now: () => number; intervalMs?: number; timeoutMs?: number }): Promise<string | null>` — defaults 30 000 / 900 000; returns the tag, or null on timeout
- CLI (run as `node deploy/scripts/version.mjs <cmd>`; only builtins, `child_process.execFileSync('git', …)`):
  - `tag`: `git fetch --tags origin` (fatal here); if `HEAD` has a calendar tag, print it and exit 0; else up to 5 tries: `nextCalendarTag(new Date(), tags)`, `git tag <t> HEAD`, `git push origin refs/tags/<t>`; on a refused push delete the local tag, fetch, retry. Prints the tag.
  - `resolve [--untagged]`: `git fetch origin main --tags` (failure → warning on stderr, continue); headTag = highest calendar tag from `git tag --points-at HEAD`; onMain = `git merge-base --is-ancestor HEAD origin/main` exits 0; if `shouldWait`, print `waiting for CI to tag <hash>…` to stderr and `waitForTag` (each check re-fetches tags); timeout → stderr `no tag for <hash> after 15 minutes: wait for CI or deploy with -Untagged` and exit 1. nearestTag / previousTag from `git describe --tags --abbrev=0 --match "[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].*" <rev>` (`HEAD` for nearest; `HEAD^` for previous when tagged, else nearest; failure = none; a result that is not `isCalendarTag` = none); dirty = `git status --porcelain --untracked-files=no` non-empty. Prints to stdout exactly four lines `APP_VERSION=…`, `APP_VERSION_PREVIOUS=…`, `APP_COMMIT=…`, `IMAGE_TAG=…`.
  - The CLI runs only when the file is the entry point (`import.meta.url === pathToFileURL(process.argv[1]).href`), so tests import it without side effects.

- [ ] **Step 1: Write the failing tests**
  - `nextCalendarTag`: `(2026-10-17T00:30Z, [])` → `2026.10.17.1`; `(…, ['2026.10.17.1','2026.10.17.2','2026.10.16.9'])` → `2026.10.17.3`; `['2026.10.17.9','2026.10.17.10']` → `2026.10.17.11` (numeric, not lexical); `['v1','2026.10.17.x','2026.10.17.0']` ignored → `2026.10.17.1`; `2026-10-16T23:59:59-02:00` (= 17th UTC) → `2026.10.17.N`.
  - `isCalendarTag`: true for `2026.10.17.3`; false for `v2026.10.17.3`, `2026.10.17`, `2026.10.17.0`, `2026.10.17.3+dirty`.
  - `resolveVersion` table:
    - head `2026.10.17.3`, previous `2026.10.17.2`, clean → `{ version: '2026.10.17.3', previous: '2026.10.17.2', commit: 'abc1234', imageTag: '2026.10.17.3' }`
    - same, dirty → version `2026.10.17.3+dirty`, imageTag `abc1234`
    - no head, nearest `2026.10.17.2` → `2026.10.17.2+abc1234`, previous `2026.10.17.2`, imageTag `abc1234`; dirty → `2026.10.17.2+abc1234.dirty`
    - nothing → `dev+abc1234`, previous `''`; dirty → `dev+abc1234.dirty`
  - `shouldWait`: true only for `{ headTag: null, onMain: true, untagged: false }` (check the other three combinations false, including a branch commit `onMain: false`).
  - `waitForTag` with a fake clock: `check` returns null twice then `2026.10.17.4` → resolves `2026.10.17.4` after 2 sleeps of 30 000; `check` always null → resolves null once `now()` passes 900 000, having slept no more than 31 times.
- [ ] **Step 2:** `npx vitest run apps/api/test/deploy-version.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `version.mjs` and `version.d.mts` per the Interfaces block.
- [ ] **Step 4:** same command → PASS; then `npm run typecheck` and `npm run lint` → clean (add `deploy/scripts/*.mjs` to the eslint config's file globs if it is not covered; Node globals).
- [ ] **Step 5: Smoke the CLI** `node deploy/scripts/version.mjs resolve --untagged` in this worktree → four lines, `APP_VERSION=dev+<hash>` (no calendar tags exist yet) with `.dirty` only if the tree is dirty.
- [ ] **Step 6: Commit** `Deploy: version tool for calendar tags`.

---

### Task 3: API `GET /api/version`

**Files:**
- Create: `apps/api/src/routes/version.ts`
- Modify: `apps/api/src/app.ts` (register; `AppDeps.version?: VersionInfo`, default `DEV_VERSION`), `apps/api/src/config.ts` (optional `APP_VERSION` default `dev`, `APP_VERSION_PREVIOUS` default `''`, `APP_COMMIT` default `unknown`), `apps/api/src/server.ts` (pass `version: { version, previous: previous || null, commit }`), `docs/openapi.json`
- Test: `apps/api/test/version.test.ts`

**Interfaces:**
- Consumes: `VersionInfoSchema`, `DEV_VERSION` (Task 1).

- [ ] **Step 1: Write the failing tests**
  - `buildApp` with `version: { version: '2026.10.17.3', previous: '2026.10.17.2', commit: 'abc1234' }` → `GET /api/version` 200 with exactly that body.
  - Without `version` → `{ version: 'dev', previous: null, commit: 'unknown' }`.
  - With access control on (`MemoryAccessRepo`, no cookie) → 200 (public).
  - Config: `loadConfig` (or the module's parse function) with `APP_VERSION_PREVIOUS=''` maps to `previous: null` in what `server.ts` passes — test at the config level if `server.ts` is not unit-testable.
- [ ] **Step 2:** `npx vitest run apps/api/test/version.test.ts` → FAIL (404).
- [ ] **Step 3: Implement** the route like `routes/health.ts`: `config: { public: true }`, `tags: ['Health']`, `operationId: 'version'`, summary `Show which build of CT Studio is running`, a `md` description naming the tag format and that `previous` is the tag before it (null for the first tag or a `dev` build), `response: { 200: res(…, VersionInfoSchema) }`.
- [ ] **Step 4:** same command → PASS; `npx vitest run apps/api/test/openapi.test.ts apps/api/test/access.test.ts` → PASS; `npm run openapi` and commit the regenerated `docs/openapi.json`.
- [ ] **Step 5: Commit** `API: GET /api/version`.

---

### Task 4: The nav shows the version

**Files:**
- Create: `apps/web/src/version.ts`, `apps/web/src/shell/NavVersion.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx` (render `<NavVersion info={BUILD_VERSION} compact={compact} />` right after the API docs `nav-foot` link, in the same block), `apps/web/src/styles.css` or the shell stylesheet (`.nav-version`: small, muted), `apps/web/src/vite-env.d.ts` (declare `VITE_APP_VERSION`, `VITE_APP_VERSION_PREVIOUS`, `VITE_APP_COMMIT`)
- Test: `apps/web/test/nav-version.test.tsx`

**Interfaces:**
- Consumes: `VersionInfo`, `DEV_VERSION`, `versionLink` (Task 1).
- Produces: `BUILD_VERSION: VersionInfo` (from `import.meta.env.VITE_APP_VERSION` etc., `DEV_VERSION` values when unset, empty previous → null); `NavVersion({ info: VersionInfo; compact: boolean })`.

- [ ] **Step 1: Write the failing tests**
  - Tagged info, `compact={false}`: a link named `v2026.10.17.3 (opens in a new tab)` with `href` `…/compare/2026.10.17.2...2026.10.17.3`, `target="_blank"`, `rel` containing `noopener`; visible text `v2026.10.17.3`.
  - Same, `compact`: the link's accessible name is `Version 2026.10.17.3 (opens in a new tab)` and its `title` is `Version 2026.10.17.3`; the visible label is hidden (class `nav-label`, as API docs does).
  - `DEV_VERSION`: no link, plain text `dev` (the `v` prefix is shown only when the version starts with a digit); `dev+abc1234`: plain text `dev+abc1234`, no link.
  - Untagged `2026.10.17.2+abc1234` with previous: link text `v2026.10.17.2+abc1234`, `href` `…/compare/2026.10.17.2...abc1234`.
  - `AppShell` (an existing shell test file, one added case): the nav contains the `dev` version text below API docs.
- [ ] **Step 2:** `npx vitest run apps/web/test/nav-version.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `version.ts` and `NavVersion.tsx`; follow the API docs link's markup (`nav-label`, `visually-hidden` " (opens in a new tab)", `aria-label`/`title` only when compact).
- [ ] **Step 4:** same command and `npx vitest run --project web` → PASS; `npm run format` on touched files.
- [ ] **Step 5: Commit** `Web: version at the bottom of the nav`.

---

### Task 5: The worker logs its version

**Files:**
- Create: `worker/src/ingest_worker/version.py`
- Modify: `worker/src/ingest_worker/main.py` (log `ingest-worker %s` with `app_version()` once at start, before the claim loop)
- Test: `worker/tests/test_version.py`

**Interfaces:**
- Produces: `app_version() -> str` = `os.environ.get("APP_VERSION") or "dev"`.

- [ ] **Step 1: Failing tests:** with `monkeypatch.setenv("APP_VERSION", "2026.10.17.3")` → `"2026.10.17.3"`; unset → `"dev"`; empty string → `"dev"`.
- [ ] **Step 2:** `cd worker && uv run pytest tests/test_version.py` → FAIL (import error).
- [ ] **Step 3: Implement**, and add the start-up log line in `main.py`.
- [ ] **Step 4:** same → PASS; `npm run worker:lint` → clean.
- [ ] **Step 5: Commit** `Worker: log the version at start`.

---

### Task 6: Images and deploy scripts carry the version

**Files:**
- Modify: `deploy/docker-compose.yml` (`build.args` on `api`, `worker`, `app`: `APP_VERSION: ${APP_VERSION:-dev}`, `APP_VERSION_PREVIOUS: ${APP_VERSION_PREVIOUS:-}`, `APP_COMMIT: ${APP_COMMIT:-unknown}`)
- Modify: `deploy/docker/api.Dockerfile`, `worker.Dockerfile` (`ARG` the three, `ENV` them in the final stage), `app.Dockerfile` (`ARG` the three in the build stage, `ENV VITE_APP_VERSION=$APP_VERSION VITE_APP_VERSION_PREVIOUS=$APP_VERSION_PREVIOUS VITE_APP_COMMIT=$APP_COMMIT` before `npm run build -w @ih/web`)
- Modify: `deploy/scripts/deploy.ps1` (`[switch]$Untagged`), `deploy/scripts/deploy.sh` (`--untagged`)

**Interfaces:**
- Consumes: `node deploy/scripts/version.mjs resolve [--untagged]` output (Task 2); the env names read by Tasks 3–5.

- [ ] **Step 1: Deploy scripts.** Before building (and unless `-NoBuild`): fail with `Node 24 is needed to work out the version` when `node` is missing; run `resolve` (pass `--untagged` when asked); exit on its failure; set `APP_VERSION`, `APP_VERSION_PREVIOUS`, `APP_COMMIT` in the environment from its lines; set `IMAGE_TAG` from its `IMAGE_TAG` line unless `-ImageTag`/`IMAGE_TAG` was given. With `-NoBuild`, skip `resolve` and keep today's behaviour (the images already carry their version). Print `==> deploying <version> (IMAGE_TAG=…)` and finish with `==> deployed <version>`.
- [ ] **Step 2: Verify compose:** `APP_VERSION=2026.10.17.3 docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config` shows the three build args on `api`, `worker`, `app`; without the variables it shows `dev`, empty, `unknown`.
- [ ] **Step 3: Verify the app image bakes it:** `docker compose … build app` with `APP_VERSION=2026.10.17.99`, then `docker run --rm <app image> grep -rl "2026.10.17.99" /usr/share/nginx/html/assets` → a match. Same for api: `docker run --rm <api image> printenv APP_VERSION` → `2026.10.17.99`.
- [ ] **Step 4: Verify the scripts parse without deploying:** `powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('deploy/scripts/deploy.ps1',[ref]$null,[ref]$null) | Out-Null"` → no errors; `bash -n deploy/scripts/deploy.sh` → no output.
- [ ] **Step 5: Commit** `Deploy: bake the version into the images`.

---

### Task 7: CI tags every merge; deploy workflow history

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`

- [ ] **Step 1: CI grouping.** Replace the workflow concurrency with `group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`, `cancel-in-progress: true`. Pull requests still cancel superseded runs; each `main` run is its own group, so a run is never cancelled or replaced while pending (GitHub replaces a pending run in a shared group even with `cancel-in-progress: false`, which would leave a merge untagged). Comment this in the file.
- [ ] **Step 2: `tag` job.** `needs: [node, worker, stack]`; `if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'kenhayward/ingestion-harness'`; `runs-on: ubuntu-24.04`; `permissions: contents: write`; `timeout-minutes: 5`; steps: `actions/checkout@v7` with `fetch-depth: 0`, `actions/setup-node@v7` with `node-version-file: .nvmrc`, `node deploy/scripts/version.mjs tag`, and a step summary line `Tagged <tag>`. No job concurrency group (the push retry in Task 2 handles races, and a group would replace pending jobs).
- [ ] **Step 3: deploy.yml.** `actions/checkout@v7` gets `fetch-depth: 0`; add `actions/setup-node@v7` (`node-version-file: .nvmrc`) before Deploy; add a boolean input `untagged` (default false) passed as `--untagged`.
- [ ] **Step 4: Verify:** `npx --yes yaml-lint .github/workflows/ci.yml .github/workflows/deploy.yml` (or `node -e "require('yaml').parse(...)"` with the repo's `yaml` dependency) → parses; read the diff once against Review Focus line 1.
- [ ] **Step 5: Commit** `CI: tag every merge to main with a calendar version`.

---

### Task 8: Migration names

**Files:**
- Create: `apps/api/src/db/migration-names.ts`
- Test: `apps/api/test/migration-names.test.ts`

**Interfaces:**
- Produces: `LAST_NUMBERED_MIGRATION = 49`; `migrationNameProblems(files: string[]): string[]` (only `.sql` names considered; each problem names the file).

- [ ] **Step 1: Failing tests**
  - `['0001_init.sql', '0049_x.sql', '202610171030_add_thing.sql']` → `[]`.
  - `['0050_new.sql']` → one problem containing `0050_new.sql` and `name new migrations YYYYMMDDHHMM_description.sql`.
  - `['202610171030_Add-Thing.sql']` (bad description), `['20261017103_x.sql']` (11 digits), `['202613171030_x.sql']` (month 13), `['202610172460_x.sql']` (minute 60) → one problem each.
  - `['202610171030_a.sql', '202610171030_b.sql']` → one problem naming both.
  - `README.md` in the list → ignored.
  - The real directory: `migrationNameProblems(readdirSync(<repo>/db/migrations))` → `[]`.
- [ ] **Step 2:** `npx vitest run apps/api/test/migration-names.test.ts` → FAIL.
- [ ] **Step 3: Implement.** A real UTC date-time check: build `Date.UTC(y, m-1, d, h, min)` and compare its parts back.
- [ ] **Step 4:** same → PASS.
- [ ] **Step 5: Commit** `Migrations: timestamped names from now on`.

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (Rules of the road: the migrations bullet becomes "add `db/migrations/YYYYMMDDHHMM_description.sql` (UTC; `0001`–`0049` keep their numbers; `migrationNameProblems` checks names); never edit or rename an applied one; a migration must not depend on another PR's unmerged migration (order between parallel PRs differs between existing and fresh databases)"; a new bullet **Versions**: tag per merge by the CI `tag` job, `deploy/scripts/version.mjs`, build args, `GET /api/version`, `NavVersion`, no version in any file; the Commands table gets `node deploy/scripts/version.mjs resolve --untagged` "what a deploy would call this build")
- Modify: `deploy/README.md` (how the version is worked out, waiting and `-Untagged`, rollback with `-ImageTag 2026.10.17.3 -NoBuild`, Node 24 needed on the deploy host)
- Create: `docs/adr/0014-calendar-versions.md` (Context: version in code caused conflicts, migration number collisions; Decision: calendar tags per merge, one version for every environment, no GitHub Releases yet, timestamped migrations; Consequences: Node on deploy hosts, deploy waits for CI, order note for parallel migrations)

- [ ] **Step 1:** write the three.
- [ ] **Step 2: Verify:** `npm run format:check` and `npm run check` → green; `npm run worker:lint` → clean.
- [ ] **Step 3: Commit** `Docs: calendar versions and timestamped migrations`.
