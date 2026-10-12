import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

describe('publish persistence', () => {
  it('stores the threshold and logs publications newest first', async () => {
    const { workbench } = await testApp();
    await workbench.createProject('letter', 'Letter');
    expect((await workbench.getProject('letter'))!.publishThreshold).toBe(0.9);
    expect((await workbench.setPublishThreshold('letter', 0.75))!.publishThreshold).toBe(0.75);
    expect(await workbench.setPublishThreshold('nope', 0.5)).toBeNull();
    const a = await workbench.recordPublication({
      projectId: 'letter',
      version: 1,
      iterationId: null,
      score: null,
      threshold: 0.75,
      overrideReason: 'First version, no holdout yet',
      publishedBy: 'admin',
    });
    const b = await workbench.recordPublication({
      projectId: 'letter',
      version: 2,
      iterationId: null,
      score: 0.92,
      threshold: 0.75,
      overrideReason: null,
      publishedBy: null,
    });
    expect((await workbench.listPublications('letter')).map((p) => p.id)).toEqual([b.id, a.id]);
    expect(b.publishedAt > a.publishedAt).toBe(true);
  });

  it('records holdout iterations', async () => {
    const { workbench } = await testApp();
    await workbench.createProject('letter', 'Letter');
    const created = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: {},
      briefVersion: null,
      set: 'holdout',
      model: null,
      jobIds: [],
      groupId: null,
      uncached: false,
    });
    expect((await workbench.getIteration('letter', created.id))!.set).toBe('holdout');
  });
});
