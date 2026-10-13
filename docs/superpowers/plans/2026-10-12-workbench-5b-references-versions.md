# Workbench 5b: References Across Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** References of a Workbench document type belong to a template version: vN keeps its own set for regression, v(N+1) starts from a copy, and a copied reference is re-verified only when the outputs it was verified against changed.

**Architecture:** `template_references` gains `template_version`, `copied_from`, `verified_outputs` and `superseded_at` (migration 0018). A reference saved for a Workbench type is pinned to the job's template version and remembers the outputs definition it was verified against; references of other types stay unpinned (`template_version IS NULL`, every version, as today). Opening the Workbench on draft v(N+1) copies the newest earlier version's live references forward (idempotent). A pure `outputChanges(verified, current)` in `packages/shared` decides whether a reference is outdated; outdated references count as unverified everywhere (references stage, reference runs, evaluation, regression). Re-verifying a sample supersedes its old reference at that version instead of deleting it, so older iterations keep their comparisons.

**Tech Stack:** Postgres (forward-only migration), Fastify + Zod (`apps/api`), shared TS (`packages/shared`), React (`apps/web`), Vitest.

**Spec:** `docs/design/workbench.md`, section "References across versions" (and Phasing item 5b). ADR: `docs/adr/0007-workbench.md`.

## Global Constraints

- Spec: "References belong to a template version when used for regression. Moving the project to v(N+1) keeps vN's references pinned to vN. Samples added for v(N+1) don't change vN's regression results. Accepted references are copied forward as the starting set for the new version, and re-verified only where outputs changed."
- Migrations are forward-only: add `db/migrations/0018_reference_versions.sql`; never edit 0001–0017.
- Unit tests never touch Postgres; `PgRepo` changes are covered by the opt-in `apps/api/test/integration/workbench-pg.test.ts` on a throwaway container (see CLAUDE.md), never the user's dev-infra DB.
- TypeScript: ESM `.js` import suffixes, Zod at boundaries, no `any` without a comment.
- Red first: every behaviour change starts with a failing test that is run and seen failing.
- References of document types **without** a Workbench project keep today's behaviour exactly (unpinned, every version, name unique per type).
- No worker change: reference, evaluation and regression runs are ordinary `process` jobs.
- Don't commit `config/llm-providers.yaml` (local line-ending noise).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Re-saving a reference for the same sample at the same version (re-verify), even with the same name, succeeds, supersedes the old one, and iterations scored against the old one still show their comparison — pinned in Task 1 (repo) and Task 3 (iteration view).
2. Carrying forward twice (two concurrent GETs, or a GET after the copy) creates exactly one copy set — pinned in Task 1 (memory + Pg unique index).
3. A description or name change to an output is not a change; an enum value change, a type change, an added column are — pinned by the `outputChanges` table in Task 1.
4. A non-Workbench type's references still apply to every version (a v3 regression includes references saved from v1 jobs) — pinned in Task 2.
5. A draft deleted and recreated at the same version reuses that version's pinned references, judged against the new draft's outputs — pinned in Task 3.

---

## File structure

| File | Responsibility |
| --- | --- |
| `db/migrations/0018_reference_versions.sql` (create) | Columns, backfill of Workbench references, partial unique index |
| `packages/shared/src/jobs.ts` (modify) | `Reference` gains `templateVersion`, `copiedFrom`, `verifiedOutputs`, `supersededAt` |
| `packages/shared/src/references.ts` (create) | `outputChanges` (pure) |
| `packages/shared/src/evaluation.ts` (modify) | `ReferenceRow.reference` gains `version`, `carriedFrom`, `outdated` |
| `apps/api/src/repositories/{types,memory,pg}.ts` (modify) | Pinned create with supersede, version-scoped list, `listReferencesWithSha` returns every row, `carryReferencesForward` |
| `apps/api/src/regression/report.ts` (modify) | `versionReferences` (live, pinned-or-unpinned, not outdated) |
| `apps/api/src/routes/references.ts`, `templates.ts` (modify) | Pin on save for Workbench types; `?version=`; version-scoped regression and card |
| `apps/api/src/routes/workbench.ts` (modify) | Version-scoped reference rows, carry forward, outdated = unverified, iteration view over every row |
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/templates/QualityPanel.tsx`, `apps/web/src/workbench/ReferencesTab.tsx` (modify) | Version-scoped list; carried/outdated badges |
| `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md` (modify) | Rules and phasing |

---

### Task 1: Migration 0018, shared contract and the repository

**Files:**
- Create: `db/migrations/0018_reference_versions.sql`
- Create: `packages/shared/src/references.ts`, `packages/shared/test/references.test.ts`
- Modify: `packages/shared/src/index.ts` (export `./references.js`), `packages/shared/src/jobs.ts` (`Reference`), `packages/shared/src/evaluation.ts` (`ReferenceRow`)
- Modify: `apps/api/src/repositories/types.ts`, `memory.ts`, `pg.ts`
- Create: `apps/api/test/references-repo.test.ts`
- Modify: `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- Produces:
  - `Reference` (shared) adds `templateVersion: number | null; copiedFrom: string | null; verifiedOutputs: unknown; supersededAt: string | null`.
  - `ReferenceRow.reference` (shared) becomes `{ id: string; name: string; createdAt: string; version: number | null; carriedFrom: number | null; outdated: string[] } | null`.
  - `outputChanges(verified: unknown, current: unknown): string[]` from `@ih/shared`.
  - `NewReference` (api `repositories/types.ts`) = `Omit<Reference, 'id' | 'createdAt' | 'templateVersion' | 'copiedFrom' | 'verifiedOutputs' | 'supersededAt'> & { templateVersion?: number | null; verifiedOutputs?: unknown }`.
  - `Repo.createReference(input: NewReference): Promise<Reference>` — with a `templateVersion`, first supersedes live references of the same template and version whose document has the same sha256.
  - `Repo.listReferences(templateId: string, version?: number): Promise<Reference[]>` — live rows only (`supersededAt === null`); with `version`, rows pinned to it or unpinned. Oldest first.
  - `Repo.listReferencesWithSha(templateId: string): Promise<(Reference & { sha256: string })[]>` — **every** row (superseded and every version), newest first.
  - `Repo.carryReferencesForward(templateId: string, toVersion: number): Promise<number>` — copies created.

- [ ] **Step 1: Write the failing `outputChanges` table test**

`packages/shared/test/references.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { outputChanges } from '../src/references.js';

const base = {
  fields: [
    { id: 'sender', type: 'text', description: 'who wrote it' },
    { id: 'kind', type: 'enum', enum: ['a', 'b'] },
  ],
  tables: [{ id: 'lines', columns: [{ id: 'item' }, { id: 'qty', type: 'number' }] }],
};
const clone = () => JSON.parse(JSON.stringify(base)) as typeof base & Record<string, unknown>;

describe('outputChanges', () => {
  const cases: [string, unknown, unknown, string[]][] = [
    ['identical', base, base, []],
    ['legacy reference (no verified outputs) is trusted', null, base, []],
    [
      'names and descriptions do not count',
      base,
      (() => {
        const c = clone();
        c.fields[0]!.description = 'changed';
        (c.tables[0] as Record<string, unknown>).name = 'Lines';
        return c;
      })(),
      [],
    ],
    [
      'missing type is text',
      base,
      (() => {
        const c = clone();
        delete (c.fields[0] as Record<string, unknown>).type;
        return c;
      })(),
      [],
    ],
    [
      'enum order does not count',
      base,
      (() => {
        const c = clone();
        c.fields[1]!.enum = ['b', 'a'];
        return c;
      })(),
      [],
    ],
    [
      'enum value changed',
      base,
      (() => {
        const c = clone();
        c.fields[1]!.enum = ['a', 'c'];
        return c;
      })(),
      ['field:kind'],
    ],
    [
      'field added and field type changed',
      base,
      (() => {
        const c = clone();
        c.fields[0]!.type = 'date';
        c.fields.push({ id: 'total', type: 'number' } as (typeof c.fields)[number]);
        return c;
      })(),
      ['field:sender', 'field:total'],
    ],
    ['field removed', base, { ...clone(), fields: [base.fields[0]] }, ['field:kind']],
    ['table removed', base, { ...clone(), tables: [] }, ['table:lines']],
    [
      'column added and column type changed',
      base,
      (() => {
        const c = clone();
        c.tables[0]!.columns[1]!.type = 'text';
        c.tables[0]!.columns.push({ id: 'unit' } as (typeof c.tables)[0]['columns'][number]);
        return c;
      })(),
      ['table:lines.qty', 'table:lines.unit'],
    ],
    ['current outputs unreadable', base, null, ['field:kind', 'field:sender', 'table:lines']],
  ];
  it.each(cases)('%s', (_name, verified, current, expected) => {
    expect(outputChanges(verified, current)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --project shared packages/shared/test/references.test.ts`
Expected: FAIL — cannot resolve `../src/references.js`.

- [ ] **Step 3: Implement `outputChanges`**

`packages/shared/src/references.ts`:

```ts
/**
 * Workbench references across versions (phase 5b): a reference remembers the outputs definition
 * it was verified against. It stays valid for a later version while every value it covers keeps
 * its shape; names and descriptions don't change values, so they don't count.
 */

type Shape = Map<string, string>;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);

/** A value's shape: type (default text) and its enum values, order ignored. */
const valueShape = (v: Record<string, unknown>) =>
  JSON.stringify([
    typeof v.type === 'string' ? v.type : 'text',
    Array.isArray(v.enum) ? [...(v.enum as unknown[])].map(String).sort() : null,
  ]);

/** `field:<id>`, `table:<id>` and `table:<id>.<column>` keys with their shapes. */
function shapes(outputs: unknown): Shape {
  const out: Shape = new Map();
  const o = record(outputs);
  for (const f of list(o.fields)) {
    if (typeof f.id === 'string') out.set(`field:${f.id}`, valueShape(f));
  }
  for (const t of list(o.tables)) {
    if (typeof t.id !== 'string') continue;
    out.set(`table:${t.id}`, '');
    for (const c of list(t.columns)) {
      if (typeof c.id === 'string') out.set(`table:${t.id}.${c.id}`, valueShape(c));
    }
  }
  return out;
}

/**
 * Output keys whose values a reference verified against `verified` can no longer vouch for under
 * `current`: added, removed or reshaped fields, tables and columns. A removed table reports the
 * table only. Null `verified` (an unpinned, legacy reference) is always trusted: [].
 */
export function outputChanges(verified: unknown, current: unknown): string[] {
  if (verified === null || verified === undefined) return [];
  const before = shapes(verified);
  const after = shapes(current);
  const changed = new Set<string>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    const table = key.startsWith('table:') && key.includes('.') ? key.slice(0, key.indexOf('.')) : null;
    // a column of a table that is gone (or new) as a whole is reported as the table
    if (table && before.has(table) !== after.has(table)) continue;
    changed.add(key);
  }
  return [...changed].sort();
}
```

Add `export * from './references.js';` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run --project shared packages/shared/test/references.test.ts`
Expected: PASS (12 cases).

- [ ] **Step 5: Extend the shared types**

In `packages/shared/src/jobs.ts`, `Reference` becomes:

```ts
export interface Reference {
  id: string;
  templateId: string;
  /** Workbench types: the template version it belongs to. Null: every version (other types). */
  templateVersion: number | null;
  name: string;
  documentId: string;
  sourceJobId: string | null;
  /** The reference it was carried forward from (a copy for the next version). */
  copiedFrom: string | null;
  /** The outputs definition the expected values were verified against (null: unpinned). */
  verifiedOutputs: unknown;
  /** Set when a re-verified reference replaced this one; kept for older iterations. */
  supersededAt: string | null;
  expected: { fields: Record<string, unknown>; tables: Record<string, Record<string, unknown>[]> };
  createdAt: string;
}
```

In `packages/shared/src/evaluation.ts`, `ReferenceRow.reference` becomes:

```ts
  reference: {
    id: string;
    name: string;
    createdAt: string;
    /** Version it is pinned to; null for an unpinned (legacy) reference. */
    version: number | null;
    /** Version it was carried forward from, when it is a copy. */
    carriedFrom: number | null;
    /** `outputChanges` against the version's outputs: non-empty means re-verify before use. */
    outdated: string[];
  } | null;
```

Run `npm run typecheck`; fix every compile error the new required fields cause in API and web code by filling them where references are built (memory repo, pg mapping, `workbench.ts` row building with `version: reference.templateVersion, carriedFrom: null, outdated: []` for now — Task 3 fills the real values), and in test fixtures that build `Reference`/`ReferenceRow` literals (add the new fields; these are deliberate type-driven fixture changes, not weakened assertions). Check the **exit code** (`echo $?`), not truncated output.

- [ ] **Step 6: Write the failing repository tests (memory)**

`apps/api/test/references-repo.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReferenceConflictError } from '../src/repositories/types.js';
import { MemoryRepo } from '../src/repositories/memory.js';

const outputs = { fields: [{ id: 'sender', type: 'text' }] };

async function docOf(repo: MemoryRepo, sha256: string, version = 1) {
  const job = await repo.createDocumentAndJob(
    {
      id: randomUUID(),
      filename: `${sha256}.pdf`,
      sha256,
      sizeBytes: 1,
      specId: 'letter',
      specVersion: version,
      bucket: 'inbox',
      objectKey: `letter/${sha256}.pdf`,
    },
    null,
    true,
  );
  return job;
}

const input = (job: { id: string; documentId: string }, name: string, templateVersion?: number) => ({
  templateId: 'letter',
  name,
  documentId: job.documentId,
  sourceJobId: job.id,
  expected: { fields: { sender: name }, tables: {} },
  ...(templateVersion === undefined ? {} : { templateVersion, verifiedOutputs: outputs }),
});

describe('references across versions (repository)', () => {
  it('keeps unpinned references unchanged: every version, name unique per type', async () => {
    const repo = new MemoryRepo();
    const ref = await repo.createReference(input(await docOf(repo, 'a'), 'a'));
    expect(ref).toMatchObject({ templateVersion: null, copiedFrom: null, verifiedOutputs: null, supersededAt: null });
    expect((await repo.listReferences('letter', 7)).map((r) => r.id)).toEqual([ref.id]);
    await expect(repo.createReference(input(await docOf(repo, 'b'), 'a'))).rejects.toThrow(
      ReferenceConflictError,
    );
  });

  it('scopes pinned references to their version; the same name may exist per version', async () => {
    const repo = new MemoryRepo();
    const v1 = await repo.createReference(input(await docOf(repo, 'a'), 'a', 1));
    const v2 = await repo.createReference(input(await docOf(repo, 'b', 2), 'a', 2));
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([v1.id]);
    expect((await repo.listReferences('letter', 2)).map((r) => r.id)).toEqual([v2.id]);
    expect((await repo.listReferences('letter')).map((r) => r.id)).toEqual([v1.id, v2.id]);
  });

  it('re-verifying a sample at a version supersedes its reference, even under the same name', async () => {
    const repo = new MemoryRepo();
    const old = await repo.createReference(input(await docOf(repo, 'a'), 'a', 1));
    const again = await repo.createReference(input(await docOf(repo, 'a'), 'a', 1));
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([again.id]);
    const all = await repo.listReferencesWithSha('letter');
    expect(all.map((r) => [r.id, r.supersededAt !== null])).toEqual([
      [again.id, false],
      [old.id, true],
    ]);
    // a different sample under a taken name is still a conflict
    await expect(repo.createReference(input(await docOf(repo, 'b'), 'a', 1))).rejects.toThrow(
      ReferenceConflictError,
    );
  });

  it('carries the newest earlier version forward once', async () => {
    const repo = new MemoryRepo();
    await repo.createReference(input(await docOf(repo, 'a'), 'old', 1));
    const a = await repo.createReference(input(await docOf(repo, 'a', 2), 'a', 2));
    const b = await repo.createReference(input(await docOf(repo, 'b', 2), 'b', 2));
    expect(await repo.carryReferencesForward('letter', 3)).toBe(2);
    expect(await repo.carryReferencesForward('letter', 3)).toBe(0);
    const v3 = await repo.listReferences('letter', 3);
    expect(v3.map((r) => [r.name, r.copiedFrom, r.templateVersion, r.verifiedOutputs])).toEqual([
      ['a', a.id, 3, outputs],
      ['b', b.id, 3, outputs],
    ]);
    // v2 is untouched
    expect((await repo.listReferences('letter', 2)).map((r) => r.id)).toEqual([a.id, b.id]);
    // nothing earlier: nothing to carry
    expect(await repo.carryReferencesForward('letter', 1)).toBe(0);
  });
});
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run --project api apps/api/test/references-repo.test.ts`
Expected: FAIL — `carryReferencesForward` is not a function / versions ignored.

- [ ] **Step 8: Implement the repository (types and memory)**

`apps/api/src/repositories/types.ts`: add and use `NewReference` (Interfaces above); replace the four reference signatures:

```ts
  /**
   * Throws ReferenceConflictError when the name is taken among live references of the template
   * and version (unpinned references share one namespace). With `templateVersion`, live
   * references of that version for the same PDF (sha256) are superseded first: re-verifying.
   */
  createReference(input: NewReference): Promise<Reference>;
  /** Live references, oldest first; with `version`, those pinned to it or unpinned. */
  listReferences(templateId: string, version?: number): Promise<Reference[]>;
  /** Every reference (superseded and of every version) with its PDF's sha256, newest first. */
  listReferencesWithSha(templateId: string): Promise<(Reference & { sha256: string })[]>;
  /**
   * Copies the live references of the newest earlier version to `toVersion`, unless that version
   * already has live pinned references. Idempotent; returns the number of copies.
   */
  carryReferencesForward(templateId: string, toVersion: number): Promise<number>;
```

`apps/api/src/repositories/memory.ts`:

```ts
  async listReferencesWithSha(templateId: string) {
    return [...this.references.values()]
      .filter((r) => r.templateId === templateId)
      .reverse()
      .map((r) => ({ ...r, sha256: this.documents.get(r.documentId)!.sha256 }));
  }

  private liveReferences(templateId: string) {
    return [...this.references.values()].filter(
      (r) => r.templateId === templateId && r.supersededAt === null,
    );
  }

  async createReference(input: NewReference): Promise<Reference> {
    const version = input.templateVersion ?? null;
    const sha = this.documents.get(input.documentId)?.sha256;
    // Re-verifying a sample at a pinned version replaces its reference. Decide the name
    // conflict before superseding anything, so a refused save changes nothing.
    const replaced =
      version === null
        ? []
        : this.liveReferences(input.templateId).filter(
            (r) =>
              r.templateVersion === version && this.documents.get(r.documentId)?.sha256 === sha,
          );
    const taken = this.liveReferences(input.templateId).some(
      (r) => !replaced.includes(r) && r.templateVersion === version && r.name === input.name,
    );
    if (taken) throw new ReferenceConflictError(`reference "${input.name}" already exists`);
    for (const r of replaced) this.references.set(r.id, { ...r, supersededAt: this.now() });
    const ref: Reference = {
      ...input,
      templateVersion: version,
      verifiedOutputs: version === null ? null : (input.verifiedOutputs ?? null),
      copiedFrom: null,
      supersededAt: null,
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.references.set(ref.id, ref);
    return ref;
  }

  async listReferences(templateId: string, version?: number): Promise<Reference[]> {
    return this.liveReferences(templateId).filter(
      (r) => version === undefined || r.templateVersion === null || r.templateVersion === version,
    );
  }

  async carryReferencesForward(templateId: string, toVersion: number): Promise<number> {
    const live = this.liveReferences(templateId);
    if (live.some((r) => r.templateVersion === toVersion)) return 0;
    const earlier = live
      .map((r) => r.templateVersion)
      .filter((v): v is number => v !== null && v < toVersion);
    if (!earlier.length) return 0;
    const from = Math.max(...earlier);
    const sources = live.filter((r) => r.templateVersion === from);
    for (const s of sources) {
      const copy: Reference = {
        ...s,
        id: randomUUID(),
        templateVersion: toVersion,
        copiedFrom: s.id,
        createdAt: this.now(),
      };
      this.references.set(copy.id, copy);
    }
    return sources.length;
  }
```

Add one more assertion to Step 6's re-verify test proving a refused save changes nothing: after the `b`-under-`a` conflict, `listReferences('letter', 1)` still returns `[again.id]`. (`PgRepo` gets the same guarantee from the transaction rollback.)

- [ ] **Step 9: Run them and see them pass**

Run: `npx vitest run --project api apps/api/test/references-repo.test.ts`
Expected: PASS.

- [ ] **Step 10: Migration 0018**

`db/migrations/0018_reference_versions.sql`:

```sql
-- Workbench phase 5b: references across versions. A Workbench type's references belong to a
-- template version (vN's regression keeps vN's set); a copy carries them to v(N+1) and remembers
-- the outputs they were verified against. Other types keep unpinned references (every version).

ALTER TABLE template_references
  ADD COLUMN template_version integer CHECK (template_version > 0),
  ADD COLUMN copied_from      uuid REFERENCES template_references (id) ON DELETE SET NULL,
  ADD COLUMN verified_outputs jsonb,
  ADD COLUMN superseded_at    timestamptz;

-- Existing Workbench references: pinned to the version their source job ran, verified against
-- that version's outputs. Without a source job they stay unpinned (every version).
UPDATE template_references r
   SET template_version = d.spec_version,
       verified_outputs = t.definition -> 'outputs'
  FROM jobs j
  JOIN documents d ON d.id = j.document_id
  JOIN templates t ON t.id = d.spec_id AND t.version = d.spec_version
 WHERE r.source_job_id = j.id
   AND EXISTS (SELECT 1 FROM workbench_projects p WHERE p.id = r.template_id);

-- Names are unique among live references of one version (unpinned ones share version 0).
ALTER TABLE template_references DROP CONSTRAINT template_references_template_id_name_key;
CREATE UNIQUE INDEX template_references_live_name_idx
  ON template_references (template_id, coalesce(template_version, 0), name)
  WHERE superseded_at IS NULL;
```

Before writing it, confirm the constraint name with `grep -n "UNIQUE" db/migrations/0005_references.sql` (an unnamed `UNIQUE (template_id, name)` is named `template_references_template_id_name_key` by Postgres).

- [ ] **Step 11: Implement `PgRepo`**

In `apps/api/src/repositories/pg.ts`, extend the `ReferenceRow` interface with `template_version: number | null; copied_from: string | null; verified_outputs: unknown; superseded_at: Date | null;` and `toReference` with `templateVersion: r.template_version, copiedFrom: r.copied_from, verifiedOutputs: r.verified_outputs ?? null, supersededAt: r.superseded_at?.toISOString() ?? null` (match how `created_at` is converted in the existing `toReference`). Then:

```ts
  async createReference(input: NewReference): Promise<Reference> {
    const version = input.templateVersion ?? null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (version !== null) {
        // Re-verifying a sample at this version: the old reference is kept for older iterations.
        await client.query(
          `UPDATE template_references SET superseded_at = now()
            WHERE template_id = $1 AND template_version = $2 AND superseded_at IS NULL
              AND document_id IN (SELECT id FROM documents
                                   WHERE sha256 = (SELECT sha256 FROM documents WHERE id = $3))`,
          [input.templateId, version, input.documentId],
        );
      }
      const { rows } = await client.query<ReferenceRow>(
        `INSERT INTO template_references
           (template_id, template_version, name, document_id, source_job_id, expected, verified_outputs)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.templateId,
          version,
          input.name,
          input.documentId,
          input.sourceJobId,
          JSON.stringify(input.expected),
          version === null ? null : JSON.stringify(input.verifiedOutputs ?? null),
        ],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        throw new ReferenceConflictError(`reference "${input.name}" already exists`);
      }
      await client.query('COMMIT');
      return toReference(rows[0]);
    } catch (err) {
      if (!(err instanceof ReferenceConflictError)) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listReferences(templateId: string, version?: number): Promise<Reference[]> {
    const { rows } = await this.pool.query<ReferenceRow>(
      `SELECT * FROM template_references
        WHERE template_id = $1 AND superseded_at IS NULL
          AND ($2::int IS NULL OR template_version IS NULL OR template_version = $2)
        ORDER BY created_at, id`,
      [templateId, version ?? null],
    );
    return rows.map(toReference);
  }

  async listReferencesWithSha(templateId: string) {
    const { rows } = await this.pool.query<ReferenceRow & { sha256: string }>(
      `SELECT r.*, d.sha256 FROM template_references r JOIN documents d ON d.id = r.document_id
        WHERE r.template_id = $1 ORDER BY r.created_at DESC, r.id DESC`,
      [templateId],
    );
    return rows.map((r) => ({ ...toReference(r), sha256: r.sha256 }));
  }

  async carryReferencesForward(templateId: string, toVersion: number): Promise<number> {
    // Concurrent callers both pass NOT EXISTS; the live-name unique index makes the second a no-op.
    const { rowCount } = await this.pool.query(
      `INSERT INTO template_references
         (template_id, template_version, name, document_id, source_job_id, expected,
          verified_outputs, copied_from)
       SELECT r.template_id, $2, r.name, r.document_id, r.source_job_id, r.expected,
              r.verified_outputs, r.id
         FROM template_references r
        WHERE r.template_id = $1 AND r.superseded_at IS NULL
          AND r.template_version = (SELECT max(template_version) FROM template_references
                                     WHERE template_id = $1 AND superseded_at IS NULL
                                       AND template_version < $2)
          AND NOT EXISTS (SELECT 1 FROM template_references
                           WHERE template_id = $1 AND superseded_at IS NULL
                             AND template_version = $2)
       ON CONFLICT DO NOTHING`,
      [templateId, toVersion],
    );
    return rowCount ?? 0;
  }
```

Follow the existing `BEGIN`/`COMMIT` pattern in `pg.ts` (around line 227) if it differs in shape (e.g. a shared helper).

- [ ] **Step 12: Extend the Pg integration test**

In `apps/api/test/integration/workbench-pg.test.ts` add (reusing `newProject`, `doc`, `repo` from the file):

```ts
  it('pins, supersedes and carries references forward across versions', async () => {
    const projectId = await newProject();
    const source = doc(projectId);
    const job = await repo.createWorkbenchJob(source, { projectId, task: 'process' });
    const outputs = { fields: [{ id: 'sender' }] };
    const base = {
      templateId: projectId,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: {}, tables: {} },
    };
    const first = await repo.createReference({ ...base, name: 'a', templateVersion: 1, verifiedOutputs: outputs });
    expect(first).toMatchObject({ templateVersion: 1, verifiedOutputs: outputs, supersededAt: null });
    const again = await repo.createReference({ ...base, name: 'a', templateVersion: 1, verifiedOutputs: outputs });
    expect((await repo.listReferences(projectId, 1)).map((r) => r.id)).toEqual([again.id]);
    const all = await repo.listReferencesWithSha(projectId);
    expect(all.find((r) => r.id === first.id)!.supersededAt).not.toBeNull();

    const [n1, n2] = await Promise.all([
      repo.carryReferencesForward(projectId, 2),
      repo.carryReferencesForward(projectId, 2),
    ]);
    expect(n1 + n2).toBe(1);
    const v2 = await repo.listReferences(projectId, 2);
    expect(v2.map((r) => [r.name, r.copiedFrom, r.templateVersion])).toEqual([['a', again.id, 2]]);
    expect((await repo.listReferences(projectId, 1)).map((r) => r.id)).toEqual([again.id]);

    const unpinned = await repo.createReference({ ...base, name: 'u' });
    expect(unpinned.templateVersion).toBeNull();
    expect((await repo.listReferences(projectId, 9)).map((r) => r.id)).toEqual([unpinned.id]);
  });
```

Also update the existing `'stores reference and model override…'` test only if the new fields break it (they should not: it asserts names and sha256).

Run it on a throwaway container, one simple command at a time:

```bash
docker run --rm -d --name ih-5b-pg -e POSTGRES_PASSWORD=test -p 55491:5432 postgres:17-alpine
```

```bash
IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55491/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg
```

```bash
docker rm -f ih-5b-pg
```

Expected: every workbench-pg test passes (wait a few seconds after `docker run` for Postgres to accept connections).

- [ ] **Step 13: Full TS suite, then commit**

Run: `npm run typecheck` (check the exit code) and `npm test`.
Expected: green. Fix fixtures that compare whole `Reference` objects with `toEqual` by adding the new fields (deliberate, list them in your report).

```bash
git add db/migrations/0018_reference_versions.sql packages/shared apps/api/src/repositories apps/api/test apps/web
git commit -m "References across versions: migration 0018, outputChanges and the repository"
```

---

### Task 2: Version-scoped references and regression (Templates side)

**Files:**
- Modify: `apps/api/src/regression/report.ts`, `apps/api/src/routes/references.ts`, `apps/api/src/routes/templates.ts`
- Test: `apps/api/test/references.test.ts`, `apps/api/test/regression.test.ts` (add cases; read both files' helpers first and reuse `setup`, `processedJob`, `post`)

**Interfaces:**
- Consumes: Task 1 `Repo.listReferences(templateId, version?)`, `NewReference.templateVersion/verifiedOutputs`, `outputChanges`.
- Produces: `versionReferences(app: FastifyInstance, templateId: string, version: number): Promise<Reference[]>` in `regression/report.ts` — live references pinned to `version` or unpinned, minus those whose `outputChanges(r.verifiedOutputs, <that version's outputs>)` is non-empty. `regressionReport(app, templateId, version, known?)` defaults `known` to `versionReferences(...)`.
- HTTP: `GET /api/templates/:id/references?version=N` (optional, positive integer; invalid → 400). `POST /api/templates/:id/references` pins to the job's `specVersion` when a Workbench project exists for `:id`.

- [ ] **Step 1: Write the failing route tests**

Add to `apps/api/test/references.test.ts` (the file's `setup()` publishes `letter` v1 and creates draft v2; `processedJob(ctx, doc, status, version)` makes a finished job):

```ts
describe('references across versions', () => {
  const project = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.app.inject(post('/api/workbench/projects', { id: 'letter', name: 'Letter' }));

  it('pins a Workbench type reference to the job version and its outputs', async () => {
    const ctx = await setup();
    await project(ctx);
    const job = await processedJob(ctx, undefined, 'succeeded', 2);
    const res = await ctx.app.inject(post('/api/templates/letter/references', { jobId: job.id, name: 'r' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      templateVersion: 2,
      verifiedOutputs: definition(2, 'two').outputs,
    });
    const v1 = await ctx.app.inject('/api/templates/letter/references?version=1');
    expect(v1.json()).toEqual([]);
    const v2 = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name)).toEqual(['r']);
  });

  it('carries the earlier version forward before pinning a save to a new version', async () => {
    const ctx = await setup();
    await project(ctx);
    const j1 = await processedJob(ctx, undefined, 'succeeded', 1);
    await ctx.repo.createReference({
      templateId: 'letter', name: 'v1', documentId: j1.documentId, sourceJobId: j1.id,
      expected: { fields: {}, tables: {} }, templateVersion: 1, verifiedOutputs: definition(1).outputs,
    });
    const j2 = await processedJob(ctx, undefined, 'succeeded', 2);
    // processedJob always uses sha256 'abc'; a different PDF, or the save would supersede the copy
    const d2 = ctx.repo.documents.get(j2.documentId)!;
    ctx.repo.documents.set(d2.id, { ...d2, sha256: 'def' });
    const res = await ctx.app.inject(post('/api/templates/letter/references', { jobId: j2.id, name: 'v2' }));
    expect(res.statusCode).toBe(201);
    const v2 = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name).sort()).toEqual(['v1', 'v2']);
  });

  it('leaves other types unpinned: a reference applies to every version', async () => {
    const ctx = await setup();
    const job = await processedJob(ctx, undefined, 'succeeded', 1);
    const res = await ctx.app.inject(post('/api/templates/letter/references', { jobId: job.id, name: 'r' }));
    expect(res.json()).toMatchObject({ templateVersion: null, verifiedOutputs: null });
    const v2 = await ctx.app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name)).toEqual(['r']);
  });

  it('rejects a bad version query', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject('/api/templates/letter/references?version=zero');
    expect(res.statusCode).toBe(400);
  });

  it('runs regression of a version on its own references only, leaving outdated ones out', async () => {
    const ctx = await setup();
    await project(ctx);
    const outputs = definition(1).outputs;
    const j1 = await processedJob(ctx, undefined, 'succeeded', 1);
    const j2 = await processedJob(ctx, undefined, 'succeeded', 2);
    await ctx.repo.createReference({
      templateId: 'letter', name: 'v1', documentId: j1.documentId, sourceJobId: j1.id,
      expected: { fields: {}, tables: {} }, templateVersion: 1, verifiedOutputs: outputs,
    });
    await ctx.repo.createReference({
      templateId: 'letter', name: 'v2', documentId: j2.documentId, sourceJobId: j2.id,
      expected: { fields: {}, tables: {} }, templateVersion: 2,
      verifiedOutputs: { fields: [{ id: 'gone' }], tables: [] }, // verified against other outputs
    });
    const r1 = await ctx.app.inject(post('/api/templates/letter/versions/1/regression', {}));
    expect(r1.statusCode).toBe(201);
    expect(r1.json().jobs).toHaveLength(1);
    const r2 = await ctx.app.inject(post('/api/templates/letter/versions/2/regression', {}));
    expect(r2.statusCode).toBe(400); // v2's only reference is outdated
    const report = await ctx.app.inject('/api/templates/letter/versions/1/regression');
    expect(report.json().summary.references).toBe(1);
  });
});
```

Reuse the file's existing `definition` helper (its v1 and v2 outputs are equal; the outdated case comes from the explicit `verifiedOutputs`). Add one regression test to `regression.test.ts` only if `references.test.ts` cannot express it; prefer keeping the cases together.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project api apps/api/test/references.test.ts`
Expected: FAIL — `templateVersion` is null for the Workbench type, `?version` ignored, regression of v2 creates a job.

- [ ] **Step 3: Implement**

`apps/api/src/regression/report.ts`:

```ts
import { outputChanges, type JobDetail, type Reference } from '@ih/shared';

/**
 * The references a version is regression-tested against: live ones pinned to it or unpinned,
 * minus those verified against outputs this version has changed (re-verify them first).
 */
export async function versionReferences(
  app: FastifyInstance,
  templateId: string,
  version: number,
): Promise<Reference[]> {
  const [references, record] = await Promise.all([
    app.deps.repo.listReferences(templateId, version),
    app.deps.templates.get(templateId, version),
  ]);
  const outputs = (record?.definition as { outputs?: unknown } | undefined)?.outputs ?? null;
  return references.filter((r) => outputChanges(r.verifiedOutputs, outputs).length === 0);
}
```

and in `regressionReport` replace `known ?? (await app.deps.repo.listReferences(templateId))` with `known ?? (await versionReferences(app, templateId, version))`.

`apps/api/src/routes/references.ts`:
- `GET /templates/:id/references`: parse `req.query` with `z.object({ version: z.coerce.number().int().positive().optional() }).strict()`; 400 on failure; `listReferences(id, version)`.
- `POST /templates/:id/references`: after the job checks, when `await app.deps.workbench.getProject(req.params.id)` is non-null, first `await app.deps.repo.carryReferencesForward(req.params.id, job.specVersion)` (otherwise a save made before anyone opened the References tab would give the version references of its own and the earlier set would never be carried), then pass `templateVersion: job.specVersion` and `verifiedOutputs: ((await app.deps.templates.get(req.params.id, job.specVersion))?.definition as { outputs?: unknown } | undefined)?.outputs ?? null`. Otherwise pass neither.
- `POST /templates/:id/versions/:version/regression`: `const references = await versionReferences(app, req.params.id, version);` (keep the 400 message when empty).

`apps/api/src/routes/templates.ts` `summarise`: `const refs = await versionReferences(app, id, latest.version);` (import it from `../regression/report.js`).

- [ ] **Step 4: Run them and see them pass, then the API project**

Run: `npx vitest run --project api apps/api/test/references.test.ts` then `npx vitest run --project api`
Expected: PASS. Existing regression/templates tests use unpinned references and must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/regression/report.ts apps/api/src/routes/references.ts apps/api/src/routes/templates.ts apps/api/test
git commit -m "API: version-scoped references and regression for Workbench types"
```

---

### Task 3: Workbench references across versions

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Create: `apps/api/test/workbench-versions.test.ts`

**Interfaces:**
- Consumes: Task 1 (`carryReferencesForward`, `listReferencesWithSha` returning every row, `outputChanges`, `ReferenceRow.reference` shape), Task 2 (`POST /api/templates/:id/references` pins for Workbench types).
- Produces (behaviour):
  - The Workbench's **current version** is the open draft, else the latest published version (`versionsOf`). With an open draft, every reference read first calls `carryReferencesForward(projectId, draft)`.
  - Reference rows use live references pinned to the current version or unpinned; `reference.version`, `reference.carriedFrom` (the `templateVersion` of the `copiedFrom` row, null otherwise), `reference.outdated = outputChanges(verifiedOutputs, currentDefinition.outputs)`.
  - A row is **verified** only when `reference !== null && reference.outdated.length === 0`. This applies to: the references stage state (`referencesView`), `startReferences` (`unverified`), holdout reference runs, and `evaluationInputs` (only verified rows are evaluated). The 409 messages stay as they are.
  - Iteration views and comparisons look references up by id among **all** rows (`listReferencesWithSha` already returns superseded and other-version rows), so older iterations keep their comparisons.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/workbench-versions.test.ts` — build on the `project()` helper pattern from `apps/api/test/workbench-references.test.ts` (copy it in; do not import from another test file):

```ts
import { describe, expect, it } from 'vitest';
import { preparedTriageKey, type ReferenceRow, type SampleView, type StageView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id: 'letter', name: 'Letter' } });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev') => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put('runs', preparedTriageKey(s.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    return s;
  };
  const skipAll = async () => {
    for (const stage of ['survey', 'outputs', 'sections', 'steps']) {
      await ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}/skip` });
    }
  };
  const rows = async (set = 'dev') =>
    (await ctx.app.inject(`/api/workbench/projects/letter/references?set=${set}`)).json() as ReferenceRow[];
  const stage = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).find(
      (s) => s.stage === 'references',
    );
  /** A verified reference for sample `s` at `version`, as Save as reference would pin it. */
  const verify = async (s: SampleView, version: number, name = s.filename) => {
    const doc = [...ctx.repo.documents.values()].find((d) => d.sha256 === s.sha256)!;
    const outputs = (await ctx.templates.get('letter', version))!.definition.outputs;
    return ctx.repo.createReference({
      templateId: 'letter', name, documentId: doc.id, sourceJobId: null,
      expected: { fields: { sender: 'Acme' }, tables: {} }, templateVersion: version, verifiedOutputs: outputs,
    });
  };
  /** Publish v1 and open draft v2 (optionally with changed outputs). */
  const nextVersion = async (outputs?: unknown) => {
    await ctx.templates.publish('letter', 1);
    await ctx.templates.create('letter', 2, { ...letter(2), ...(outputs ? { outputs } : {}) }, 'draft');
  };
  return { ...ctx, add, skipAll, rows, stage, verify, nextVersion };
}

describe('references across versions (workbench)', () => {
  it('carries v1 references to draft v2; unchanged outputs keep them verified', async () => {
    const { add, skipAll, rows, stage, verify, nextVersion, repo } = await project();
    const s = await add(1);
    await skipAll();
    const v1 = await verify(s, 1);
    await nextVersion();
    const [row] = await rows();
    expect(row!.reference).toMatchObject({ version: 2, carriedFrom: 1, outdated: [] });
    expect(row!.reference!.id).not.toBe(v1.id);
    expect((await stage())!.state).toBe('accepted');
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([v1.id]);
  });

  it('marks carried references outdated when outputs changed, and runs them again', async () => {
    const { app, add, skipAll, rows, stage, verify, nextVersion } = await project();
    const s = await add(1);
    await skipAll();
    await verify(s, 1);
    await nextVersion({ fields: [{ id: 'sender', type: 'text' }, { id: 'date', type: 'date' }] });
    const [row] = await rows();
    expect(row!.reference).toMatchObject({ version: 2, carriedFrom: 1, outdated: ['field:date'] });
    expect((await stage())!.state).not.toBe('accepted');
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/references' });
    expect(res.statusCode).toBe(201);
    expect(res.json().jobs).toHaveLength(1);
  });

  it('re-verifying replaces the outdated copy; v1 keeps its reference', async () => {
    const { add, skipAll, rows, verify, nextVersion, repo } = await project();
    const s = await add(1);
    await skipAll();
    const v1 = await verify(s, 1);
    await nextVersion({ fields: [{ id: 'sender', type: 'date' }] });
    await rows(); // carries forward
    const fresh = await verify(s, 2);
    const [row] = await rows();
    expect(row!.reference).toMatchObject({ id: fresh.id, version: 2, carriedFrom: null, outdated: [] });
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([v1.id]);
  });

  it('does not evaluate outdated references', async () => {
    const { app, add, skipAll, verify, nextVersion } = await project();
    const s = await add(1);
    await skipAll();
    await verify(s, 1);
    await nextVersion({ fields: [{ id: 'sender', type: 'date' }] });
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'no verified references for the dev samples; verify some on the References tab first',
    );
  });

  it('samples added for v2 do not change v1 regression', async () => {
    const { app, add, skipAll, verify, nextVersion } = await project();
    const s1 = await add(1);
    await skipAll();
    await verify(s1, 1);
    await nextVersion();
    await rows(); // opening the References tab carries v1's references to draft v2
    const s2 = await add(2);
    await verify(s2, 2);
    const v1 = await app.inject('/api/templates/letter/references?version=1');
    expect((v1.json() as { name: string }[]).map((r) => r.name)).toEqual(['s1.pdf']);
    const v2 = await app.inject('/api/templates/letter/references?version=2');
    expect((v2.json() as { name: string }[]).map((r) => r.name).sort()).toEqual(['s1.pdf', 's2.pdf']);
  });

  it('reuses a version\'s references when its draft is deleted and recreated', async () => {
    const { add, skipAll, rows, verify, nextVersion, templates } = await project();
    const s = await add(1);
    await skipAll();
    await verify(s, 1);
    await nextVersion();
    await rows();
    await templates.deleteDraft('letter', 2);
    await templates.create('letter', 2, { ...letter(2), outputs: { fields: [{ id: 'sender', type: 'date' }] } }, 'draft');
    const [row] = await rows();
    expect(row!.reference).toMatchObject({ version: 2, carriedFrom: 1, outdated: ['field:sender'] });
  });

  it('keeps an iteration\'s comparison after its reference is superseded', async () => {
    // Evaluate on draft v1, then re-verify the sample at v1: the iteration still shows a score.
    const { app, add, skipAll, verify, repo, store } = await project();
    const s = await add(1);
    await skipAll();
    const ref = await verify(s, 1);
    const started = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations',
      payload: {},
    });
    expect(started.statusCode).toBe(201);
    const iteration = started.json() as IterationView;
    const [jobId] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId === ref.id)
      .map((r) => r.job.id);
    // finish the evaluation job with a draft document (as workbench-evaluation.test.ts does)
    const job = repo.jobs.get(jobId!)!;
    const key = outputKey('letter', 1, 'document', job.documentId, 'json');
    await store.put(
      'outputs',
      key,
      Buffer.from(JSON.stringify({ fields: { sender: { value: 'Acme' } }, tables: {} })),
      'application/json',
    );
    repo.outputs.set(jobId!, [
      { outputId: 'document', stage: 'draft', format: 'json', bucket: 'outputs', key, rowCount: null },
    ]);
    repo.jobs.set(jobId!, { ...job, status: 'succeeded' });

    await verify(s, 1, 'renamed'); // supersedes `ref`
    const view = (
      await app.inject(`/api/workbench/projects/letter/iterations/${iteration.id}`)
    ).json() as IterationView;
    expect(view.samples[0]!.comparison).toMatchObject({ score: 1 });
  });
});
```

Add `outputKey` and `type IterationView` to the `@ih/shared` import at the top of the file.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project api apps/api/test/workbench-versions.test.ts`
Expected: FAIL — no carry forward (`version: 1`/`carriedFrom: null`), outdated never set.

- [ ] **Step 3: Implement in `apps/api/src/routes/workbench.ts`**

Replace the reference lookup in `referenceEntries`:

```ts
/**
 * The project's references for its current version (the open draft, else the latest published
 * version): carried forward from the newest earlier version when the draft has none yet, with
 * each one's `outputChanges` against the current outputs.
 */
async function currentReferences(app: FastifyInstance, projectId: string) {
  const { draft, published } = await versionsOf(app.deps.templates, projectId);
  const version = draft ?? published;
  if (draft !== null) await app.deps.repo.carryReferencesForward(projectId, draft);
  const all = await app.deps.repo.listReferencesWithSha(projectId);
  const record = version === null ? null : await app.deps.templates.get(projectId, version);
  const outputs = (record?.definition as { outputs?: unknown } | undefined)?.outputs ?? null;
  const versionOfRow = new Map(all.map((r) => [r.id, r.templateVersion]));
  return all
    .filter(
      (r) =>
        r.supersededAt === null && (r.templateVersion === null || r.templateVersion === version),
    )
    .map((r) => ({
      ...r,
      carriedFrom: r.copiedFrom === null ? null : (versionOfRow.get(r.copiedFrom) ?? null),
      outdated: outputChanges(r.verifiedOutputs, outputs),
    }));
}
```

In `referenceEntries`, use `const references = await currentReferences(app, projectId);` and build `reference: reference && { id, name, createdAt, version: reference.templateVersion, carriedFrom: reference.carriedFrom, outdated: reference.outdated }`. Prefer a pinned reference over an unpinned one for the same sha256 (`references.find(pinned) ?? references.find(any)`; the list is newest first).

Add one helper next to `ReferenceEntry` and use it everywhere a row counts as verified:

```ts
/** A reference that can be evaluated: present and verified against the current outputs. */
const verifiedRow = (row: ReferenceRow) =>
  row.reference !== null && row.reference.outdated.length === 0;
```

- `referencesView`: `const verified = rows.filter(verifiedRow);` and the reference-run filter `e.row.reference === null` → `!verifiedRow(e.row)`. The accepted condition (every ready dev sample verified) uses `verifiedRow`.
- `startReferences`: `const unverified = entries.filter((e) => !verifiedRow(e.row));`.
- Holdout reference runs: `holdout.filter((e) => !verifiedRow(e.row))`.
- `evaluationInputs`: `.filter(verifiedRow)` instead of `.filter((r) => r.reference !== null)`.

Leave the iteration view's lookup (`listReferencesWithSha(iteration.projectId)` then `find((r) => r.id === job.referenceId)`) as is: it now sees every row. Grep the file for any other `reference !== null` / `reference === null` and decide each one against the rule above (list each decision in your report).

Import `outputChanges` from `@ih/shared`.

- [ ] **Step 4: Run them and see them pass, then all Workbench tests**

Run: `npx vitest run --project api apps/api/test/workbench-versions.test.ts` then `npx vitest run --project api`
Expected: PASS. Existing Workbench tests create unpinned references (`repo.createReference` without a version), which stay verified, so they pass unchanged except for `toEqual` row literals that now need `version: null, carriedFrom: null, outdated: []` (deliberate; list them).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test
git commit -m "Workbench: carry references to the next version, re-verify only changed outputs"
```

---

### Task 4: Web and docs

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/templates/QualityPanel.tsx`, `apps/web/src/workbench/ReferencesTab.tsx`
- Test: `apps/web/test/` files for `QualityPanel` and `ReferencesTab` (find them with `ls apps/web/test | grep -i "quality\|references"`; extend the existing ones)
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

**Interfaces:**
- Consumes: Task 2 `GET /api/templates/:id/references?version=N`; Task 1 `ReferenceRow.reference.{version,carriedFrom,outdated}`.
- Produces: `Api.listReferences(templateId: string, version?: number): Promise<Reference[]>`.

- [ ] **Step 1: Write the failing tests**

QualityPanel (extend its existing test file):

```ts
it('lists the references of the version it shows', async () => {
  const api = fakeApi();
  render(<QualityPanel api={api} templateId="letter" version={2} /* plus the props the existing tests pass */ />);
  await waitFor(() => expect(api.listReferences).toHaveBeenCalledWith('letter', 2));
});
```

ReferencesTab (extend its existing test file; reuse its row factory and add the new fields to it):

```ts
it('shows carried and outdated references', async () => {
  const api = fakeApi();
  api.listReferenceRows.mockImplementation(async (_id: string, set?: string) =>
    set === 'holdout'
      ? []
      : [
          row({ filename: 'a.pdf', reference: { id: 'r1', name: 'a', createdAt: 't', version: 2, carriedFrom: 1, outdated: [] } }),
          row({ filename: 'b.pdf', reference: { id: 'r2', name: 'b', createdAt: 't', version: 2, carriedFrom: 1, outdated: ['field:date', 'table:lines.qty'] } }),
        ],
  );
  render(<ReferencesTab api={api} projectId="letter" dataPolicy="local" hasDraft pollMs={1000} onChanged={() => {}} />);
  expect(await screen.findByText('carried from v1')).toBeInTheDocument();
  expect(screen.getByText(/re-verify: field:date, table:lines\.qty changed/)).toBeInTheDocument();
});
```

(`row` stands for the existing test file's `ReferenceRow` factory; if it has none, build the two literals inline with every `ReferenceRow` field.)

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project web`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement**

- `client.ts`: `listReferences(templateId: string, version?: number): Promise<Reference[]>`; implementation appends `?version=${version}` when given.
- `fake-api.ts`: the `listReferences` mock keeps `vi.fn(async () => [])` (signature-compatible); its `createReference` fake returns the new `Reference` fields (`templateVersion: null, copiedFrom: null, verifiedOutputs: null, supersededAt: null`).
- `QualityPanel.tsx`: `api.listReferences(templateId, version)`.
- `ReferencesTab.tsx`: in each row's reference cell, after the name, render `carried from v{carriedFrom}` (when not null) and, when `outdated.length > 0`, a warning `re-verify: {outdated.join(', ')} changed` and treat the row as unverified wherever the tab counts verified rows (e.g. a "N of M verified" line — use `reference !== null && reference.outdated.length === 0`). Keep the existing markup and classes; add a short note under the dev table's instructions: "References carry over from the previous version; only those whose outputs changed need verifying again."

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run --project web`
Expected: PASS.

- [ ] **Step 5: Docs**

- `docs/design/workbench.md`: Phasing — mark 5b done ("**5b (done):** references across versions."), and under "References across versions" add how it works: pinned per version (migration 0018), copy forward on opening the next draft, `outputChanges` (type, enum, added/removed fields, tables, columns; names and descriptions don't count), outdated references count as unverified until re-verified, re-verifying supersedes (kept for older iterations), other document types keep unpinned references.
- `docs/architecture.md`: the references paragraph (search for `template_references`) gets the same facts in one or two sentences.
- `CLAUDE.md`: in the Workbench bullet, after the phase 5a text, add a "References across versions (phase 5b, migration 0018)" sentence block with: pinning on save for Workbench types (job's version + verified outputs), `carryReferencesForward` on every reference read with an open draft (idempotent), `outputChanges` in `packages/shared/src/references.ts`, outdated = unverified (stage, reference runs, evaluation, regression via `versionReferences`), supersede on re-verify, unpinned (`template_version IS NULL`) references for other types apply to every version; and add `outputChanges`/`Reference` version fields to the Evaluation row of the contracts table (TS only).

- [ ] **Step 6: Full check, then commit**

Run (prepend uv's directory to `PATH` if `uv` is not found): `npm run check` and `npm run format:check`; check both **exit codes**. Run `npx prettier --write` on touched TS/MD files first if `format:check` fails.

```bash
git add apps/web CLAUDE.md docs
git commit -m "Web and docs: references across versions"
```
