import type { SinkView } from '@ih/bridge-contract';
import {
  BatchDetailSchema,
  BatchSchema,
  BatchSummarySchema,
  ConversionTargetSchema,
  DecomposeParamsSchema,
  DOCX_MIME,
  ItemSchema,
} from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../src/repositories/memory.js';
import { conversionsContract } from './conversions-contract.js';
import { docx, para } from './docx-fixtures.js';
import { FAKE_SINK } from './fake-sink.js';
import { accessApp, fakePdf, multipart, signInNewUser, testApp } from './helpers.js';

conversionsContract('memory', async () => {
  const repo = new MemoryRepo();
  return {
    repo,
    facts: {
      job: async (id) => {
        const j = repo.backgroundJobs.find((b) => b.id === id);
        return j
          ? {
              task: j.task,
              priority: j.priority,
              maxAttempts: j.maxAttempts,
              params: j.params,
              createdBy: j.createdBy,
            }
          : null;
      },
    },
  };
});

/** A sink that takes decomposed documents (contract version 2). */
const DOC_SINK: SinkView = {
  ...FAKE_SINK,
  id: 'docs',
  name: 'Document sink',
  contractVersion: 2,
  capabilities: {
    ...FAKE_SINK.capabilities,
    readBack: true,
    accepts: ['document', 'images'],
    decomposedDocuments: { equations: ['mathml'] },
  },
};

type Ctx = Awaited<ReturnType<typeof testApp>>;

/** `manuals` takes documents (the document sink); `reports` (the fake sink) does not. */
async function withTargets<C extends Ctx>(c: C, cookie?: string): Promise<C> {
  c.bridge.sinkViews = [FAKE_SINK, DOC_SINK];
  for (const [label, sinkId] of [
    ['Manuals', 'docs'],
    ['Reports', 'fake'],
  ] as const) {
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      headers: cookie ? { cookie } : {},
      payload: {
        kind: 'sink',
        label,
        sinkId,
        destination: { space: 'lib', name: '{source.stem}' },
      },
    });
    if (res.statusCode !== 201) throw new Error(`target ${label}: ${res.body}`);
  }
  return c;
}

const setup = async () => withTargets(await testApp());

type App = Ctx['app'];

async function newBatch(app: App, body: object = { targetId: 'manuals' }, cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversions/batches',
    headers: cookie ? { cookie } : {},
    payload: body,
  });
}

async function upload(
  app: App,
  batchId: string,
  sourceKey: string,
  content: Buffer = docx(),
  cookie?: string,
) {
  const form = multipart(
    { sourceKey },
    { filename: sourceKey.split('/').pop()!, content, contentType: DOCX_MIME },
  );
  return app.inject({
    method: 'POST',
    url: `/api/conversions/batches/${batchId}/items`,
    ...form,
    headers: { ...form.headers, ...(cookie ? { cookie } : {}) },
  });
}

const start = (app: App, batchId: string, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/conversions/batches/${batchId}/start`,
    headers: cookie ? { cookie } : {},
  });

describe('conversion batches', () => {
  it('creates a batch for a target that takes documents', async () => {
    const { app } = await setup();
    const res = await newBatch(app, { targetId: 'manuals', force: true });
    expect(res.statusCode).toBe(201);
    const batch = BatchSchema.parse(res.json());
    expect(batch).toMatchObject({
      targetId: 'manuals',
      force: true,
      state: 'open',
      startedAt: null,
      createdBy: { id: null, name: null },
    });
    const plain = BatchSchema.parse((await newBatch(app)).json());
    expect(plain.force).toBe(false);
  });

  it('refuses a target whose sink takes no documents', async () => {
    const { app } = await setup();
    for (const targetId of ['reports', 'nowhere']) {
      const res = await newBatch(app, { targetId });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'target_takes_no_documents' });
    }
    expect((await newBatch(app, { target: 'manuals' })).statusCode).toBe(400);
  });

  it('uploads an item under its source key', async () => {
    const c = await setup();
    const batch = BatchSchema.parse((await newBatch(c.app)).json());
    const body = docx({ body: para('Chapter 1') });
    const res = await upload(c.app, batch.id, 'Manuals/Pumps/intro.docx', body);
    expect(res.statusCode).toBe(201);
    const item = ItemSchema.parse(res.json());
    expect(item).toMatchObject({
      batchId: batch.id,
      sourceKey: 'Manuals/Pumps/intro.docx',
      filename: 'intro.docx',
      sizeBytes: body.length,
      objectKey: `decompositions/${batch.id}/${item.id}.docx`,
      jobId: null,
      outcome: 'queued',
    });
    expect(item.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = c.store.objects.get(`runs/${item.objectKey}`);
    expect(stored?.body.equals(body)).toBe(true);
    expect(stored?.contentType).toBe(DOCX_MIME);

    const missingKey = multipart({}, { filename: 'a.docx', content: docx() });
    const noKey = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/batches/${batch.id}/items`,
      ...missingKey,
    });
    expect(noKey.statusCode).toBe(400);
    const unknown = await upload(c.app, '00000000-0000-4000-8000-000000000000', 'a.docx');
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses a repeated source key in one batch', async () => {
    const c = await setup();
    const batch = BatchSchema.parse((await newBatch(c.app)).json());
    expect((await upload(c.app, batch.id, 'a.docx')).statusCode).toBe(201);
    const again = await upload(c.app, batch.id, 'a.docx', docx({ body: para('other') }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already/);
    // Only the first file is kept.
    const kept = [...c.store.objects.keys()].filter((k) => k.startsWith('runs/decompositions/'));
    expect(kept).toHaveLength(1);
  });

  it('refuses an unreadable file per item, not the batch', async () => {
    const c = await setup();
    const batch = BatchSchema.parse((await newBatch(c.app)).json());
    const oldWord = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const corrupt = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(40, 7)]);
    for (const [key, content] of [
      ['old.doc', oldWord],
      ['corrupt.docx', corrupt],
      ['report.pdf', fakePdf],
    ] as const) {
      const res = await upload(c.app, batch.id, key, content);
      expect(res.statusCode, key).toBe(415);
      expect(res.json().error).toMatch(/Word document \(\.docx\)/);
    }
    const tracked = docx({ body: '<w:p><w:ins w:id="1"><w:r><w:t>new</w:t></w:r></w:ins></w:p>' });
    expect((await upload(c.app, batch.id, 'tracked.docx', tracked)).statusCode).toBe(422);

    expect((await upload(c.app, batch.id, 'good.docx')).statusCode).toBe(201);
    const detail = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${batch.id}`)).json(),
    );
    expect(detail.batch.state).toBe('open');
    expect(detail.items.map((i) => i.sourceKey)).toEqual(['good.docx']);
    expect([...c.store.objects.keys()].filter((k) => k.startsWith('runs/'))).toHaveLength(1);
  });

  it('a batch with no items cannot start', async () => {
    const c = await setup();
    const batch = BatchSchema.parse((await newBatch(c.app)).json());
    const res = await start(c.app, batch.id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'empty_batch' });
    expect(c.repo.backgroundJobs).toEqual([]);

    // Discarded instead: nothing was queued, its objects go.
    await upload(c.app, batch.id, 'a.docx');
    const discard = await c.app.inject({
      method: 'DELETE',
      url: `/api/conversions/batches/${batch.id}`,
    });
    expect(discard.statusCode).toBe(204);
    expect([...c.store.objects.keys()].filter((k) => k.startsWith('runs/'))).toEqual([]);
    expect((await start(c.app, batch.id)).statusCode).toBe(409);
    expect((await upload(c.app, batch.id, 'b.docx')).statusCode).toBe(409);
    expect(
      (await c.app.inject({ method: 'DELETE', url: `/api/conversions/batches/${batch.id}` }))
        .statusCode,
    ).toBe(409);
  });

  it('start queues one decompose job per item with its params', async () => {
    const c = await setup();
    const batch = BatchSchema.parse(
      (await newBatch(c.app, { targetId: 'manuals', force: true })).json(),
    );
    const a = ItemSchema.parse((await upload(c.app, batch.id, 'f/a.docx')).json());
    const b = ItemSchema.parse((await upload(c.app, batch.id, 'f/b.docx')).json());

    const res = await start(c.app, batch.id);
    expect(res.statusCode).toBe(200);
    expect(BatchSchema.parse(res.json())).toMatchObject({ id: batch.id, state: 'started' });

    const jobs = c.repo.backgroundJobs.filter((j) => j.task === 'decompose');
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => DecomposeParamsSchema.parse(j.params))).toEqual([
      { batchId: batch.id, itemId: a.id, targetId: 'manuals', sourceKey: 'f/a.docx', force: true },
      { batchId: batch.id, itemId: b.id, targetId: 'manuals', sourceKey: 'f/b.docx', force: true },
    ]);
    expect(jobs.map((j) => [j.priority, j.status])).toEqual([
      [0, 'queued'],
      [0, 'queued'],
    ]);
    const detail = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${batch.id}`)).json(),
    );
    expect(detail.items.map((i) => i.jobId)).toEqual(jobs.map((j) => j.id));

    // Started once; the Jobs list (document jobs) is not cluttered by them.
    expect((await start(c.app, batch.id)).statusCode).toBe(409);
    expect((await c.app.inject('/api/jobs')).json()).toEqual([]);
    expect((await upload(c.app, batch.id, 'f/c.docx')).statusCode).toBe(409);
  });

  it('operators may convert', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    for (const role of ['operator', 'designer'] as const) {
      const { cookie } = await signInNewUser(c.app, c.access, `Olu ${role}`, role);
      const targets = await c.app.inject({
        url: '/api/conversions/targets',
        headers: { cookie },
      });
      expect(targets.statusCode, role).toBe(200);
      const created = await newBatch(c.app, { targetId: 'manuals' }, cookie);
      expect(created.statusCode, role).toBe(201);
      const batch = BatchSchema.parse(created.json());
      expect(batch.createdBy.name).toBe(`Olu ${role}`);
      expect(batch.createdBy.id).not.toBeNull();
      const item = ItemSchema.parse(
        (await upload(c.app, batch.id, 'a.docx', docx(), cookie)).json(),
      );
      expect((await start(c.app, batch.id, cookie)).statusCode, role).toBe(200);
      const get = (url: string) => c.app.inject({ url, headers: { cookie } });
      expect((await get('/api/conversions/batches')).statusCode).toBe(200);
      expect((await get(`/api/conversions/batches/${batch.id}`)).statusCode).toBe(200);
      expect((await get(`/api/conversions/items/${item.id}/report`)).statusCode).toBe(404);
      const job = c.repo.backgroundJobs.find(
        (j) => (j.params as { itemId?: string }).itemId === item.id,
      );
      expect(job?.createdBy).toBe(`Olu ${role}`);

      const open = BatchSchema.parse(
        (await newBatch(c.app, { targetId: 'manuals' }, cookie)).json(),
      );
      const discard = await c.app.inject({
        method: 'DELETE',
        url: `/api/conversions/batches/${open.id}`,
        headers: { cookie },
      });
      expect(discard.statusCode, role).toBe(204);
    }
  });

  it('targets lists only those that take documents', async () => {
    const c = await setup();
    const res = await c.app.inject('/api/conversions/targets');
    expect(res.statusCode).toBe(200);
    const targets = res.json().targets.map((t: unknown) => ConversionTargetSchema.parse(t));
    expect(targets).toEqual([{ id: 'manuals', label: 'Manuals', sinkName: 'Document sink' }]);
  });

  it('lists batches newest first with outcome counts', async () => {
    const c = await setup();
    const first = BatchSchema.parse((await newBatch(c.app)).json());
    const a = ItemSchema.parse((await upload(c.app, first.id, 'a.docx')).json());
    await upload(c.app, first.id, 'b.docx');
    await start(c.app, first.id);
    c.repo.conversionItems.get(a.id)!.outcome = 'created';
    const second = BatchSchema.parse((await newBatch(c.app)).json());

    const res = await c.app.inject('/api/conversions/batches');
    expect(res.statusCode).toBe(200);
    const batches = res.json().batches.map((b: unknown) => BatchSummarySchema.parse(b));
    expect(batches.map((b: { id: string }) => b.id)).toEqual([second.id, first.id]);
    expect(batches[1]).toMatchObject({ state: 'started', itemCount: 2 });
    expect(batches[1].counts).toMatchObject({ queued: 1, created: 1, failed: 0 });
    expect(batches[0]).toMatchObject({ state: 'open', itemCount: 0 });
    expect(
      (await c.app.inject('/api/conversions/batches/00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
  });

  it("serves an item's report", async () => {
    const c = await setup();
    const batch = BatchSchema.parse((await newBatch(c.app)).json());
    const item = ItemSchema.parse((await upload(c.app, batch.id, 'a.docx')).json());
    const url = `/api/conversions/items/${item.id}/report`;
    // Not written yet (the worker writes it once it decomposes the file).
    expect((await c.app.inject(url)).statusCode).toBe(404);

    const key = `decompositions/${batch.id}/${item.id}.report.json`;
    const report = { flags: [{ check: 'equations', count: 2 }] };
    await c.store.put('runs', key, Buffer.from(JSON.stringify(report)), 'application/json');
    c.repo.conversionItems.get(item.id)!.reportKey = key;
    const res = await c.app.inject(url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(report);

    expect(
      (await c.app.inject('/api/conversions/items/00000000-0000-4000-8000-000000000000/report'))
        .statusCode,
    ).toBe(404);
  });
});
