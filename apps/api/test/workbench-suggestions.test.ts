import { describe, expect, it } from 'vitest';
import type { SuggestParams } from '@ih/shared';
import { MemoryRepo } from '../src/repositories/memory.js';
import { SEGMENT_PRIORITY } from '../src/repositories/types.js';

const params: SuggestParams = {
  surveyProposalId: 'p1',
  candidates: [{ name: 'batch_number', description: '', kind: 'field' }],
  library: [{ id: 'domain', version: 1, label: 'Domain', terms: 3 }],
  pinned: [],
  dataPolicy: 'local',
};

describe('suggest jobs (repository)', () => {
  it('keeps one per project and returns the replaced ids', async () => {
    const repo = new MemoryRepo();
    const first = await repo.createSuggestJob('letter', params);
    const second = await repo.createSuggestJob('letter', params);
    expect(second.removed).toEqual([first.job.id]);
    expect(repo.priorities.get(second.job.id)).toBe(SEGMENT_PRIORITY);
    expect((await repo.latestSuggestJob('letter'))?.id).toBe(second.job.id);
    expect((await repo.latestSuggestJob('letter'))?.params).toEqual(params);
    expect(await repo.latestSuggestJob('other')).toBeNull();
  });
});
