import { describe, expect, it } from 'vitest';
import type { TemplateChangeInput } from '@ih/shared';
import { MemoryTemplateRepo } from '../src/templates/repo.js';

const hand = (summary = 'Added field a'): TemplateChangeInput => ({
  source: 'hand',
  stage: null,
  proposalId: null,
  summary,
  diff: ['+ a'],
  by: 'Ken',
});
const started: TemplateChangeInput = {
  source: 'started',
  stage: null,
  proposalId: null,
  summary: 'Draft v1 created',
  diff: [],
  by: null,
};

describe('MemoryTemplateRepo change log (TP1)', () => {
  it('logs a draft write with the write, newest first', async () => {
    const repo = new MemoryTemplateRepo();
    await repo.create('letter', 1, { id: 'letter', version: 1 }, 'draft', started);
    await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'A' },
      { change: hand() },
    );
    await repo.updateDraft('letter', 1, { id: 'letter', version: 1, name: 'B' }); // no change given
    const changes = await repo.listChanges('letter', 1);
    expect(changes.map((c) => [c.source, c.summary, c.by])).toEqual([
      ['hand', 'Added field a', 'Ken'],
      ['started', 'Draft v1 created', null],
    ]);
    expect(changes[0]).toMatchObject({ version: 1, stage: null, proposalId: null, diff: ['+ a'] });
    expect(Date.parse(changes[0]!.at)).not.toBeNaN();
  });

  it('refuses a stale base: nothing is written or logged', async () => {
    const repo = new MemoryTemplateRepo();
    const v1 = await repo.create('letter', 1, { id: 'letter', version: 1 }, 'draft');
    const a = await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'A' },
      { expectedUpdatedAt: v1.updatedAt, change: hand() },
    );
    expect(a!.updatedAt > v1.updatedAt).toBe(true); // the clock always moves
    const stale = await repo.updateDraft(
      'letter',
      1,
      { id: 'letter', version: 1, name: 'B' },
      { expectedUpdatedAt: v1.updatedAt, change: hand('stale') },
    );
    expect(stale).toBeNull();
    expect((await repo.get('letter', 1))!.definition).toMatchObject({ name: 'A' });
    expect((await repo.listChanges('letter', 1)).map((c) => c.summary)).toEqual(['Added field a']);
  });

  it('never logs for a published version, and a deleted draft takes its log', async () => {
    const repo = new MemoryTemplateRepo();
    await repo.create('letter', 1, { id: 'letter', version: 1 }, 'published', started);
    expect(await repo.listChanges('letter', 1)).toEqual([]);
    expect(await repo.updateDraft('letter', 1, { name: 'x' }, { change: hand() })).toBeNull();
    expect(await repo.listChanges('letter', 1)).toEqual([]);
    await repo.create('letter', 2, { id: 'letter', version: 2 }, 'draft', started);
    await repo.create('other', 1, { id: 'other', version: 1 }, 'draft', started);
    expect(await repo.deleteDraft('letter', 2)).toBe(true);
    expect(await repo.listChanges('letter', 2)).toEqual([]);
    expect(await repo.listChanges('other', 1)).toHaveLength(1);
  });
});
