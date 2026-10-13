# Contributing

Thanks for helping improve Content Transformation Studio (CT Studio). Issues, discussions and
pull requests are all welcome.

## Before you start

- **Bugs:** open an issue using the bug report form, with steps to reproduce. For security
  problems, don't open an issue. Follow [SECURITY.md](SECURITY.md) instead.
- **Larger changes** (new provider kinds, spec/template format changes, architecture): open an
  issue first so we can agree on the approach before you write code.
- **Never commit real documents you aren't allowed to share**, API keys, or `deploy/.env`.

## Development setup

Prerequisites: Node 24 (see `.nvmrc`), Python 3.13 with [uv](https://docs.astral.sh/uv/),
and Docker for the local infrastructure.

```bash
npm ci
cd worker && uv sync && cd ..
npm run check        # lint, format check, typecheck, TS tests, ruff, mypy, pytest
```

[README.md](README.md) explains how to run the stack, and
[docs/architecture.md](docs/architecture.md) shows how the pieces fit together.

## How we work

1. **Tests come first.** For every change in behaviour, add a test, watch it fail for the
   expected reason, then make it pass. Bug fixes start with a test that reproduces the bug.
2. **Unit tests stay offline.** They never call a real LLM, Postgres or S3. Use the fakes
   (`MemoryRepo`, `MemoryObjectStore`, `fakeApi()`, `FakeProvider`, `FakeQueue`).
   Code that needs real infrastructure gets integration tests that are excluded by default.
3. **Change both sides of a contract in the same PR.** This covers the spec/template format,
   object keys, job statuses and the models table. TypeScript and Python each have their own
   copy (see the table in [CLAUDE.md](CLAUDE.md)).
4. **Published specs and applied migrations are immutable.** Add `specs/<id>/v<N+1>/` or a
   new `db/migrations/NNNN_*.sql` instead of editing them.
5. **Don't weaken tests** to make them pass. If a test is wrong, explain why in the PR.

## Pull requests

- Branch from `main` and keep each PR focused on one change.
- `npm run check` must pass locally. CI runs the same checks plus a Docker compose smoke test,
  and it must be green before merging.
- Fill in the PR template. Update `docs/` or add an ADR in `docs/adr/` if the architecture
  changes.
- `main` is protected: changes land through pull requests only, with passing CI and all review
  conversations resolved.

CI runs on GitHub-hosted runners. A maintainer must approve workflow runs for first-time
contributors before they start.

## License

Content Transformation Studio (`ingestion-harness`) is licensed under the
[Apache License 2.0](LICENSE). By submitting a contribution you agree that it is licensed under
the same terms (Apache-2.0 section 5).
