# Calendar versions and timestamped migrations

Date: 2026-10-17. Status: approved in conversation; written design awaiting review.

## Why

CT Studio is deployed to staging and production several times a day while internal users outside
the build team (two people and Claude) give feedback. Nobody can currently say which build they are
looking at, so feedback cannot be tied to a change. An earlier project kept its version in the code
and every overlapping pull request conflicted on it, so the version must never live in a file that
pull requests edit.

Migration numbers have the same problem here: two open PRs both take `00NN` and one has to renumber.
Migrations are internal, so their names can change style.

## Goals

- Every PR merged to `main` gets one version, `YYYY.MM.DD.N`, as a git tag. The date is the UTC date
  of tagging; `N` starts at 1 each day. Example: `2026.10.17.3`.
- That tag is the build's only version, the same in staging and production. Communication is "I'm
  on 2026.10.17.3".
- The app shows the version at the bottom of the left nav, linking to GitHub's comparison with the
  previous tag (what this build added).
- The API reports its version.
- New migrations are named by timestamp, so parallel PRs never collide.
- No file a feature PR edits holds a version or a counter.

## Non-goals

- GitHub Releases and release notes. Deferred until the product is past early development; adding
  them later only needs a step that creates a release for a tag.
- Semver, version numbers in `package.json` (stays as is) or `pyproject.toml`.
- Turning on automatic staging deploys (`AUTO_DEPLOY_STAGING`). This design works without it.
- Restructuring `CLAUDE.md` to avoid conflicts (one conflict in over 200 PRs).
- Renaming existing migrations.

## Anti-goals

- A version that differs between staging and production for the same build.
- Two builds showing the same version, or an untagged build that looks like a tagged one.
- Renaming an applied migration: the runner tracks filenames, so a rename would re-apply it.

## Constraints and facts

- Deploys are run by hand with `deploy/scripts/deploy.ps1` on Windows Docker Desktop (Linux:
  `deploy.sh`, same behaviour). Both build images with `docker compose build` from the local
  checkout and tag them `IMAGE_TAG` (default: the short commit hash; `-ImageTag x -NoBuild` rolls
  back).
- `.github/workflows/ci.yml` runs on PRs and pushes to `main` with
  `concurrency: ci-${{ github.ref }}, cancel-in-progress: true`. On `main` a quick second merge
  cancels the first merge's run today, which would leave that merge untagged.
- The repo has no rulesets protecting tags; `GITHUB_TOKEN` with `contents: write` can push them.
  Tags pushed with `GITHUB_TOKEN` trigger no other workflows.
- `apps/api/src/db/migrate.ts` applies every `.sql` file not yet in `schema_migrations`, in filename
  order. A timestamped name (`2026…`) sorts after every `00NN_` name, and a PR merged late with an
  earlier timestamp is still applied. `apps/api/test/integration/migrations-pg.test.ts` compares
  names lexically (`f < first`), which keeps working.
- The repository is public: `https://github.com/kenhayward/ingestion-harness`.

## Design

### Tagging (CI)

- `ci.yml` stops cancelling runs on `main`: `cancel-in-progress` is true for pull requests only,
  so every merge runs to completion.
- A new job `tag` runs after `node`, `worker` and `stack` succeed, only on `push` to `main` in this
  repository. It has `permissions: contents: write` (the workflow default stays `read`) and its own
  concurrency group (`tag-main`, not cancelled), so tags are created one at a time.
- It fetches tags, finds the highest `N` among today's UTC tags `YYYY.MM.DD.*`, and pushes a
  tag `YYYY.MM.DD.(N+1)` on the run's commit. If the commit already has a
  calendar tag (a re-run), it does nothing. If the push is refused because the name was taken, it
  fetches and tries the next number.
- PR runs never tag. A merge whose CI fails gets no tag; the next passing merge takes the next
  number.
- Known edge: if two merges' CI runs finish out of order, the later commit can get the lower
  number. The comparison link below uses ancestry, not numbers, so it stays correct.

### Working out the version (deploy scripts)

Both `deploy.ps1` and `deploy.sh`, before building:

1. `git fetch --tags` (failure is a warning, not fatal: offline deploys still work).
   **Wait for the tag (decided by Ken):** when `HEAD` is on `origin/main` but has no calendar tag
   yet (CI on `main` takes about 6–9 minutes to tag a merge), the script says so and fetches tags
   again every 30 seconds for up to 15 minutes. It goes on as soon as the tag appears; after 15
   minutes it stops with an error naming the commit. `-Untagged` (`--untagged` in `deploy.sh`)
   skips the wait and builds the `+hash` version. A commit not on `origin/main` (a branch, a local
   commit) never waits. `deploy.yml` passes `--untagged` only if asked; its runs normally start
   after CI, so the tag is already there.
2. Version:
   - the calendar tag on `HEAD`, if any: `2026.10.17.3`;
   - otherwise the nearest calendar tag among `HEAD`'s ancestors plus the short hash:
     `2026.10.17.2+abc1234`;
   - otherwise `dev+abc1234`.
3. Previous tag: the nearest calendar tag among the ancestors of the tagged commit's parent (for a
   tagged build), or of `HEAD` (for an untagged one); empty if none.
4. Commit: the short hash.
5. A working tree with uncommitted changes to tracked files adds `.dirty` to the build part
   (`2026.10.17.3+dirty`, `2026.10.17.2+abc1234.dirty`), so a local edit never passes for the
   tagged build. The link rules below are unchanged. (Builder-check finding; my call.)
6. `IMAGE_TAG` defaults to the version when `HEAD` is tagged and the tree is clean, else the short hash as today.
   `-ImageTag` still overrides, so `-ImageTag 2026.10.17.3 -NoBuild` rolls back.

`.github/workflows/deploy.yml` also calls `deploy.sh`; its checkout gets `fetch-depth: 0` so the
ancestry lookups work there too (builder-check finding; my call).

The version, previous tag and commit are passed to compose as environment variables and on to the
`api`, `worker` and `app` image builds as build arguments (default `dev`, empty, `unknown`, so the
CI `stack` job and any plain `docker compose build` still work). The script prints the version at
the start and in its closing `==> deployed` line.

### What each service does with it

- **app (web):** baked in at build time (Vite `define` or `import.meta.env`), so the nav needs no
  request. `npm run dev` shows `dev`.
- **api:** read from the environment set by the image. `GET /api/version` is public
  (`config.public`), tag `Health`, documented like every route, and returns
  `{ version, previous, commit }` (`previous` null when empty).
- **worker:** logs `ingest-worker <version>` at start.

### The nav

- At the bottom of the left nav, below API docs: `v2026.10.17.3` in small muted text.
- Link: `…/compare/<previous>...<version>` for a tagged build; `…/compare/<previous>...<commit>`
  for an untagged one with a previous tag; `…/tree/<version>` for the first tag ever; no link for
  `dev` builds. Opens in a new tab with the same "(opens in a new tab)" treatment as API docs.
- Collapsed nav: the text is hidden and the full version is the link's tooltip and accessible name.
- Every signed-in user sees it.

### Migrations

- New files are `YYYYMMDDHHMM_description.sql`, the UTC time of writing, `description` in
  `snake_case`. Existing `0001`–`0049` keep their names.
- A unit test (runs in `npm test`, so in CI) reads `db/migrations` and fails when a file added
  after `0049` does not match `^\d{12}_[a-z0-9_]+\.sql$`, when its timestamp is not a real UTC
  date-time, or when two files share a timestamp. Because PR CI tests the merge with `main`, a
  clash shows up before merging.
- The runner (`migrate.ts`) is unchanged.
- Known trade-off (builder-check finding; my call): a PR merged after another with a later
  timestamp runs after it on existing databases but before it on a fresh one. That only matters
  when two parallel PRs change the same table in order-dependent ways, which is rare; most
  frameworks with timestamped migrations accept it. `CLAUDE.md` says so: a migration must not
  depend on another PR's unmerged migration. A CI check forcing new timestamps past `main`'s
  newest would bring back renames on most overlapping PRs, the problem this removes.

### Documentation

- `CLAUDE.md`: the migrations rule names the new pattern; a line on versions (tag per merge, where
  it shows, no version in code). Existing references like "migration 0039" stay.
- `deploy/README.md`: how the version is worked out, rollback by version.
- A short ADR (`docs/adr/0014-calendar-versions.md`): tags only, why no releases yet, timestamped
  migrations.
- `docs/openapi.json` regenerated for the new route.

## Testing

- Version logic is easiest to test if it lives in one small script both deploy scripts call, or is
  duplicated with the same table of cases; see "Left to the builder".
- Tag computation (next `N` for a date, given existing tags) gets a table-driven test.
- API: `GET /api/version` without a session, the configured values, the conformance check.
- Web: the nav shows the version and the right link for tagged, untagged and `dev` builds, and the
  collapsed form.
- Migration names: the test above, plus a case proving it rejects a bad name.

## Left to the builder

- Whether the version logic is shared (for example a Node script both deploy scripts call, which
  the tests can exercise) or written in both PowerShell and bash.
- Annotated or lightweight tags.
- Exact env var and build-arg names.
- How the web reads the build-time values.
