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

const input = (
  job: { id: string; documentId: string },
  name: string,
  templateVersion?: number,
) => ({
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
    expect(ref).toMatchObject({
      templateVersion: null,
      copiedFrom: null,
      verifiedOutputs: null,
      supersededAt: null,
    });
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
    // a refused save changes nothing
    expect((await repo.listReferences('letter', 1)).map((r) => r.id)).toEqual([again.id]);
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
    // copies keep the source's created_at (when the sample was verified)
    expect(v3.map((r) => r.createdAt)).toEqual([a.createdAt, b.createdAt]);
    // deleting a pinned source supersedes it: the copy keeps its link
    expect(await repo.deleteReference('letter', a.id)).toBe(true);
    expect((await repo.listReferences('letter', 3)).map((r) => r.copiedFrom)).toEqual([a.id, b.id]);
    expect((await repo.listReferences('letter', 2)).map((r) => r.id)).toEqual([b.id]);
  });

  it('deleting a pinned reference supersedes it; an unpinned one is removed', async () => {
    const repo = new MemoryRepo();
    const pinned = await repo.createReference(input(await docOf(repo, 'a'), 'a', 1));
    const unpinned = await repo.createReference(input(await docOf(repo, 'b'), 'b'));
    expect(await repo.deleteReference('letter', pinned.id)).toBe(true);
    expect(await repo.deleteReference('letter', pinned.id)).toBe(false); // already gone
    expect(await repo.deleteReference('letter', unpinned.id)).toBe(true);
    const all = await repo.listReferencesWithSha('letter');
    expect(all.map((r) => [r.id, r.supersededAt !== null])).toEqual([[pinned.id, true]]);
    expect(await repo.listReferences('letter')).toEqual([]);
  });

  it('does not carry into a version whose references were all deleted', async () => {
    const repo = new MemoryRepo();
    await repo.createReference(input(await docOf(repo, 'a'), 'a', 1));
    expect(await repo.carryReferencesForward('letter', 2)).toBe(1);
    const [copy] = await repo.listReferences('letter', 2);
    await repo.deleteReference('letter', copy!.id);
    expect(await repo.carryReferencesForward('letter', 2)).toBe(0);
    expect((await repo.listReferences('letter', 2)).filter((r) => r.templateVersion === 2)).toEqual(
      [],
    );
  });
});
