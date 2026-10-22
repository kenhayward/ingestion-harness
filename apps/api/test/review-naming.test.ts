import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';
import { FAKE_SINK } from './fake-sink.js';

const SHA = 'a'.repeat(64);

/** A job of the recipe `letter` (to `default` and the fake sink's target) awaiting review. */
async function seed(settings?: Record<string, Record<string, string>>) {
  const ctx = await testApp();
  ctx.bridge.sinkViews = [FAKE_SINK];
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/publish-targets',
    payload: {
      kind: 'sink',
      label: 'Fake target',
      sinkId: 'fake',
      destination: { space: 'reports', name: '{field:sender|source.stem}' },
    },
  });
  expect(created.statusCode).toBe(201);
  await ctx.templates.create(
    'letter',
    1,
    {
      id: 'letter',
      version: 1,
      name: 'Letter',
      document: { sections: [{ id: 'all', anchor: '\\A' }] },
      outputs: { fields: [{ id: 'sender', type: 'text' }] },
      pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
      delivery: { publishTo: ['default', 'fake-target'], ...(settings ? { settings } : {}) },
    },
    'draft',
  );
  await ctx.templates.publish('letter', 1, 'Ken');
  const documentId = randomUUID();
  const job = await ctx.repo.createDocumentAndJob(
    {
      id: documentId,
      filename: 'Q3 letter.pdf',
      sha256: SHA,
      sizeBytes: 1,
      specId: 'letter',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: `letter/v1/${documentId}.pdf`,
    },
    null,
  );
  const key = `letter/v1/document/${documentId}.json`;
  await ctx.store.put(
    'outputs',
    key,
    Buffer.from(
      JSON.stringify({
        document_id: documentId,
        source_sha256: SHA,
        fields: { sender: { value: 'Acme Ltd', page: 1 } },
        tables: {},
        checks: {},
        issues: [],
      }),
    ),
    'application/json',
  );
  ctx.repo.outputs.set(job.id, [
    {
      outputId: 'document',
      stage: 'draft',
      format: 'json',
      bucket: 'outputs',
      key,
      rowCount: null,
      targetId: null,
    },
  ]);
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'awaiting_review' });
  return { ...ctx, job };
}

describe('GET /api/jobs/:id/naming', () => {
  it("lists each target's overridable name fields, resolved against the draft", async () => {
    const { app, job } = await seed();
    const res = await app.inject(`/api/jobs/${job.id}/naming`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      targets: [
        {
          targetId: 'fake-target',
          label: 'Fake target',
          fields: [
            {
              id: 'name',
              label: 'Name',
              pattern: '{field:sender|source.stem}',
              value: 'Acme Ltd',
              unresolved: [],
              override: null,
              conflict: null,
            },
          ],
        },
      ],
    });
  });

  it("the recipe's pattern wins over the target's, and an unresolved one says what is missing", async () => {
    const { app, job } = await seed({ 'fake-target': { name: '{field:sender} {field:ref}' } });
    const [target] = (await app.inject(`/api/jobs/${job.id}/naming`)).json().targets;
    expect(target.fields[0]).toMatchObject({
      pattern: '{field:sender} {field:ref}',
      value: null,
      unresolved: ['field:ref'],
    });
  });
});

describe('POST /api/jobs/:id/approve with name overrides', () => {
  it('stores them; the naming shows them; a re-approve replaces them', async () => {
    const { app, repo, job } = await seed();
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve`,
      payload: { overrides: { 'fake-target': { name: 'Acme letter Q3' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(await repo.deliveryOverrides(job.id)).toEqual({
      'fake-target': { name: 'Acme letter Q3' },
    });
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const [target] = (await app.inject(`/api/jobs/${job.id}/naming`)).json().targets;
    expect(target.fields[0].override).toBe('Acme letter Q3');
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/approve`, payload: {} });
    expect(await repo.deliveryOverrides(job.id)).toEqual({});
  });

  it('refuses an override of a fixed field, of a target not in the recipe, or an empty one', async () => {
    const cases: [object, string][] = [
      [{ 'fake-target': { space: 'x' } }, 'fake-target: space is not a name a reviewer can change'],
      [{ default: { name: 'x' } }, 'default: no name a reviewer can change'],
      [{ 'fake-target': { name: ' ' } }, 'fake-target: name is empty'],
    ];
    for (const [overrides, error] of cases) {
      const { app, repo, job } = await seed();
      const res = await app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/approve`,
        payload: { overrides },
      });
      expect([res.statusCode, res.json()]).toEqual([400, { error }]);
      expect(repo.jobs.get(job.id)!.status).toBe('awaiting_review');
    }
  });
});

describe('a name the target refused (name_conflict)', () => {
  async function refused() {
    const ctx = await seed();
    const deliveryId = randomUUID();
    await ctx.repo.recordDeliveries(ctx.job.id, [{ targetId: 'fake-target', deliveryId }]);
    const d = ctx.repo.deliveries.get(deliveryId)!;
    ctx.repo.deliveries.set(deliveryId, {
      ...d,
      status: 'needs_user',
      error: {
        class: 'needs_user',
        code: 'name_conflict',
        message: 'another document is named Acme Ltd',
        details: { field: 'name', value: 'Acme Ltd' },
      },
    });
    return ctx;
  }

  it('marks the field, naming the name', async () => {
    const { app, job } = await refused();
    const [target] = (await app.inject(`/api/jobs/${job.id}/naming`)).json().targets;
    expect(target.fields[0].conflict).toBe(
      'Fake target already has another document named Acme Ltd: choose another name',
    );
  });

  it('clears once a later delivery of that target succeeds', async () => {
    const { app, repo, job } = await refused();
    await repo.recordDeliveries(job.id, [{ targetId: 'fake-target', deliveryId: randomUUID() }]);
    const [target] = (await app.inject(`/api/jobs/${job.id}/naming`)).json().targets;
    expect(target.fields[0].conflict).toBeNull();
  });
});

describe('approving records who approved, by id', () => {
  it('stores the signed-in user as the reviewer', async () => {
    const { app, repo, job } = await seed();
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/approve`, payload: {} });
    expect(repo.reviewerIds.get(job.id)).toBe('unit-test-admin');
  });
});
