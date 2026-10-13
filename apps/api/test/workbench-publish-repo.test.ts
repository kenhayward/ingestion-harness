import { describe, expect, it, vi } from 'vitest';
import { letter, testApp } from './helpers.js';

describe('publish persistence', () => {
  it('stores the threshold and logs publications newest first', async () => {
    const { workbench } = await testApp();
    await workbench.createProject('letter', 'Letter');
    expect((await workbench.getProject('letter'))!.publishThreshold).toBe(0.9);
    expect((await workbench.setPublishThreshold('letter', 0.75, null))!.publishThreshold).toBe(
      0.75,
    );
    expect(await workbench.setPublishThreshold('nope', 0.5, null)).toBeNull();
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

  it('records who last set the threshold, and when', async () => {
    const { workbench } = await testApp();
    const created = await workbench.createProject('letter', 'Letter');
    expect(created).toMatchObject({ thresholdSetBy: null, thresholdSetAt: null });
    const set = (await workbench.setPublishThreshold('letter', 0.8, 'ken'))!;
    expect(set.thresholdSetBy).toBe('ken');
    expect(Number.isNaN(Date.parse(set.thresholdSetAt!))).toBe(false);
    expect(await workbench.getProject('letter')).toEqual(set);
  });
});

describe('publishDraft', () => {
  const publication = {
    projectId: 'letter',
    version: 1,
    iterationId: null,
    score: 0.95,
    threshold: 0.9,
    overrideReason: null,
    publishedBy: 'ken',
  };

  async function draft() {
    const ctx = await testApp();
    await ctx.workbench.createProject('letter', 'Letter');
    await ctx.templates.create('letter', 1, letter(1), 'draft');
    return ctx;
  }

  it('publishes the draft and records the publication', async () => {
    const { workbench, templates } = await draft();
    const result = await workbench.publishDraft({
      projectId: 'letter',
      version: 1,
      definition: { ...letter(1) },
      publication,
    });
    expect(result.result).toBe('published');
    expect((await templates.get('letter', 1))!.status).toBe('published');
    const listed = await workbench.listPublications('letter');
    expect(listed).toHaveLength(1);
    expect(result).toEqual({ result: 'published', publication: listed[0] });
    expect(listed[0]).toMatchObject(publication);
  });

  it('writes nothing when the draft changed', async () => {
    const { workbench, templates } = await draft();
    const result = await workbench.publishDraft({
      projectId: 'letter',
      version: 1,
      definition: { ...letter(1), name: 'Older' },
      publication,
    });
    expect(result).toEqual({ result: 'changed' });
    expect((await templates.get('letter', 1))!.status).toBe('draft');
    expect(await workbench.listPublications('letter')).toEqual([]);
  });

  it('writes nothing when the version is not an open draft', async () => {
    const { workbench, templates } = await draft();
    await templates.publish('letter', 1);
    const input = { projectId: 'letter', definition: letter(1), publication };
    expect(await workbench.publishDraft({ ...input, version: 1 })).toEqual({
      result: 'not-draft',
    });
    expect(await workbench.publishDraft({ ...input, version: 2 })).toEqual({
      result: 'not-draft',
    });
    expect(await workbench.listPublications('letter')).toEqual([]);
  });

  it('leaves the draft open when the publication cannot be recorded', async () => {
    const { workbench, templates } = await draft();
    vi.spyOn(workbench, 'recordPublication').mockRejectedValue(new Error('insert failed'));
    await expect(
      workbench.publishDraft({
        projectId: 'letter',
        version: 1,
        definition: letter(1),
        publication,
      }),
    ).rejects.toThrow('insert failed');
    expect((await templates.get('letter', 1))!.status).toBe('draft');
    expect(await workbench.listPublications('letter')).toEqual([]);
  });
});
