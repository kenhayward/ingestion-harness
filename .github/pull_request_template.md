## What & why

## Tests
- [ ] New behaviour has a failing test first (TDD) — link or name the test(s)
- [ ] `npm run check` passes locally (lint, typecheck, vitest, ruff, mypy, pytest)

## Specs / contracts
- [ ] Spec format change mirrored in both `packages/shared/src/spec.ts` and `worker/src/ingest_worker/specs.py`
- [ ] Published spec versions untouched (new `v<N+1>/` directory instead)
- [ ] DB change is a new forward-only migration in `db/migrations/`
