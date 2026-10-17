# 0014: Calendar versions from git tags, and timestamped migrations

**Status:** accepted · 2026-10-17

## Context
CT Studio is deployed to staging and production several times a day while internal users outside
the team building it give feedback, and nobody could say which build they were looking at. An
earlier project kept its version in the code: every overlapping pull request then conflicted on
it. Migration numbers had the same problem here: two open PRs both took the next `00NN` and one
had to renumber.

## Decision
- **No file holds a version.** CI's `tag` job tags every merge to `main` whose checks pass with
  `YYYY.MM.DD.N`: the UTC date and a build number from 1 each day, so numbers stay small. Runs on
  `main` never share a concurrency group (GitHub would replace a pending run and leave a merge
  untagged), and a push refused because another run took the number retries with the next one.
- **One version everywhere.** The deploy scripts work out the build's version from git
  (`deploy/scripts/version.mjs`, Node builtins only) and bake it into the images. Staging and
  production deploy the same tag and show the same number. A commit CI has not tagged yet is
  waited for (up to 15 minutes) rather than built under another name; an untagged or locally
  changed build says so (`2026.10.17.2+abc1234`, `+dirty`).
- **Where it shows:** the bottom of the app's nav, linking to GitHub's comparison with the previous
  tag (what the build added); `GET /api/version`; the worker's start-up log.
- **No GitHub Releases yet.** While every merge is deployed, a release per tag would be noise;
  adding releases later needs only a step that creates one for a tag.
- **Timestamped migrations.** New migrations are `YYYYMMDDHHMM_description.sql`; `0001`–`0049`
  keep their names, because the runner records applied files by name. The runner is unchanged: it
  applies every file it has not applied, in name order, and a timestamp sorts after every number.

## Consequences
- Deploy hosts need Node 24, and a deploy straight after a merge waits for CI (6–9 minutes).
- The version is only as good as the tags: a deploy with `--untagged` or from an edited checkout is
  visibly not a tagged build.
- Two PRs merged out of timestamp order apply their migrations in one order on existing databases
  and in the other on a fresh one. That matters only when they change the same table in an
  order-dependent way; a migration must not depend on another open PR's.
- `package.json` and `pyproject.toml` versions are not maintained.
