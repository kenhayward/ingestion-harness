import { describe, expect, it } from 'vitest';
import { SEGMENT_PRIORITY, type SegmentJobParams } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

const params: SegmentJobParams = {
  samples: [{ sampleId: 's1', sha256: 'abc' }],
  document: { sections: [{ id: 'all', anchor: '\\A', required: true }], pageMarkers: true },
};

describe('segment jobs', () => {
  it('queues one preview per project, replacing the earlier ones', async () => {
    const { repo } = await testApp();
    const first = await repo.createSegmentJob('letter', params);
    expect(first.removed).toEqual([]);
    expect(first.job).toMatchObject({ projectId: 'letter', status: 'queued', error: null });
    const other = await repo.createSegmentJob('memo', params);
    const second = await repo.createSegmentJob('letter', params);
    expect(second.removed).toEqual([first.job.id]);
    expect(await repo.getSegmentJob('letter', first.job.id)).toBeNull();
    expect(await repo.getSegmentJob('letter', second.job.id)).toMatchObject({ status: 'queued' });
    expect(await repo.getSegmentJob('memo', other.job.id)).not.toBeNull();
    expect(await repo.getSegmentJob('letter', other.job.id)).toBeNull(); // scoped by project
    expect(repo.segmentJobs.get(second.job.id)?.params).toEqual(params);
  });

  it('keeps segment jobs out of every job listing', async () => {
    const { app, repo } = await testApp();
    const { job } = await repo.createSegmentJob('letter', params);
    repo.segmentJobs.set(job.id, { ...repo.segmentJobs.get(job.id)!, status: 'succeeded' });
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect(await repo.listProjectJobs('letter')).toEqual([]);
    expect(await repo.finishedJobIdsBefore('2999-01-01T00:00:00.000Z', true)).toEqual([]);
    expect(await repo.getJob(job.id)).toBeNull();
  });

  it('documents the priority between production and other workbench work', () => {
    expect(SEGMENT_PRIORITY).toBe(-5);
  });
});
