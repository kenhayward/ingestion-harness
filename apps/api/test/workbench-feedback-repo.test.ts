import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

const item = {
  projectId: 'letter',
  target: 'field' as const,
  targetId: 'sender',
  sampleId: null,
  iterationId: null,
  body: 'Use the letterhead',
};

describe('feedback persistence', () => {
  it('lists newest first, resolves once and only deletes open items', async () => {
    const { workbench, repo } = await setup();
    const a = await workbench.createFeedback(item);
    const b = await workbench.createFeedback({ ...item, targetId: 'date' });
    expect((await workbench.listFeedback('letter')).map((f) => f.id)).toEqual([b.id, a.id]);
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'revise',
      briefVersion: null,
      feedbackIds: [a.id],
    });
    await workbench.resolveFeedback('letter', [a.id], job.id);
    expect((await workbench.listFeedback('letter')).find((f) => f.id === a.id)?.resolvedBy).toBe(
      job.id,
    );
    expect(await workbench.deleteFeedback('letter', a.id)).toBe('resolved');
    expect(await workbench.deleteFeedback('letter', b.id)).toBe('deleted');
    expect(await workbench.deleteFeedback('letter', b.id)).toBe('not-found');
    expect(await workbench.deleteFeedback('other', a.id)).toBe('not-found');
  });

  it('records the feedback a proposal was made from', async () => {
    const { workbench, repo } = await setup();
    const job = await repo.createDraftJob('letter', {});
    const p = await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'revise',
      briefVersion: null,
      feedbackIds: ['00000000-0000-4000-8000-000000000001'],
    });
    expect(p.feedbackIds).toEqual(['00000000-0000-4000-8000-000000000001']);
    const q = await workbench.createProposal({
      id: (await repo.createDraftJob('letter', {})).id,
      projectId: 'letter',
      stage: 'outputs',
      briefVersion: null,
    });
    expect(q.feedbackIds).toBeNull();
  });
});
