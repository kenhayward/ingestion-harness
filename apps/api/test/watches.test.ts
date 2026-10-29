import { randomUUID } from 'node:crypto';
import { decompositionHeldManifestKey, decompositionHeldPageKey } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { BridgeApiError } from '../src/bridge/client.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { FAKE_DOCUMENT_SINK, FAKE_SINK, FAKE_WATCHED_SINK } from './fake-sink.js';
import { accessApp, signInNewUser, testApp } from './helpers.js';
import { takeViolations } from './openapi-conformance.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

const SOURCE = { library: 'Manuals', folder: 'incoming' };
const body = (over: Record<string, unknown> = {}) => ({
  name: 'Manuals inbox',
  targetId: 'manuals',
  source: SOURCE,
  ...over,
});

/** `manuals` takes documents and has watched folders; `plain` takes documents only. */
async function withTargets<C extends Ctx>(c: C, cookie?: string): Promise<C> {
  c.bridge.sinkViews = [FAKE_SINK, FAKE_DOCUMENT_SINK, FAKE_WATCHED_SINK];
  const make = async (label: string, sinkId: string) => {
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
    if (res.statusCode !== 201) throw new Error(`target: ${res.body}`);
  };
  await make('Manuals', 'watched');
  await make('Plain', 'docs');
  return c;
}

const setup = async () => withTargets(await testApp());
const call = (
  c: Ctx,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  cookie?: string,
) =>
  c.app.inject({
    method,
    url: `/api${url}`,
    headers: cookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function created(c: Ctx, over: Record<string, unknown> = {}, cookie?: string) {
  const res = await call(c, 'POST', '/watches', body(over), cookie);
  if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; state: string; runAs: Record<string, unknown> };
}

describe('watched folders: who may use them', () => {
  it('refuses designers and operators every route, whatever the answer would be', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const op = (await signInNewUser(c.app, c.access, 'Olu', 'operator')).cookie;
    const made = await created(c, {}, c.adminCookie);
    const id = made.id;
    const calls: [string, string, unknown?][] = [
      ['GET', '/watches'],
      ['GET', '/watches/problems'],
      ['GET', '/watches/sources'],
      ['GET', `/watches/${id}`],
      [
        'POST',
        '/watches/browse',
        { targetId: 'manuals', field: 'library', parentId: null, cursor: null },
      ],
      ['POST', '/watches/test', { targetId: 'manuals', source: SOURCE }],
      ['POST', '/watches', body({ name: 'Other' })],
      ['PATCH', `/watches/${id}`, { admit: 5 }],
      ['POST', `/watches/${id}/stop`, { mode: 'now' }],
      ['POST', `/watches/${id}/start`],
      ['DELETE', `/watches/${id}`],
    ];
    for (const cookie of [c.userCookie, op]) {
      for (const [method, url, payload] of calls) {
        const res = await call(c, method as 'GET', url, payload, cookie);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    // Nothing the refused calls asked for happened.
    expect(
      (await call(c, 'GET', `/watches/${id}`, undefined, c.adminCookie)).json().watch,
    ).toMatchObject({
      state: 'running',
      admit: 10,
    });
  });
});

describe('watched folders: reading', () => {
  it('lists only the targets whose sink has watched folders and takes documents', async () => {
    const c = await setup();
    const res = await call(c, 'GET', '/watches/sources');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        targetId: 'manuals',
        label: 'Manuals',
        sinkId: 'watched',
        instanceId: null,
        sourceFields: FAKE_WATCHED_SINK.capabilities.watchedFolders!.sourceFields,
      },
    ]);
  });

  it('answers a watch with its events, the problems count, and 404 for an unknown or malformed id', async () => {
    const c = await setup();
    const made = await created(c);
    c.watches.addEvent(made.id, 'warn', 'a note');
    const one = await call(c, 'GET', `/watches/${made.id}`);
    expect(one.json().watch.id).toBe(made.id);
    expect(one.json().events).toMatchObject([{ level: 'warn', message: 'a note' }]);
    expect((await call(c, 'GET', '/watches')).json()).toHaveLength(1);
    c.watches.setProblem(made.id, 'no connection');
    expect((await call(c, 'GET', '/watches/problems')).json()).toEqual({ count: 1 });
    for (const url of [`/watches/${randomUUID()}`, '/watches/not-a-uuid']) {
      expect((await call(c, 'GET', url)).statusCode).toBe(404);
    }
    expect((await call(c, 'DELETE', '/watches/not-a-uuid')).statusCode).toBe(404);
    expect((await call(c, 'POST', '/watches/not-a-uuid/start')).statusCode).toBe(404);
    expect((await call(c, 'POST', '/watches/not-a-uuid/stop', { mode: 'now' })).statusCode).toBe(
      404,
    );
    expect((await call(c, 'PATCH', '/watches/not-a-uuid', { admit: 5 })).statusCode).toBe(404);
  });

  it('browses the source tree as the signed-in admin', async () => {
    const c = await setup();
    const res = await call(c, 'POST', '/watches/browse', {
      targetId: 'manuals',
      field: 'folder',
      parentId: 'lib-1',
      cursor: null,
    });
    expect(res.statusCode).toBe(200);
    expect(c.bridge.browsed).toMatchObject([
      { sinkId: 'watched', scope: 'source', field: 'folder', parentId: 'lib-1' },
    ]);
    const stray = await call(c, 'POST', '/watches/browse', {
      targetId: 'manuals',
      field: 'nope',
      parentId: null,
      cursor: null,
    });
    expect(stray.statusCode).toBe(422);
    const plain = await call(c, 'POST', '/watches/browse', {
      targetId: 'plain',
      field: 'library',
      parentId: null,
      cursor: null,
    });
    expect(plain.json()).toMatchObject({ code: 'target_not_watchable' });
  });

  it('tests a folder by listing its root', async () => {
    const c = await setup();
    c.bridge.sourceFiles = [
      { name: 'a.docx', size: 1, modifiedAt: '2026-10-29T10:00:00.000Z', etag: null },
      { name: 'b.pdf', size: 2, modifiedAt: '2026-10-29T10:00:00.000Z', etag: null },
    ];
    const ok = await call(c, 'POST', '/watches/test', { targetId: 'manuals', source: SOURCE });
    expect(ok.json()).toEqual({ ok: true, files: 2 });
    expect(c.bridge.listed[0]).toMatchObject({
      targetId: 'manuals',
      body: { folder: '', source: SOURCE },
    });
    c.bridge.sourceFiles = FakeBridgeApi.refusal('no connection for Manuals', 'connection_missing');
    const bad = await call(c, 'POST', '/watches/test', { targetId: 'manuals', source: SOURCE });
    expect(bad.json()).toEqual({ ok: false, problem: 'no connection for Manuals' });
  });
});

describe('watched folders: creating', () => {
  it('lists the folder first and saves a running watch that runs as the signed-in admin', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const me = (
      await c.app.inject({ url: '/api/auth/me', headers: { cookie: c.adminCookie } })
    ).json();
    const watch = await created(c, { sleepSeconds: 60 }, c.adminCookie);
    expect(watch).toMatchObject({
      state: 'running',
      name: 'Manuals inbox',
      sourcePath: 'Manuals/incoming',
      sleepSeconds: 60,
      autoApprove: true,
      reasonFiles: true,
      force: false,
      admit: 10,
    });
    expect(watch.runAs).toMatchObject({ id: me.userId });
    expect(c.bridge.listed).toHaveLength(1);
    expect(c.bridge.listed[0]!.body.actingUser).toMatchObject({ id: me.userId });
  });

  it('saves nothing when the listing fails, and says why', async () => {
    const c = await setup();
    c.bridge.sourceFiles = FakeBridgeApi.refusal('the folder is gone', 'not_found', 404);
    const res = await call(c, 'POST', '/watches', body());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'the folder is gone', code: 'source_test_failed' });
    expect(await c.watches.list()).toEqual([]);
  });

  it('refuses a target that cannot be watched, a stray or missing source field, and a repeated name', async () => {
    const c = await setup();
    const plain = await call(c, 'POST', '/watches', body({ targetId: 'plain' }));
    expect(plain.json()).toMatchObject({ code: 'target_not_watchable' });
    const unknown = await call(c, 'POST', '/watches', body({ targetId: 'nowhere' }));
    expect(unknown.json()).toMatchObject({ code: 'unknown_target' });
    const stray = await call(c, 'POST', '/watches', body({ source: { ...SOURCE, extra: 'x' } }));
    expect(stray.json()).toMatchObject({ code: 'bad_source' });
    const missing = await call(c, 'POST', '/watches', body({ source: { folder: 'x' } }));
    expect(missing.json()).toMatchObject({ code: 'bad_source', error: 'Library is required' });
    // A folder path the documents' source keys could not be made from.
    const doubled = await call(
      c,
      'POST',
      '/watches',
      body({ source: { ...SOURCE, folder: 'a//b' } }),
    );
    expect(doubled.json()).toMatchObject({
      code: 'bad_source',
      error: 'the folder cannot be watched: the source key has an empty part (//)',
    });
    const bell = await call(c, 'POST', '/watches', body({ source: { ...SOURCE, folder: 'a' } }));
    expect(bell.json()).toMatchObject({
      code: 'bad_source',
      error: 'the folder cannot be watched: the source key holds a control character',
    });
    expect((await call(c, 'POST', '/watches', { name: '' })).statusCode).toBe(400);
    await created(c);
    const again = await call(c, 'POST', '/watches', body({ name: 'MANUALS INBOX' }));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'name_taken' });
  });

  it('locks its target: it is in use and cannot be removed while a watch names it', async () => {
    const c = await setup();
    const made = await created(c);
    const usage = await c.targets.usage('manuals');
    expect(usage.watches).toBe(1);
    const removed = await call(c, 'DELETE', '/publish-targets/manuals');
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error).toContain('1 watched folder');
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    await call(c, 'DELETE', `/watches/${made.id}`);
    expect((await call(c, 'DELETE', '/publish-targets/manuals')).statusCode).toBe(204);
  });
});

describe('watched folders: changing', () => {
  it('changes the tuning while running, but the target, folder and run-as only when stopped', async () => {
    const c = await setup();
    const made = await created(c);
    const tuned = await call(c, 'PATCH', `/watches/${made.id}`, { admit: 20, autoApprove: false });
    expect(tuned.json()).toMatchObject({ admit: 20, autoApprove: false });
    for (const change of [
      { targetId: 'manuals' },
      { source: { library: 'Other' } },
      { runAsMe: true },
    ]) {
      const res = await call(c, 'PATCH', `/watches/${made.id}`, change);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('stop the watch first');
    }
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    const moved = await call(c, 'PATCH', `/watches/${made.id}`, { source: { library: 'Other' } });
    expect(moved.json()).toMatchObject({ source: { library: 'Other' }, sourcePath: 'Other' });
  });

  it('another admin takes over a stopped watch: it then runs as them', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const second = await signInNewUser(c.app, c.access, 'Beth', 'admin');
    const made = await created(c, {}, c.adminCookie);
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' }, c.adminCookie);
    const res = await call(c, 'PATCH', `/watches/${made.id}`, { runAsMe: true }, second.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().runAs).toMatchObject({ id: second.user.id, email: second.email });
    expect(res.json().runAs.id).not.toBe(made.runAs.id);
  });

  it('a folder or target change makes the requester the one it runs as, after listing the folder as them', async () => {
    const c = await accessApp();
    await withTargets(c, c.adminCookie);
    const second = await signInNewUser(c.app, c.access, 'Beth', 'admin');
    const made = await created(c, {}, c.adminCookie);
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' }, c.adminCookie);
    c.bridge.listed.length = 0;
    const res = await call(
      c,
      'PATCH',
      `/watches/${made.id}`,
      { source: { library: 'Other' } },
      second.cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().runAs.id).toBe(second.user.id);
    expect(c.bridge.listed).toHaveLength(1);
    expect(c.bridge.listed[0]!.body).toMatchObject({
      source: { library: 'Other' },
      actingUser: { id: second.user.id },
    });
  });

  it('saves nothing when the new folder cannot be listed', async () => {
    const c = await setup();
    const made = await created(c);
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    c.bridge.sourceFiles = FakeBridgeApi.refusal('no connection for Manuals', 'connection_missing');
    const res = await call(c, 'PATCH', `/watches/${made.id}`, {
      source: { library: 'Other' },
      admit: 3,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'no connection for Manuals', code: 'source_test_failed' });
    expect((await c.watches.get(made.id))!).toMatchObject({
      source: SOURCE,
      sourcePath: 'Manuals/incoming',
      admit: 10,
    });
  });

  it('refuses a stray source field and a name another watch has', async () => {
    const c = await setup();
    const a = await created(c);
    const b = await created(c, { name: 'Second' });
    await call(c, 'POST', `/watches/${a.id}/stop`, { mode: 'now' });
    const stray = await call(c, 'PATCH', `/watches/${a.id}`, { source: { nope: 'x' } });
    expect(stray.json()).toMatchObject({ code: 'bad_source' });
    const taken = await call(c, 'PATCH', `/watches/${b.id}`, { name: 'manuals inbox' });
    expect(taken.statusCode).toBe(409);
    expect((await call(c, 'PATCH', `/watches/${b.id}`, {})).statusCode).toBe(400);
  });
});

describe('watched folders: stopping, starting and removing', () => {
  it('stop now fails the items that have not reached the bridge, deletes their held files, and leaves the rest', async () => {
    const c = await setup();
    const made = await created(c);
    const ids: Record<string, string> = {};
    for (const outcome of [
      'queued',
      'waiting_to_deliver',
      'awaiting_review',
      'decomposing',
      'delivering',
    ]) {
      ids[outcome] = c.watches.addUnfinished(made.id, outcome);
    }
    const held = c.watches.item(made.id, ids.awaiting_review!);
    const manifestKey = decompositionHeldManifestKey(held.batchId, ids.awaiting_review!);
    const pageKey = decompositionHeldPageKey(held.batchId, ids.awaiting_review!, 1);
    const manifest = {
      version: 1,
      document: {
        blocks: [],
        sections: [],
        images: [],
        equations: [],
        notes: [],
        properties: [],
        report: [],
      },
      images: [],
      pageCount: 1,
      pageMap: {},
    };
    await c.store.put(
      'runs',
      manifestKey,
      Buffer.from(JSON.stringify(manifest)),
      'application/json',
    );
    await c.store.put('runs', pageKey, Buffer.from('jpeg'), 'image/jpeg');
    // A file the worker took and stored, but had not queued: let go, its copy deleted.
    const taken = 'decompositions/b/taken.pdf';
    await c.store.put('runs', taken, Buffer.from('%PDF-'), 'application/pdf');
    c.watches.addPickup(made.id, 'moved', 0, taken);

    const res = await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'stopped', queue: { inProgress: 2 } });
    for (const outcome of ['queued', 'waiting_to_deliver', 'awaiting_review']) {
      expect(c.watches.item(made.id, ids[outcome]!)).toMatchObject({
        outcome: 'failed',
        detail: 'Cancelled: the watch was stopped',
        pickup: 'abandoned',
      });
    }
    expect(c.watches.item(made.id, ids.queued!).jobStatus).toBe('cancelled');
    // A worker runs this one: its job is cancelled and the worker decides the item.
    expect(c.watches.item(made.id, ids.decomposing!)).toMatchObject({
      outcome: 'decomposing',
      jobStatus: 'cancelled',
      detail: null,
    });
    expect(c.watches.item(made.id, ids.delivering!)).toMatchObject({
      outcome: 'delivering',
      pickup: 'queued',
    });
    expect(await c.store.get('runs', manifestKey)).toBeNull();
    expect(await c.store.get('runs', pageKey)).toBeNull();
    expect(await c.store.get('runs', taken)).toBeNull();
  });

  it('drain only changes the state, and each stop is refused in a state it does not apply to', async () => {
    const c = await setup();
    const made = await created(c);
    const item = c.watches.addUnfinished(made.id, 'queued');
    const drain = await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'drain' });
    expect(drain.json()).toMatchObject({ state: 'draining', health: 'draining' });
    expect(c.watches.item(made.id, item)).toMatchObject({ outcome: 'queued', jobStatus: 'queued' });
    expect((await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'drain' })).statusCode).toBe(
      409,
    );
    expect((await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' })).statusCode).toBe(
      200,
    );
    expect((await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' })).statusCode).toBe(
      409,
    );
    expect((await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'later' })).statusCode).toBe(
      400,
    );
  });

  it('start clears the problem and runs the watch again', async () => {
    const c = await setup();
    const made = await created(c);
    c.watches.setProblem(made.id, 'the folder is gone');
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    const res = await call(c, 'POST', `/watches/${made.id}/start`);
    expect(res.json()).toMatchObject({ state: 'running', problem: null, health: 'running' });
    expect((await call(c, 'POST', `/watches/${randomUUID()}/start`)).statusCode).toBe(404);
  });

  it('start tries moves the sink refused again', async () => {
    const c = await setup();
    const made = await created(c);
    c.watches.addPickup(made.id, 'refusing', 5);
    c.watches.addPickup(made.id, 'finished', 2);
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    await call(c, 'POST', `/watches/${made.id}/start`);
    expect(c.watches.moveFailures(made.id)).toEqual({ refusing: 0, finished: 2 });
  });

  it('removes a stopped watch only', async () => {
    const c = await setup();
    const made = await created(c);
    const running = await call(c, 'DELETE', `/watches/${made.id}`);
    expect(running.statusCode).toBe(409);
    expect(running.json().error).toBe('stop the watch first');
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    expect((await call(c, 'DELETE', `/watches/${made.id}`)).statusCode).toBe(204);
    expect((await call(c, 'GET', `/watches/${made.id}`)).statusCode).toBe(404);
    expect((await call(c, 'DELETE', `/watches/${made.id}`)).statusCode).toBe(404);
  });

  it('documents every route against its answers', async () => {
    const c = await setup();
    const made = await created(c);
    await call(c, 'GET', '/watches');
    await call(c, 'GET', `/watches/${made.id}`);
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'drain' });
    expect(takeViolations()).toEqual([]);
  });
});

describe("a watch's batch on the Conversion page", () => {
  const ADA = { id: null, name: 'Ada' };
  /** A started batch the watch owns, with a failed item and an unfinished one, files stored. */
  async function watchBatch(c: Ctx) {
    const batch = await c.repo.createBatch({ targetId: 'manuals', force: false, createdBy: ADA });
    const mk = async (sourceKey: string) => {
      const id = randomUUID();
      const objectKey = `decompositions/${batch.id}/${id}.docx`;
      await c.store.put('runs', objectKey, Buffer.from(sourceKey), 'application/octet-stream');
      await c.repo.addItem({
        id,
        batchId: batch.id,
        sourceKey,
        filename: sourceKey,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 1,
        objectKey,
      });
      return { id, objectKey };
    };
    const failed = await mk('failed.docx');
    const running = await mk('running.docx');
    await c.repo.startBatch(batch.id, null);
    c.repo.markWatchBatch(batch.id, { id: randomUUID(), name: 'Manuals inbox' });
    c.repo.conversionItems.get(failed.id)!.outcome = 'failed';
    return { batch, failed, running };
  }

  it('says which watch owns it, and refuses to re-run its documents in place', async () => {
    const c = await setup();
    const { batch, failed } = await watchBatch(c);
    const got = await call(c, 'GET', `/conversions/batches/${batch.id}`);
    expect(got.json().batch.watch).toMatchObject({ name: 'Manuals inbox' });
    const refusals = [
      call(c, 'POST', `/conversions/batches/${batch.id}/retry`, { itemIds: [failed.id] }),
      call(c, 'POST', `/conversions/items/${failed.id}/force`),
      call(c, 'POST', `/conversions/items/${failed.id}/redeliver`),
      call(c, 'POST', `/conversions/items/${failed.id}/reload`),
    ];
    for (const res of await Promise.all(refusals)) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'watched documents are re-processed by uploading them again',
        code: 'watched',
      });
    }
    expect(c.repo.backgroundJobs.filter((j) => j.task === 'decompose')).toHaveLength(2);
  });

  it('deleting it removes the finished documents and their files and keeps the unfinished rows', async () => {
    const c = await setup();
    const { batch, failed, running } = await watchBatch(c);
    const owner = await created(c, { name: 'Counted' });
    c.watches.recordFinish(owner.id, true);
    c.watches.recordFinish(owner.id, false);
    c.repo.markWatchBatch(batch.id, { id: owner.id, name: 'Counted' });
    const gone = await call(c, 'DELETE', `/conversions/batches/${batch.id}`);
    expect(gone.statusCode).toBe(204);
    const left = await call(c, 'GET', `/conversions/batches/${batch.id}`);
    expect(left.json().items.map((i: { id: string }) => i.id)).toEqual([running.id]);
    expect(await c.store.get('runs', failed.objectKey)).toBeNull();
    expect(await c.store.get('runs', running.objectKey)).not.toBeNull();
    expect((await c.watches.get(owner.id))!.throughput.total).toEqual({ delivered: 1, failed: 1 });
    // Once it has finished too, the batch goes with it.
    c.repo.conversionItems.get(running.id)!.outcome = 'failed';
    expect((await call(c, 'DELETE', `/conversions/batches/${batch.id}`)).statusCode).toBe(204);
    expect((await call(c, 'GET', `/conversions/batches/${batch.id}`)).statusCode).toBe(404);
    expect((await c.watches.get(owner.id))!.throughput.total).toEqual({ delivered: 1, failed: 1 });
  });

  it('serves no original for a file that was refused unread', async () => {
    const c = await setup();
    const { failed } = await watchBatch(c);
    expect((await call(c, 'GET', `/conversions/items/${failed.id}/source`)).statusCode).toBe(200);
    c.repo.conversionItems.get(failed.id)!.objectKey = null;
    const res = await call(c, 'GET', `/conversions/items/${failed.id}/source`);
    expect(res.statusCode).toBe(404);
  });
});

describe('watched folders: bridge failures and ordering', () => {
  it('answers 502, not 422, when the bridge is down or does not authorise the listing', async () => {
    const c = await setup();
    c.bridge.sourceFiles = new BridgeApiError(503, null, 'the bridge is down');
    const test = await call(c, 'POST', '/watches/test', { targetId: 'manuals', source: SOURCE });
    expect(test.statusCode).toBe(502);
    expect((await call(c, 'POST', '/watches', body())).statusCode).toBe(502);
    c.bridge.sourceFiles = new BridgeApiError(401, null, 'not signed');
    expect((await call(c, 'POST', '/watches', body())).statusCode).toBe(502);
    expect(await c.watches.list()).toEqual([]);
    c.bridge.sourceFiles = [];
    const made = await created(c);
    await call(c, 'POST', `/watches/${made.id}/stop`, { mode: 'now' });
    c.bridge.sourceFiles = new BridgeApiError(500, null, 'down');
    const moved = await call(c, 'PATCH', `/watches/${made.id}`, { source: { library: 'Other' } });
    expect(moved.statusCode).toBe(502);
  });

  it('gives a bridge refusal on browse the code the docs promise', async () => {
    const c = await setup();
    c.bridge.browseError = FakeBridgeApi.refusal('no connection for Manuals', 'connection_missing');
    const res = await call(c, 'POST', '/watches/browse', {
      targetId: 'manuals',
      field: 'library',
      parentId: null,
      cursor: null,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'no connection for Manuals', code: 'bridge_refused' });
  });

  it('checks the name before it asks the bridge, and says no such watch', async () => {
    const c = await setup();
    const made = await created(c);
    c.bridge.listed.length = 0;
    const again = await call(c, 'POST', '/watches', body({ name: 'manuals INBOX' }));
    expect(again.statusCode).toBe(409);
    expect(c.bridge.listed).toEqual([]);
    const missing = await call(c, 'GET', `/watches/${randomUUID()}`);
    expect(missing.json()).toEqual({ error: 'no such watch' });
    expect((await call(c, 'GET', `/watches/${made.id}`)).statusCode).toBe(200);
  });
});
