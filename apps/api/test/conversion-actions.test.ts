import { createHash, randomUUID } from 'node:crypto';
import {
  bridgeError,
  changedInTargetDetails,
  documentMissing,
  type BridgeError,
  type BridgeEvent,
  type ComponentVersion,
  type Receipt,
} from '@ih/bridge-contract';
import {
  AcceptedTargetStateSchema,
  AcceptPreviewSchema,
  BatchDetailSchema,
  BatchSchema,
  decompositionSourceKey,
  DecomposeParamsSchema,
  DOCX_MIME,
  ItemSchema,
  type Item,
} from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { applyRegisterEvent } from '../src/bridge/register.js';
import type { RegisterEntry } from '../src/repositories/types.js';
import { docx, para } from './docx-fixtures.js';
import { FAKE_DOCUMENT_SINK, FAKE_SINK } from './fake-sink.js';
import { accessApp, multipart, signInNewUser, testApp } from './helpers.js';
import { takeViolations } from './openapi-conformance.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;
type App = Ctx['app'];

/** `manuals` takes documents (the document sink). */
async function withTargets<C extends Ctx>(c: C, cookie?: string): Promise<C> {
  c.bridge.sinkViews = [FAKE_SINK, FAKE_DOCUMENT_SINK];
  const res = await c.app.inject({
    method: 'POST',
    url: '/api/publish-targets',
    headers: cookie ? { cookie } : {},
    payload: {
      kind: 'sink',
      label: 'Manuals',
      sinkId: 'docs',
      destination: { space: 'lib', name: '{source.stem}' },
    },
  });
  if (res.statusCode !== 201) throw new Error(`target: ${res.body}`);
  return c;
}

const setup = async () => withTargets(await testApp());
const headers = (cookie?: string) => (cookie ? { cookie } : {});

/** A started batch of one uploaded item, as the Conversion tab makes it. */
async function startedItem(
  c: Ctx,
  sourceKey = 'manuals/pumps.docx',
  content: Buffer = docx({ body: para('Pumps') }),
  cookie?: string,
): Promise<Item> {
  const batch = BatchSchema.parse(
    (
      await c.app.inject({
        method: 'POST',
        url: '/api/conversions/batches',
        headers: headers(cookie),
        payload: { targetId: 'manuals' },
      })
    ).json(),
  );
  const form = multipart(
    { sourceKey },
    { filename: sourceKey.split('/').pop()!, content, contentType: DOCX_MIME },
  );
  const uploaded = await c.app.inject({
    method: 'POST',
    url: `/api/conversions/batches/${batch.id}/items`,
    ...form,
    headers: { ...form.headers, ...headers(cookie) },
  });
  const item = ItemSchema.parse(uploaded.json());
  const started = await c.app.inject({
    method: 'POST',
    url: `/api/conversions/batches/${batch.id}/start`,
    headers: headers(cookie),
  });
  if (started.statusCode !== 200) throw new Error(`start: ${started.body}`);
  return item;
}

const COMPONENTS: ComponentVersion[] = [
  { kind: 'map', id: 'doc-1/map', version: '1', element: null },
  { kind: 'section', id: 'doc-1/section/s1', version: '1', element: 's1' },
  { kind: 'section', id: 'doc-1/section/s2', version: '1', element: 's2' },
];

const receiptOf = (components: ComponentVersion[], persistentId = 'doc-1'): Receipt => ({
  written: [{ kind: 'document', id: persistentId, label: null, url: null }],
  document: { persistentId, components, readBack: { ok: true, at: null, detail: null } },
});

/**
 * The item's outcome decided and its register entry in `state` (document doc-1 delivered with
 * COMPONENTS), as the worker and the bridge's events leave them.
 */
function settle(
  c: Ctx,
  item: Item,
  outcome: Item['outcome'],
  entry: Partial<RegisterEntry> & { state: RegisterEntry['state'] },
): RegisterEntry {
  const put = c.repo.putRegisterEntry({
    sinkId: 'docs',
    instanceId: null,
    sourceKey: item.sourceKey,
    contentSha256: item.contentSha256,
    persistentId: 'doc-1',
    idempotencyKey: 'k'.repeat(64),
    deliveryId: randomUUID(),
    batchId: item.batchId,
  });
  const row = c.repo.register.get(put.id)!;
  Object.assign(row, { lastReceipt: receiptOf(COMPONENTS), ...entry });
  Object.assign(c.repo.conversionItems.get(item.id)!, { outcome, registerEntryId: row.id });
  return row;
}

const refusal = (changed: Array<{ id: string; expected: string; actual: string | null }>) =>
  bridgeError(
    'changed_in_target',
    `${changed.length} component(s) of doc-1 changed in the target`,
    changedInTargetDetails(changed),
  );

/** The item's entry refused as changed in the target again (after an accept, say). */
function refusedAgain(c: Ctx, item: Item): void {
  const entryId = c.repo.conversionItems.get(item.id)!.registerEntryId!;
  Object.assign(c.repo.register.get(entryId)!, {
    state: 'changed',
    lastError: refusal([{ id: 'doc-1/section/s1', expected: '2', actual: '3' }]),
  });
}

/** The entry refused as changed in the target, listing `changed`. */
const changedEntry = (
  c: Ctx,
  item: Item,
  changed: Array<{ id: string; expected: string; actual: string | null }>,
) => settle(c, item, 'changed_in_target', { state: 'changed', lastError: refusal(changed) });

const post = (app: App, url: string, payload?: object, cookie?: string) =>
  app.inject({ method: 'POST', url, headers: headers(cookie), ...(payload ? { payload } : {}) });

/** The preview, then the confirm with the `seen` it returned: what the Conversion tab does. */
async function confirmAccept(c: Ctx, item: Item, cookie?: string) {
  const preview = AcceptPreviewSchema.parse(
    (
      await c.app.inject({
        url: `/api/conversions/items/${item.id}/accept`,
        headers: headers(cookie),
      })
    ).json(),
  );
  return post(
    c.app,
    `/api/conversions/items/${item.id}/accept`,
    { confirm: true, seen: preview.updatedAt },
    cookie,
  );
}

const jobOf = (c: Ctx, item: Item) =>
  c.repo.backgroundJobs.find((j) => (j.params as { itemId?: string }).itemId === item.id);

/** A body with a tracked insertion, which the API refuses. */
const TRACKED_BODY = '<w:p><w:ins w:id="1"><w:r><w:t>new</w:t></w:r></w:ins></w:p>';

const runsObjects = (c: Ctx) => [...c.store.objects.keys()].filter((k) => k.startsWith('runs/'));

describe('force-load', () => {
  it('force-load turns already loaded into an update', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'already_loaded', { state: 'delivered' });
    const objects = runsObjects(c);

    const res = await post(c.app, `/api/conversions/items/${item.id}/force`);

    expect(res.statusCode).toBe(201);
    const { batch, items } = BatchDetailSchema.parse(res.json());
    expect(batch).toMatchObject({ targetId: 'manuals', force: true, state: 'started' });
    expect(batch.id).not.toBe(item.batchId);
    const [rerun] = items as [Item];
    expect(rerun).toMatchObject({
      sourceKey: item.sourceKey,
      filename: item.filename,
      contentSha256: item.contentSha256,
      sizeBytes: item.sizeBytes,
      // The stored source is reused: nothing new is uploaded.
      objectKey: item.objectKey,
      redeliverOf: item.id,
      outcome: 'queued',
      registerEntryId: null,
    });
    expect(runsObjects(c)).toEqual(objects);
    // The batch starts at once: its job is queued, forced (the worker makes it an update).
    const job = jobOf(c, rerun)!;
    expect(rerun.jobId).toBe(job.id);
    expect(DecomposeParamsSchema.parse(job.params)).toEqual({
      batchId: batch.id,
      itemId: rerun.id,
      targetId: 'manuals',
      sourceKey: item.sourceKey,
      force: true,
    });
    const detail = await c.app.inject(`/api/conversions/batches/${batch.id}`);
    expect(BatchDetailSchema.parse(detail.json()).items).toEqual([rerun]);
  });

  it('force-load turns a duplicate into a create', async () => {
    const c = await setup();
    const item = await startedItem(c, 'copies/pumps-copy.docx');
    // A duplicate names another source's document and is linked to no entry of its own.
    Object.assign(c.repo.conversionItems.get(item.id)!, {
      outcome: 'duplicate',
      detail: 'the same file is already document doc-1, from manuals/pumps.docx',
    });

    const res = await post(c.app, `/api/conversions/items/${item.id}/force`);

    expect(res.statusCode).toBe(201);
    const { batch, items } = BatchDetailSchema.parse(res.json());
    expect(batch.force).toBe(true);
    expect(items[0]).toMatchObject({ sourceKey: item.sourceKey, objectKey: item.objectKey });
    expect((jobOf(c, items[0]!)!.params as { force: boolean }).force).toBe(true);
  });

  it('a second force-load while the first is unfinished is refused', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'already_loaded', { state: 'delivered' });

    const first = await post(c.app, `/api/conversions/items/${item.id}/force`);
    const second = await post(c.app, `/api/conversions/items/${item.id}/force`);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'not_finished' });
    expect(c.repo.conversionBatches.size).toBe(2); // the original and one rerun
    expect(c.repo.backgroundJobs.filter((j) => j.task === 'decompose')).toHaveLength(2);
    // Once the rerun has an outcome, the row may be rerun again.
    const [rerun] = BatchDetailSchema.parse(first.json()).items as [Item];
    c.repo.conversionItems.get(rerun.id)!.outcome = 'updated';
    expect((await post(c.app, `/api/conversions/items/${item.id}/force`)).statusCode).toBe(201);
  });

  it('refuses an item still running, or one not found', async () => {
    const c = await setup();
    const item = await startedItem(c);
    for (const outcome of ['queued', 'decomposing', 'delivering'] as const) {
      c.repo.conversionItems.get(item.id)!.outcome = outcome;
      const res = await post(c.app, `/api/conversions/items/${item.id}/force`);
      expect(res.statusCode, outcome).toBe(409);
      expect(res.json()).toMatchObject({ code: 'not_finished' });
    }
    expect((await post(c.app, `/api/conversions/items/${randomUUID()}/force`)).statusCode).toBe(
      404,
    );
    expect((await post(c.app, '/api/conversions/items/nope/force')).statusCode).toBe(404);
    expect(c.repo.conversionBatches.size).toBe(1);
  });
});

describe('redeliver', () => {
  const redeliver = (c: Ctx, item: Item, content?: Buffer, cookie?: string) => {
    if (!content) return post(c.app, `/api/conversions/items/${item.id}/redeliver`, undefined);
    const form = multipart({}, { filename: 'renamed.docx', content, contentType: DOCX_MIME });
    return c.app.inject({
      method: 'POST',
      url: `/api/conversions/items/${item.id}/redeliver`,
      ...form,
      headers: { ...form.headers, ...headers(cookie) },
    });
  };

  it('redeliver with a replacement file keeps the source key', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'created', { state: 'delivered' });
    const replacement = docx({ body: para('Pumps, revised') });

    const res = await redeliver(c, item, replacement);

    expect(res.statusCode).toBe(201);
    const { batch, items } = BatchDetailSchema.parse(res.json());
    const [rerun] = items as [Item];
    expect(batch).toMatchObject({ force: true, state: 'started', targetId: 'manuals' });
    expect(rerun).toMatchObject({
      sourceKey: item.sourceKey, // the same document is updated
      filename: 'renamed.docx',
      contentSha256: createHash('sha256').update(replacement).digest('hex'),
      sizeBytes: replacement.length,
      objectKey: decompositionSourceKey(batch.id, rerun.id, 'docx'),
      redeliverOf: item.id,
    });
    expect(await c.store.get('runs', rerun.objectKey)).toEqual(replacement);
    // The original's file stays: its row still has a report and a source.
    expect(await c.store.get('runs', item.objectKey)).not.toBeNull();
    expect(jobOf(c, rerun)!.params).toMatchObject({ sourceKey: item.sourceKey, force: true });
  });

  it('redelivers the stored file when no replacement is sent', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'changed_in_target', { state: 'changed' });

    const res = await redeliver(c, item);

    expect(res.statusCode).toBe(201);
    const [rerun] = BatchDetailSchema.parse(res.json()).items as [Item];
    expect(rerun).toMatchObject({ objectKey: item.objectKey, sourceKey: item.sourceKey });
  });

  it('a second redeliver with a replacement stores nothing more', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'created', { state: 'delivered' });
    const objects = runsObjects(c);
    const replacement = docx({ body: para('Pumps, revised') });

    const first = await redeliver(c, item, replacement);
    const second = await redeliver(c, item, replacement);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'not_finished' });
    const [rerun] = BatchDetailSchema.parse(first.json()).items as [Item];
    expect(runsObjects(c)).toEqual([...objects, `runs/${rerun.objectKey}`]);
    expect(c.repo.conversionBatches.size).toBe(2);
    expect(c.repo.backgroundJobs.filter((j) => j.task === 'decompose')).toHaveLength(2);
  });

  it('checks a replacement as an upload is checked', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'created', { state: 'delivered' });
    const objects = runsObjects(c);
    const send = (filename: string, content: Buffer) => {
      const form = multipart({}, { filename, content, contentType: DOCX_MIME });
      return c.app.inject({
        method: 'POST',
        url: `/api/conversions/items/${item.id}/redeliver`,
        ...form,
      });
    };

    const badName = await send('bad\u0007name.docx', docx());
    expect(badName.statusCode).toBe(422);
    expect(badName.json()).toMatchObject({ code: 'bad_filename' });
    const tracked = await send('tracked.docx', docx({ body: TRACKED_BODY }));
    expect(tracked.statusCode).toBe(422);
    expect(tracked.json().error).toMatch(/tracked changes/);
    const tooLarge = await send('big.docx', Buffer.alloc(1024 * 1024 + 1));
    expect(tooLarge.statusCode).toBe(413);
    expect(runsObjects(c)).toEqual(objects);
    expect(c.repo.conversionBatches.size).toBe(1);
  });

  it('leaves no replacement behind when the batch cannot be written', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'created', { state: 'delivered' });
    const objects = runsObjects(c);
    c.repo.rerunItem = async () => {
      throw new Error('database down');
    };

    const res = await redeliver(c, item, docx({ body: para('Pumps, revised') }));

    expect(res.statusCode).toBe(500);
    expect(takeViolations()).toEqual([expect.stringContaining('500')]);
    expect(runsObjects(c)).toEqual(objects);
  });

  it('needs a register entry, and a Word file as the replacement', async () => {
    const c = await setup();
    const item = await startedItem(c);
    c.repo.conversionItems.get(item.id)!.outcome = 'failed';
    const none = await redeliver(c, item);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'no_register_entry' });

    settle(c, item, 'created', { state: 'delivered' });
    const objects = runsObjects(c);
    const notWord = await redeliver(c, item, Buffer.from('%PDF-1.7 not a word file'));
    expect(notWord.statusCode).toBe(415);
    expect(runsObjects(c)).toEqual(objects);
    expect(c.repo.conversionBatches.size).toBe(1);
  });
});

describe('detach', () => {
  it('detach forgets the entry and records who', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const { cookie, user } = await signInNewUser(c.app, c.access, 'Olu', 'operator');
    const item = await startedItem(c, 'manuals/pumps.docx', docx(), cookie);
    const entry = changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);

    const res = await post(c.app, `/api/conversions/items/${item.id}/detach`, undefined, cookie);

    expect(res.statusCode).toBe(200);
    const detached = ItemSchema.parse(res.json());
    expect(detached.detail).toMatch(/detached/);
    expect(detached.detail).toContain('doc-1');
    // A tombstone naming the action: the register's checks treat it as absent, and the next
    // create of the source takes the action's id into its key (worker `deliver.py`).
    const [action] = c.repo.registerActions;
    expect(c.repo.register.get(entry.id)).toMatchObject({
      state: 'detached',
      detachActionId: action!.id,
    });
    expect(c.repo.registerActions).toEqual([
      {
        id: expect.any(String),
        entryId: entry.id,
        action: 'detach',
        by: { id: user.id, name: 'Olu' },
        at: expect.any(String),
        details: { persistentId: 'doc-1', sourceKey: item.sourceKey },
      },
    ]);
    // Forgotten once: there is nothing left to detach.
    const again = await post(c.app, `/api/conversions/items/${item.id}/detach`, undefined, cookie);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'no_register_entry' });
  });

  it('items say how their entry was resolved, in every batch that holds them', async () => {
    const c = await setup();
    const first = await startedItem(c);
    const second = await startedItem(c); // the same source, run again in a batch of its own
    const entry = changedEntry(c, first, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    Object.assign(c.repo.conversionItems.get(second.id)!, {
      outcome: 'changed_in_target',
      registerEntryId: entry.id,
    });
    const resolutionIn = async (item: Item) => {
      const res = await c.app.inject({ url: `/api/conversions/batches/${item.batchId}` });
      return BatchDetailSchema.parse(res.json()).items[0]!.resolution;
    };
    expect(await resolutionIn(first)).toBeNull();

    const accepted = await confirmAccept(c, first);
    expect(AcceptedTargetStateSchema.parse(accepted.json()).item.resolution).toBe('accepted');
    expect([await resolutionIn(first), await resolutionIn(second)]).toEqual([
      'accepted',
      'accepted',
    ]);

    refusedAgain(c, first); // only a refused document is detached
    const res = await post(c.app, `/api/conversions/items/${second.id}/detach`);
    expect(ItemSchema.parse(res.json()).resolution).toBe('detached');
    expect([await resolutionIn(first), await resolutionIn(second)]).toEqual([
      'detached',
      'detached',
    ]);
    expect(takeViolations()).toEqual([]);
  });

  it('refuses while a delivery for the entry is in flight', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = settle(c, item, 'in_flight', { state: 'pending' });

    const res = await post(c.app, `/api/conversions/items/${item.id}/detach`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'in_flight' });
    expect(c.repo.register.get(entry.id)?.state).toBe('pending');
    expect(c.repo.registerActions).toEqual([]);
  });

  it('refuses while a rerun of the source is queued', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    expect((await post(c.app, `/api/conversions/items/${item.id}/redeliver`)).statusCode).toBe(201);

    const res = await post(c.app, `/api/conversions/items/${item.id}/detach`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'in_flight' });
    expect(c.repo.register.get(entry.id)?.state).toBe('changed');
  });

  it("refuses while the source is queued for any target on the entry's tenant", async () => {
    const c = await setup();
    // A second target on the same sink (one tenant), and one on another sink.
    const handbooks = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: { kind: 'sink', label: 'Handbooks', sinkId: 'docs', destination: { space: 'hb' } },
    });
    expect(handbooks.statusCode).toBe(201);
    const reports = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: {
        kind: 'sink',
        label: 'Reports',
        sinkId: 'fake',
        destination: { space: 'lib', name: '{source.stem}' },
      },
    });
    expect(reports.statusCode).toBe(201);
    const item = await startedItem(c);
    const entry = changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    /** The same source queued in a started batch for `targetId`. */
    const queue = async (targetId: string) => {
      const batch = await c.repo.createBatch({
        targetId,
        force: false,
        createdBy: { id: null, name: null },
      });
      const id = randomUUID();
      await c.repo.addItem({
        id,
        batchId: batch.id,
        sourceKey: item.sourceKey,
        filename: item.filename,
        contentSha256: item.contentSha256,
        sizeBytes: item.sizeBytes,
        objectKey: item.objectKey,
      });
      await c.repo.startBatch(batch.id, null);
      return id;
    };
    const detach = () => post(c.app, `/api/conversions/items/${item.id}/detach`);

    const elsewhere = await queue(reports.json().id);
    const onTenant = await queue(handbooks.json().id);
    const refused = await detach();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'in_flight' });

    // The run to the other tenant does not hold it off.
    c.repo.conversionItems.get(onTenant)!.outcome = 'created';
    expect(c.repo.conversionItems.get(elsewhere)!.outcome).toBe('queued');
    expect((await detach()).statusCode).toBe(200);
    expect(c.repo.register.get(entry.id)?.state).toBe('detached');
  });

  it('a detached entry has nothing to redeliver or accept', async () => {
    const c = await setup();
    const item = await startedItem(c);
    changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    expect((await post(c.app, `/api/conversions/items/${item.id}/detach`)).statusCode).toBe(200);

    const redelivered = await post(c.app, `/api/conversions/items/${item.id}/redeliver`);
    expect(redelivered.statusCode).toBe(409);
    expect(redelivered.json()).toMatchObject({ code: 'no_register_entry' });
    const preview = AcceptPreviewSchema.parse(
      (await c.app.inject(`/api/conversions/items/${item.id}/accept`)).json(),
    );
    expect(preview).toMatchObject({ acceptable: false, updatedAt: null });
  });

  it('detaches an unresolved document whose versions were never recorded', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = settle(c, item, 'unresolved', { state: 'incomplete', lastReceipt: null });
    const shown = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${item.batchId}`)).json(),
    ).items[0]!;
    expect(shown).toMatchObject({ outcome: 'unresolved', unversioned: true, resolution: null });

    const res = await post(c.app, `/api/conversions/items/${item.id}/detach`);

    expect(res.statusCode).toBe(200);
    expect(ItemSchema.parse(res.json())).toMatchObject({ resolution: 'detached' });
    expect(c.repo.register.get(entry.id)?.state).toBe('detached');
    expect(takeViolations()).toEqual([]);
  });

  it('an old row cannot detach a document a later run delivered', async () => {
    const c = await setup();
    const old = await startedItem(c);
    const entry = changedEntry(c, old, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    // A later batch accepts nothing: its run updates the document, and the entry is live again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await startedItem(c);
    Object.assign(entry, {
      state: 'delivered',
      batchId: later.batchId,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    Object.assign(c.repo.conversionItems.get(later.id)!, {
      outcome: 'updated',
      registerEntryId: entry.id,
    });
    const shown = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${old.batchId}`)).json(),
    ).items[0]!;
    expect(shown).toMatchObject({ outcome: 'changed_in_target', resolution: 'superseded' });

    const res = await post(c.app, `/api/conversions/items/${old.id}/detach`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_refused' });
    expect(c.repo.register.get(entry.id)?.state).toBe('delivered');
    expect(c.repo.registerActions).toEqual([]);
    expect(takeViolations()).toEqual([]);
  });
});

/** The item's update refused because the target no longer has its document (deleted there). */
const goneEntry = (c: Ctx, item: Item) =>
  settle(c, item, 'unresolved', {
    state: 'failed',
    lastError: documentMissing('doc-1', 'Repository lib has no map doc-1 for this update'),
  });

describe('a document gone from the target', () => {
  it('detach takes a gone document', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = goneEntry(c, item);
    const shown = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${item.batchId}`)).json(),
    ).items[0]!;
    expect(shown).toMatchObject({ outcome: 'unresolved', gone: true, resolution: null });

    const res = await post(c.app, `/api/conversions/items/${item.id}/detach`);

    expect(res.statusCode).toBe(200);
    expect(ItemSchema.parse(res.json())).toMatchObject({ resolution: 'detached', gone: false });
    expect(c.repo.register.get(entry.id)?.state).toBe('detached');
    expect(takeViolations()).toEqual([]);
  });

  it('reload detaches it and starts one batch that creates it again', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = goneEntry(c, item);

    const res = await post(c.app, `/api/conversions/items/${item.id}/reload`);

    expect(res.statusCode, res.body).toBe(201);
    const { batch, items } = BatchDetailSchema.parse(res.json());
    expect(batch).toMatchObject({ targetId: 'manuals', force: false, state: 'started' });
    const [rerun] = items as [Item];
    expect(rerun).toMatchObject({
      sourceKey: item.sourceKey,
      objectKey: item.objectKey,
      redeliverOf: item.id,
      outcome: 'queued',
    });
    // A plain create: after the detach, its key takes the detach's id, so a new document.
    expect(DecomposeParamsSchema.parse(jobOf(c, rerun)!.params)).toEqual({
      batchId: batch.id,
      itemId: rerun.id,
      targetId: 'manuals',
      sourceKey: item.sourceKey,
      force: false,
    });
    const [action] = c.repo.registerActions;
    expect(c.repo.registerActions).toEqual([
      {
        id: expect.any(String),
        entryId: entry.id,
        action: 'detach',
        by: { id: null, name: null },
        at: expect.any(String),
        details: { persistentId: 'doc-1', sourceKey: item.sourceKey, reason: 'gone' },
      },
    ]);
    expect(c.repo.register.get(entry.id)).toMatchObject({
      state: 'detached',
      detachActionId: action!.id,
    });
    expect(ItemSchema.parse((await c.repo.getItem(item.id))!)).toMatchObject({
      resolution: 'detached',
      gone: false,
    });
    expect(c.repo.conversionBatches.size).toBe(2);
    expect(c.repo.backgroundJobs.filter((j) => j.task === 'decompose')).toHaveLength(2);
    expect(takeViolations()).toEqual([]);
  });

  it('a double click makes one batch', async () => {
    const c = await setup();
    const item = await startedItem(c);
    goneEntry(c, item);

    const [first, second] = await Promise.all([
      post(c.app, `/api/conversions/items/${item.id}/reload`),
      post(c.app, `/api/conversions/items/${item.id}/reload`),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect([first, second].find((r) => r.statusCode === 409)!.json()).toMatchObject({
      code: 'not_finished',
    });
    expect(c.repo.conversionBatches.size).toBe(2);
    expect(c.repo.backgroundJobs.filter((j) => j.task === 'decompose')).toHaveLength(2);
    expect(c.repo.registerActions).toHaveLength(1);
    // While that rerun runs, every further click is refused.
    expect((await post(c.app, `/api/conversions/items/${item.id}/reload`)).statusCode).toBe(409);
  });

  it('reloads an item detached already, without detaching again', async () => {
    const c = await setup();
    const item = await startedItem(c);
    goneEntry(c, item);
    expect((await post(c.app, `/api/conversions/items/${item.id}/detach`)).statusCode).toBe(200);

    const res = await post(c.app, `/api/conversions/items/${item.id}/reload`);

    expect(res.statusCode).toBe(201);
    expect(BatchDetailSchema.parse(res.json()).batch.force).toBe(false);
    expect(c.repo.registerActions).toHaveLength(1);
  });

  it('refuses an old detached row once a later create replaced the tombstone', async () => {
    const c = await setup();
    const old = await startedItem(c);
    const tombstone = goneEntry(c, old);
    expect((await post(c.app, `/api/conversions/items/${old.id}/detach`)).statusCode).toBe(200);
    // A later run creates the source again: the worker replaces the tombstone with a new entry.
    c.repo.register.delete(tombstone.id);
    const later = await startedItem(c);
    settle(c, later, 'created', { state: 'delivered', persistentId: 'doc-2' });
    expect((await c.repo.getItem(old.id))?.resolution).toBe('detached');
    const batches = c.repo.conversionBatches.size;

    const res = await post(c.app, `/api/conversions/items/${old.id}/reload`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_gone' });
    expect(c.repo.conversionBatches.size).toBe(batches);
    expect(takeViolations()).toEqual([]);
  });

  it('refuses a superseded row, even when its entry is gone', async () => {
    const c = await setup();
    const old = await startedItem(c);
    // The row was refused as changed; a later run's update found the document gone.
    settle(c, old, 'changed_in_target', {
      state: 'failed',
      lastError: documentMissing('doc-1', 'Repository lib has no map doc-1 for this update'),
    });
    const shown = ItemSchema.parse(await c.repo.getItem(old.id));
    expect(shown).toMatchObject({ gone: true, resolution: 'superseded', reloadable: false });

    const res = await post(c.app, `/api/conversions/items/${old.id}/reload`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_gone' });
    expect(c.repo.registerActions).toEqual([]);
  });

  it('a gone item is reloadable, and stays so if its rerun failed after the detach', async () => {
    const c = await setup();
    const item = await startedItem(c);
    goneEntry(c, item);
    expect(ItemSchema.parse(await c.repo.getItem(item.id)).reloadable).toBe(true);
    // The detach went through; the rerun did not (the row is left detached).
    expect((await post(c.app, `/api/conversions/items/${item.id}/detach`)).statusCode).toBe(200);
    expect(ItemSchema.parse(await c.repo.getItem(item.id))).toMatchObject({
      resolution: 'detached',
      reloadable: true,
    });
    expect((await post(c.app, `/api/conversions/items/${item.id}/reload`)).statusCode).toBe(201);
  });

  it('refuses a document that is not gone', async () => {
    const c = await setup();
    const changed = await startedItem(c, 'manuals/a.docx');
    changedEntry(c, changed, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    const live = await startedItem(c, 'manuals/b.docx');
    settle(c, live, 'created', { state: 'delivered' });
    const never = await startedItem(c, 'manuals/c.docx');
    c.repo.conversionItems.get(never.id)!.outcome = 'failed';

    for (const item of [changed, live, never]) {
      const res = await post(c.app, `/api/conversions/items/${item.id}/reload`);
      expect(res.statusCode, item.sourceKey).toBe(409);
      expect(res.json()).toMatchObject({ code: 'not_gone' });
    }
    expect(c.repo.registerActions).toEqual([]);
    expect(c.repo.conversionBatches.size).toBe(3);
    expect((await post(c.app, `/api/conversions/items/${randomUUID()}/reload`)).statusCode).toBe(
      404,
    );
    expect(takeViolations()).toEqual([]);
  });

  it('an operator may load it as a new document', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const { cookie, user } = await signInNewUser(c.app, c.access, 'Olu', 'operator');
    const item = await startedItem(c, 'manuals/pumps.docx', docx(), cookie);
    goneEntry(c, item);

    const res = await post(c.app, `/api/conversions/items/${item.id}/reload`, undefined, cookie);

    expect(res.statusCode, res.body).toBe(201);
    expect(BatchDetailSchema.parse(res.json()).batch.createdBy).toEqual({
      id: user.id,
      name: 'Olu',
    });
    expect(c.repo.registerActions[0]?.by).toEqual({ id: user.id, name: 'Olu' });
  });
});

describe("accepting the target's state", () => {
  it('accept preview lists each changed component', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const changed = [
      { id: 'doc-1/section/s1', expected: '1', actual: '2' },
      { id: 'doc-1/section/s2', expected: '1', actual: null },
    ];
    changedEntry(c, item, changed);

    const entry = c.repo.register.get(c.repo.conversionItems.get(item.id)!.registerEntryId!)!;

    const res = await c.app.inject(`/api/conversions/items/${item.id}/accept`);

    expect(res.statusCode).toBe(200);
    expect(AcceptPreviewSchema.parse(res.json())).toEqual({
      changed,
      acceptable: true,
      updatedAt: entry.updatedAt,
    });
  });

  it('the preview says why an entry not changed in the target cannot be accepted', async () => {
    const c = await setup();
    const item = await startedItem(c);
    settle(c, item, 'created', { state: 'delivered' });
    const res = await c.app.inject(`/api/conversions/items/${item.id}/accept`);
    expect(res.statusCode).toBe(200);
    expect(AcceptPreviewSchema.parse(res.json())).toMatchObject({
      changed: [],
      acceptable: false,
      reason: expect.stringMatching(/not changed in the target/),
    });
  });

  it('accept needs confirm', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    const before = structuredClone(entry);

    const seen = entry.updatedAt;
    for (const payload of [
      undefined,
      {},
      { confirm: false, seen },
      { confirm: 'yes', seen },
      { confirm: true }, // the preview's `seen` is required too
    ]) {
      const res = await post(c.app, `/api/conversions/items/${item.id}/accept`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(c.repo.register.get(entry.id)).toEqual(before);
    expect(c.repo.registerActions).toEqual([]);
  });

  it('accept rewrites the expected versions and records who', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const { cookie, user } = await signInNewUser(c.app, c.access, 'Dee', 'designer');
    const item = await startedItem(c, 'manuals/pumps.docx', docx(), cookie);
    const changed = [
      { id: 'doc-1/section/s1', expected: '1', actual: '3' },
      { id: 'doc-1/section/s2', expected: '1', actual: null }, // gone: dropped
      { id: 'doc-1/section/s9', expected: 'none', actual: '1' }, // added in the target
    ];
    const entry = changedEntry(c, item, changed);

    const res = await confirmAccept(c, item, cookie);

    expect(res.statusCode).toBe(200);
    const accepted = AcceptedTargetStateSchema.parse(res.json());
    expect(accepted.changed).toEqual(changed);
    expect(accepted.item.detail).toMatch(/accepted/);
    expect(accepted.item.detail).toMatch(/next run of this source updates document doc-1/);
    const after = c.repo.register.get(entry.id)!;
    // `accepted`: the next run of the source is an update whatever its content, never already
    // loaded (worker `deliver.decide`); its delivery makes the entry `delivered` again.
    expect(after.state).toBe('accepted');
    expect(after.lastError).toBeNull();
    expect(after.persistentId).toBe('doc-1');
    expect(after.lastReceipt?.document?.components).toEqual([
      { kind: 'map', id: 'doc-1/map', version: '1', element: null },
      { kind: 'section', id: 'doc-1/section/s1', version: '3', element: 's1' },
      { kind: 'component', id: 'doc-1/section/s9', version: '1', element: null },
    ]);
    expect(c.repo.registerActions).toEqual([
      {
        id: expect.any(String),
        entryId: entry.id,
        action: 'accept',
        by: { id: user.id, name: 'Dee' },
        at: expect.any(String),
        details: { changed },
      },
    ]);
    // Accepted once: the entry is no longer changed in the target.
    const again = await post(
      c.app,
      `/api/conversions/items/${item.id}/accept`,
      { confirm: true, seen: after.updatedAt },
      cookie,
    );
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ code: 'not_acceptable' });
  });

  it('accept refuses when more components changed than the refusal lists', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `doc-1/section/s${i}`,
      expected: '1',
      actual: '2',
    }));
    const entry = changedEntry(c, item, many);
    expect(entry.lastError?.details).toHaveProperty('more');
    const before = structuredClone(entry);

    const preview = AcceptPreviewSchema.parse(
      (await c.app.inject(`/api/conversions/items/${item.id}/accept`)).json(),
    );
    expect(preview).toMatchObject({
      acceptable: false,
      reason: 'too many changes to accept here; detach instead',
    });
    expect(preview.changed).toHaveLength(40);

    const res = await confirmAccept(c, item);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'not_acceptable',
      error: 'too many changes to accept here; detach instead',
    });
    expect(c.repo.register.get(entry.id)).toEqual(before);
    expect(c.repo.registerActions).toEqual([]);
  });

  it('refuses a version the refusal had to cut short', async () => {
    const c = await setup();
    const item = await startedItem(c);
    changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: 'v'.repeat(300) }]);
    const preview = AcceptPreviewSchema.parse(
      (await c.app.inject(`/api/conversions/items/${item.id}/accept`)).json(),
    );
    expect(preview.acceptable).toBe(false);
    expect(preview.reason).toMatch(/detach instead/);
  });

  it('refuses a document gone from the target', async () => {
    const c = await setup();
    const item = await startedItem(c);
    changedEntry(c, item, [{ id: 'doc-1', expected: '1', actual: null }]);
    const res = await confirmAccept(c, item);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/gone from the target; detach instead/);
  });

  it('refuses a confirm from a preview the entry has moved on from', async () => {
    const c = await setup();
    const item = await startedItem(c);
    const entry = changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
    const preview = AcceptPreviewSchema.parse(
      (await c.app.inject(`/api/conversions/items/${item.id}/accept`)).json(),
    );
    // Meanwhile someone else accepted, a rerun was refused again, and the refusal lists more.
    Object.assign(entry, {
      lastError: refusal([
        { id: 'doc-1/section/s1', expected: '2', actual: '3' },
        { id: 'doc-1/section/s2', expected: '1', actual: '2' },
      ]),
      updatedAt: new Date(Date.parse(entry.updatedAt) + 1000).toISOString(),
    });
    const before = structuredClone(entry);

    const res = await post(c.app, `/api/conversions/items/${item.id}/accept`, {
      confirm: true,
      seen: preview.updatedAt,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'stale_preview' });
    expect(c.repo.register.get(entry.id)).toEqual(before);
    expect(c.repo.registerActions).toEqual([]);
  });

  it('an accept followed by a further edit refuses again', async () => {
    const c = await setup();
    const target = new VersionedTarget();
    const item = await startedItem(c);

    // The first run creates doc-1; the bridge's event registers the receipt.
    const first = await workerDelivers(c, item);
    await event(c, first, 'succeeded', null, target.create('doc-1', COMPONENTS));
    expect(c.repo.register.get(first.entryId)?.state).toBe('delivered');

    // Someone edits a section in the target; the next update is refused.
    target.edit('doc-1/section/s1');
    const rerun = await redeliverItem(c, item);
    const second = await workerDelivers(c, rerun);
    await event(c, second, 'needs_user', target.update(expectedOf(c, second.entryId)), null);
    expect(c.repo.conversionItems.get(rerun.id)?.outcome).toBe('changed_in_target');

    // The person accepts what the refusal showed.
    const preview = AcceptPreviewSchema.parse(
      (await c.app.inject(`/api/conversions/items/${rerun.id}/accept`)).json(),
    );
    expect(preview).toMatchObject({
      changed: [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }],
      acceptable: true,
    });
    const accepted = await post(c.app, `/api/conversions/items/${rerun.id}/accept`, {
      confirm: true,
      seen: preview.updatedAt,
    });
    expect(accepted.statusCode).toBe(200);
    // As accepted, the next update would go through.
    expect(target.check(expectedOf(c, second.entryId))).toBeNull();

    // The section is edited again before the next run: the update refuses again, with the new
    // version, so nothing the person did not see is overwritten.
    target.edit('doc-1/section/s1');
    const third = await workerDelivers(c, await redeliverItem(c, rerun));
    expect(c.repo.register.get(third.entryId)?.state).toBe('pending');
    const refused = target.update(expectedOf(c, third.entryId));
    expect(refused?.code).toBe('changed_in_target');
    expect(refused?.details).toEqual({
      changed: [{ id: 'doc-1/section/s1', expected: '2', actual: '3' }],
    });
    await event(c, third, 'needs_user', refused, null);
    expect(c.repo.register.get(third.entryId)?.state).toBe('changed');
  });
});

describe('row actions', () => {
  it('operators may act on rows', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    for (const role of ['operator', 'designer'] as const) {
      const { cookie } = await signInNewUser(c.app, c.access, `Olu ${role}`, role);
      const item = await startedItem(c, `${role}/a.docx`, docx(), cookie);
      changedEntry(c, item, [{ id: 'doc-1/section/s1', expected: '1', actual: '2' }]);
      const url = (action: string) => `/api/conversions/items/${item.id}/${action}`;

      /** A rerun's item given an outcome, so the row may be acted on again. */
      const finish = (res: { json(): unknown }) => {
        const [rerun] = BatchDetailSchema.parse(res.json()).items as [Item];
        c.repo.conversionItems.get(rerun.id)!.outcome = 'changed_in_target';
        return rerun;
      };

      const forced = await post(c.app, url('force'), undefined, cookie);
      expect(forced.statusCode, `${role} force`).toBe(201);
      expect(BatchDetailSchema.parse(forced.json()).batch.createdBy.name).toBe(`Olu ${role}`);
      expect(jobOf(c, finish(forced))?.createdBy).toBe(`Olu ${role}`);
      const redelivered = await post(c.app, url('redeliver'), undefined, cookie);
      expect(redelivered.statusCode, role).toBe(201);
      finish(redelivered);
      const preview = await c.app.inject({ url: url('accept'), headers: { cookie } });
      expect(preview.statusCode, `${role} preview`).toBe(200);
      const accept = await confirmAccept(c, item, cookie);
      expect(accept.statusCode, `${role} accept`).toBe(200);
      // Refused again by a later run (only a refused document is detached).
      refusedAgain(c, item);
      expect((await post(c.app, url('detach'), undefined, cookie)).statusCode, role).toBe(200);
    }
  });
});

// --- The Review Focus 3 scenario: a target that checks versions, as the fake document sink does.

/** What the worker's update sends as `expected`: the entry's last receipt's components. */
const expectedOf = (c: Ctx, entryId: string): ComponentVersion[] =>
  c.repo.register.get(entryId)?.lastReceipt?.document?.components ?? [];

/**
 * A target holding one document's component versions, checking a conditional update the way the
 * fake document sink does (apps/bridge/src/sinks/fake-documents.ts): every expected component
 * at its version, and no current component the update did not expect (listed as `none`).
 */
class VersionedTarget {
  private readonly components = new Map<string, ComponentVersion>();

  create(persistentId: string, components: ComponentVersion[]): Receipt {
    for (const component of components) this.components.set(component.id, { ...component });
    return this.receipt(persistentId);
  }

  edit(id: string): void {
    const component = this.components.get(id)!;
    component.version = `${Number(component.version) + 1}`;
  }

  check(expected: ComponentVersion[]): BridgeError | null {
    const changed: Array<{ id: string; expected: string; actual: string | null }> = [];
    const ids = new Set(expected.map((e) => e.id));
    for (const e of expected) {
      const actual = this.components.get(e.id)?.version ?? null;
      if (actual !== e.version) changed.push({ id: e.id, expected: e.version, actual });
    }
    for (const [id, current] of this.components) {
      if (!ids.has(id)) changed.push({ id, expected: 'none', actual: current.version });
    }
    return changed.length ? refusal(changed) : null;
  }

  /** A conditional update: the refusal, or null when it went through (every component bumped). */
  update(expected: ComponentVersion[]): BridgeError | null {
    const refused = this.check(expected);
    if (refused) return refused;
    for (const component of this.components.values()) {
      component.version = `${Number(component.version) + 1}`;
    }
    return null;
  }

  private receipt(persistentId: string): Receipt {
    return receiptOf(
      [...this.components.values()].map((v) => ({ ...v })),
      persistentId,
    );
  }
}

/** The worker's run of an item: the entry for its source pending under a new delivery. */
async function workerDelivers(c: Ctx, item: Item) {
  const deliveryId = randomUUID();
  const existing = [...c.repo.register.values()].find((e) => e.sourceKey === item.sourceKey);
  let entryId: string;
  if (existing) {
    Object.assign(existing, {
      state: 'pending',
      deliveryId,
      lastError: null,
      batchId: item.batchId,
    });
    entryId = existing.id;
  } else {
    entryId = c.repo.putRegisterEntry({
      sinkId: 'docs',
      instanceId: null,
      sourceKey: item.sourceKey,
      contentSha256: item.contentSha256,
      persistentId: null,
      idempotencyKey: 'k'.repeat(64),
      deliveryId,
      batchId: item.batchId,
    }).id;
  }
  Object.assign(c.repo.conversionItems.get(item.id)!, {
    outcome: 'delivering',
    registerEntryId: entryId,
  });
  return { deliveryId, entryId };
}

/** The delivery's final event from the bridge. */
async function event(
  c: Ctx,
  d: { deliveryId: string },
  status: BridgeEvent['status'],
  error: BridgeError | null,
  receipt: Receipt | null,
) {
  const applied = await applyRegisterEvent(c.repo, {
    eventId: randomUUID(),
    deliveryId: d.deliveryId,
    sequence: 1,
    status,
    error,
    receipt,
    at: '2026-10-25T10:00:00.000Z',
  });
  expect(applied).toBe('applied');
}

/** Redeliver from the item's row: the new batch's item. */
async function redeliverItem(c: Ctx, item: Item): Promise<Item> {
  const res = await post(c.app, `/api/conversions/items/${item.id}/redeliver`);
  expect(res.statusCode).toBe(201);
  return BatchDetailSchema.parse(res.json()).items[0]!;
}
