import { describe, expect, it, vi } from 'vitest';
import type { JobOutput, JobSummary, PublishTargetView } from '@ih/shared';
import { BridgeApiError } from '../src/bridge/client.js';
import { pullTargets } from '../src/bridge/sync.js';
import type { SecretsKeys } from '../src/llm/secrets.js';
import { seedRdf as seedRdfOnBridge } from '../src/publish-targets/seed.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { accessApp, fakePdf, multipart, signInNewUser, testApp } from './helpers.js';
import { cacheS3, type S3TargetSpec } from './target-views.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const SECRET = 'wJalrXUtnFEMI-very-secret';
const FINANCE_ENDPOINT = 'https://s3.finance.example';

const externalBody = (over: object = {}) => ({
  label: 'Finance lake',
  kind: 'external',
  bucket: 'finance-lake',
  prefix: 'ingest',
  connectionId: 'finance-account',
  ...over,
});

/** A cached external target on the bridge connection `finance-account`. */
const financeTarget = (over: Partial<S3TargetSpec> = {}): S3TargetSpec => ({
  id: 'finance-lake',
  label: 'Finance lake',
  kind: 'external',
  bucket: 'finance-lake',
  prefix: 'ingest/',
  connectionId: 'finance-account',
  ...over,
});

const letter = (version: number, publishTo?: string | string[]) => ({
  id: 'letter',
  version,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
  ...(publishTo ? { delivery: { publishTo } } : {}),
});

async function setup(withKeys = true) {
  const ctx = await testApp({ llmSecrets: withKeys ? keys : null });
  ctx.bridge.summaries.push({
    id: 'finance-account',
    name: 'Finance account',
    sinkId: 's3',
    status: 'ok',
    statusReason: null,
    fields: {},
  });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}) });
  return { ...ctx, call };
}

/** A recipe version published naming `publishTo` (so the target is in use). */
async function publishLetter(
  ctx: Awaited<ReturnType<typeof setup>>,
  version: number,
  publishTo?: string | string[],
) {
  await ctx.templates.create('letter', version, letter(version, publishTo), 'draft');
  await ctx.templates.publish('letter', version, 'Ken');
}

describe('publishing target routes: list and choices', () => {
  it('lists the default with its usage and each connection as the bridge names it, never a secret', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget(), { source: 'ui', by: 'Ken' });
    const res = await c.call('GET', '/publish-targets');
    expect(res.statusCode).toBe(200);
    const { targets } = res.json() as { targets: PublishTargetView[] };
    expect(targets.map((t) => t.id)).toEqual(['default', 'finance-lake']);
    expect(targets[0]).toMatchObject({ connectionId: null, connection: null });
    expect(targets[1]).toMatchObject({
      connectionId: 'finance-account',
      connection: { id: 'finance-account', name: 'Finance account', status: 'ok' },
    });
    expect(targets[1]!.usage).toEqual({
      publishedVersions: 0,
      documentTypes: [],
      deliveredOutputs: 0,
      consumers: 0,
      pendingJobs: 0,
    });
    for (const hidden of [SECRET, 'secretKeyEnc', 'AKIAFINANCE', FINANCE_ENDPOINT, 'secretSet']) {
      expect(res.body).not.toContain(hidden);
    }
  });

  it('still lists the targets when the bridge cannot name their connections', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget(), { source: 'ui', by: 'Ken' });
    c.bridge.failNext = new BridgeApiError(0, null, 'the bridge could not be reached');
    const res = await c.call('GET', '/publish-targets');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { targets: PublishTargetView[] }).targets[1]).toMatchObject({
      connectionId: 'finance-account',
      connection: null,
    });
  });

  it('offers choices to designers; the rest is admin-only', async () => {
    const { app, adminCookie, userCookie } = await accessApp();
    const choices = await app.inject({
      url: '/api/publish-targets/choices',
      headers: { cookie: userCookie },
    });
    expect(choices.statusCode).toBe(200);
    expect(choices.json()).toEqual({
      choices: [
        {
          id: 'default',
          label: 'Default',
          kind: 'internal',
          bucket: 'published',
          prefix: 'pub/',
          layout: 'files',
          sinkName: null,
        },
      ],
    });
    const calls = [
      { method: 'GET' as const, url: '/api/publish-targets' },
      { method: 'GET' as const, url: '/api/publish-targets/connections' },
      { method: 'POST' as const, url: '/api/publish-targets', payload: externalBody() },
      { method: 'PATCH' as const, url: '/api/publish-targets/default', payload: { label: 'x' } },
      { method: 'DELETE' as const, url: '/api/publish-targets/default' },
      { method: 'POST' as const, url: '/api/publish-targets/test', payload: { id: 'default' } },
    ];
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: { cookie: userCookie } });
      expect([call.url, res.statusCode, res.json()]).toEqual([
        call.url,
        403,
        { error: 'admins only' },
      ]);
    }
    const admin = await app.inject({
      url: '/api/publish-targets',
      headers: { cookie: adminCookie },
    });
    expect(admin.statusCode).toBe(200);
  });

  it('refuses every route to operators', async () => {
    const { app, access } = await accessApp();
    const { cookie } = await signInNewUser(app, access, 'Olu', 'operator');
    const res = await app.inject({ url: '/api/publish-targets/choices', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/publish-targets/connections', () => {
  it("lists the bridge's shared S3 connections, without the built-in one", async () => {
    const c = await setup();
    const res = await c.call('GET', '/publish-targets/connections');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connections: [
        {
          id: 'finance-account',
          name: 'Finance account',
          status: 'ok',
          statusReason: null,
        },
      ],
    });
  });

  it('is a 502 when the bridge cannot be reached', async () => {
    const c = await setup();
    c.bridge.failNext = new BridgeApiError(0, null, 'the bridge could not be reached');
    const res = await c.call('GET', '/publish-targets/connections');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('the delivery bridge could not be reached');
  });
});

describe('POST /api/publish-targets', () => {
  it('adds an internal target, creating its bucket and mirroring it, with an id made from the label', async () => {
    const c = await setup();
    const body = { label: 'Finance lake', kind: 'internal', bucket: 'finance-bucket' };
    const res = await c.call('POST', '/publish-targets', body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'finance-lake',
      kind: 'internal',
      bucket: 'finance-bucket',
      prefix: '',
      source: 'ui',
      connectionId: null,
    });
    expect((c.targetStore as MemoryObjectStore).ensured).toEqual(['finance-bucket']);
    expect(c.bridge.targets.get('finance-lake')).toMatchObject({
      connectionId: 'internal',
      destination: { bucket: 'finance-bucket', prefix: '' },
    });
    const again = await c.call('POST', '/publish-targets', body);
    expect(again.json().id).toBe('finance-lake-2');
    const third = await c.call('POST', '/publish-targets', body);
    expect(third.json().id).toBe('finance-lake-3');
  });

  it('normalises the prefix', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', {
      label: 'L',
      kind: 'internal',
      bucket: 'lake-bucket',
      prefix: '/ingest',
    });
    expect(res.json().prefix).toBe('ingest/');
  });

  it('refuses the reserved id and an id that exists', async () => {
    const c = await setup();
    const reserved = await c.call('POST', '/publish-targets', externalBody({ id: 'default' }));
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().error).toBe('default is reserved');
    expect(
      (await c.call('POST', '/publish-targets', externalBody({ id: 'lake' }))).statusCode,
    ).toBe(201);
    const taken = await c.call('POST', '/publish-targets', externalBody({ id: 'lake' }));
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('a publishing target lake already exists');
  });

  it("refuses CT Studio's own buckets for an internal target", async () => {
    const c = await setup();
    for (const bucket of ['inbox', 'outputs', 'runs', 'backups']) {
      const res = await c.call('POST', '/publish-targets', {
        label: 'Oops',
        kind: 'internal',
        bucket,
      });
      expect([bucket, res.statusCode, res.json().error]).toEqual([
        bucket,
        400,
        `${bucket} is CT Studio's own ${bucket} bucket: pick another`,
      ]);
    }
    expect((c.targetStore as MemoryObjectStore).ensured).toEqual([]);
    // Another server's bucket of that name is not ours.
    const external = await c.call('POST', '/publish-targets', externalBody({ bucket: 'runs' }));
    expect(external.statusCode).toBe(201);
  });

  it('answers 400 with the issues of an invalid body', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', externalBody({ connectionId: undefined }));
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toContain('an external target needs a connection');
  });

  it('a body carrying secretAccessKey is 400', async () => {
    const c = await setup();
    const res = await c.call(
      'POST',
      '/publish-targets',
      externalBody({ accessKeyId: 'AKIA', secretAccessKey: SECRET }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(SECRET);
    expect((await c.targets.list()).map((t) => t.id)).toEqual(['default']);
  });

  it('stores nothing when the bucket cannot be created', async () => {
    const c = await setup();
    (c.targetStore as MemoryObjectStore).ensureBucket = async () => {
      throw new Error('AccessDenied');
    };
    const res = await c.call('POST', '/publish-targets', {
      label: 'L',
      kind: 'internal',
      bucket: 'lake-bucket',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('could not create bucket lake-bucket: AccessDenied');
    expect((await c.targets.list()).map((t) => t.id)).toEqual(['default']);
  });

  it('create external with a connectionId mirrors to the bridge and stores no secret column', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', externalBody());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: 'finance-lake',
      prefix: 'ingest/',
      connectionId: 'finance-account',
      connection: { name: 'Finance account', status: 'ok' },
    });
    // The cache holds the bridge's answer: no key, no endpoint.
    const stored = (await c.targets.get('finance-lake'))!;
    expect(stored).toMatchObject({ connectionId: 'finance-account', sinkId: 's3', source: 'ui' });
    for (const hidden of ['secretKeyEnc', 'accessKeyId', 'endpoint']) {
      expect(Object.keys(stored)).not.toContain(hidden);
    }
    expect(c.bridge.targets.get('finance-lake')).toEqual({
      label: 'Finance lake',
      sinkId: 's3',
      instanceId: null,
      connectionId: 'finance-account',
      destination: {
        bucket: 'finance-lake',
        prefix: 'ingest/',
        sse: 'none',
        kmsKeyId: '',
        storageClass: '',
        layout: 'files',
      },
    });
  });

  it('bridge refusal leaves no row behind', async () => {
    const c = await setup();
    c.bridge.failNext = FakeBridgeApi.refusal('there is no connection gone', 'connection_missing');
    const res = await c.call('POST', '/publish-targets', externalBody({ connectionId: 'gone' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('there is no connection gone');
    expect(await c.targets.get('finance-lake')).toBeNull();

    c.bridge.failNext = new BridgeApiError(0, null, 'the bridge could not be reached');
    const down = await c.call('POST', '/publish-targets', externalBody());
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toBe('the delivery bridge could not be reached');
    expect(await c.targets.get('finance-lake')).toBeNull();
  });
});

describe('inert publishing targets (a copy restore)', () => {
  it('an inert target is not listed and is a 404', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget(), { source: 'ui', by: 'Ken' });
    await c.targets.makeInert('finance-lake');
    const list = (await c.call('GET', '/publish-targets')).json() as {
      targets: PublishTargetView[];
    };
    expect(list.targets.map((t) => t.id)).toEqual(['default']);
    const choices = (await c.call('GET', '/publish-targets/choices')).json() as {
      choices: { id: string }[];
    };
    expect(choices.choices.map((t) => t.id)).toEqual(['default']);
    for (const res of [
      await c.call('PATCH', '/publish-targets/finance-lake', { label: 'x' }),
      await c.call('DELETE', '/publish-targets/finance-lake'),
      await c.call('POST', '/publish-targets/test', { id: 'finance-lake' }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('publishing target not found');
    }
  });
});

describe('PATCH /api/publish-targets/:id', () => {
  it('is a 404 for an unknown target', async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/nope', { label: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('publishing target not found');
  });

  it('changes locked fields only while the target is not in use', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    const free = await c.call('PATCH', '/publish-targets/finance-lake', {
      bucket: 'finance-other',
      prefix: 'p',
    });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({ bucket: 'finance-other', prefix: 'p/' });

    await publishLetter(c, 1, 'finance-lake');
    for (const change of [{ bucket: 'finance-third' }, { prefix: 'q/' }]) {
      const res = await c.call('PATCH', '/publish-targets/finance-lake', change);
      expect([change, res.statusCode, res.json().error]).toEqual([
        change,
        409,
        'Finance lake is used by letter: add a new target instead',
      ]);
    }
    // The same value is no change; label, connection and options stay editable.
    c.bridge.summaries.push({
      id: 'finance-rotated',
      name: 'Finance (rotated)',
      sinkId: 's3',
      status: 'ok',
      statusReason: null,
      fields: {},
    });
    const same = await c.call('PATCH', '/publish-targets/finance-lake', {
      bucket: 'finance-other',
      prefix: 'p/',
      label: 'Finance',
      connectionId: 'finance-rotated',
      sse: 'AES256',
      storageClass: 'STANDARD_IA',
    });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({
      label: 'Finance',
      connectionId: 'finance-rotated',
      sse: 'AES256',
      storageClass: 'STANDARD_IA',
    });
    expect(c.bridge.targets.get('finance-lake')).toMatchObject({
      label: 'Finance',
      connectionId: 'finance-rotated',
      destination: { sse: 'AES256', storageClass: 'STANDARD_IA' },
    });
  });

  it('keeps fields a patch leaves out', async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/default', { label: 'Main' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: 'Main', bucket: 'published', prefix: 'pub/' });
    expect(c.bridge.targets.get('default')).toMatchObject({ label: 'Main' });
  });

  it('refuses external settings on an internal target', async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/default', { connectionId: 'x' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toContain(
      'internal targets take only a bucket and prefix',
    );
  });

  it('refuses credential fields', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    const res = await c.call('PATCH', '/publish-targets/finance-lake', {
      secretAccessKey: SECRET,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(SECRET);
  });

  it("refuses the bridge's staging bucket for an internal target", async () => {
    const c = await setup();
    const said = "ingest-bridge is the delivery bridge's staging bucket: pick another";
    const created = await c.call('POST', '/publish-targets', {
      label: 'Oops',
      kind: 'internal',
      bucket: 'ingest-bridge',
    });
    expect([created.statusCode, created.json().error]).toEqual([400, said]);
    const moved = await c.call('PATCH', '/publish-targets/default', { bucket: 'ingest-bridge' });
    expect([moved.statusCode, moved.json().error]).toEqual([400, said]);
    expect((await c.targets.get('default'))!.destination.bucket).toBe('published');
    const tested = await c.call('POST', '/publish-targets/test', {
      label: 'Oops',
      kind: 'internal',
      bucket: 'ingest-bridge',
    });
    expect([tested.statusCode, tested.json().error]).toEqual([400, said]);
    expect(c.bridge.tests).toEqual([]);
  });

  it("refuses moving an internal target onto CT Studio's own bucket", async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/default', { bucket: 'inbox' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("inbox is CT Studio's own inbox bucket: pick another");
    expect((await c.targets.get('default'))!.destination.bucket).toBe('published');
    const backups = await c.call('PATCH', '/publish-targets/default', { bucket: 'backups' });
    expect(backups.json().error).toBe("backups is CT Studio's own backups bucket: pick another");
  });

  it('clears optional settings with null, and the KMS key once encryption leaves KMS', async () => {
    const c = await setup();
    await c.call(
      'POST',
      '/publish-targets',
      externalBody({ sse: 'aws:kms', kmsKeyId: 'key-1', storageClass: 'STANDARD_IA' }),
    );
    await publishLetter(c, 1, 'finance-lake');
    const offKms = await c.call('PATCH', '/publish-targets/finance-lake', { sse: 'AES256' });
    expect(offKms.statusCode).toBe(200);
    expect(offKms.json()).toMatchObject({ sse: 'AES256', kmsKeyId: null });
    expect((await c.targets.get('finance-lake'))!.destination.kmsKeyId).toBe('');

    const cleared = await c.call('PATCH', '/publish-targets/finance-lake', { storageClass: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ storageClass: null, sse: 'AES256' });

    const kmsAgain = await c.call('PATCH', '/publish-targets/finance-lake', {
      sse: 'aws:kms',
      kmsKeyId: 'key-2',
    });
    expect(kmsAgain.json()).toMatchObject({ sse: 'aws:kms', kmsKeyId: 'key-2' });
    const noKey = await c.call('PATCH', '/publish-targets/finance-lake', { kmsKeyId: null });
    expect(noKey.json()).toMatchObject({ sse: 'aws:kms', kmsKeyId: null });

    // A KMS key without KMS is still refused when the patch asks for it.
    const bad = await c.call('PATCH', '/publish-targets/finance-lake', {
      sse: 'none',
      kmsKeyId: 'key-3',
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().error)).toContain('a KMS key needs sse');
  });

  it('keeps a prefix seeded verbatim from .env on other edits', async () => {
    const c = await setup();
    await cacheS3(c.targets, {
      id: 'default',
      label: 'Default',
      kind: 'internal',
      bucket: 'published',
      prefix: 'ingest',
    });
    const res = await c.call('PATCH', '/publish-targets/default', { label: 'Main' });
    expect(res.json()).toMatchObject({ label: 'Main', prefix: 'ingest' });
  });

  it('creates the new bucket of an internal target', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', {
      label: 'L',
      kind: 'internal',
      bucket: 'one-bucket',
    });
    const res = await c.call('PATCH', '/publish-targets/l', { bucket: 'two-bucket' });
    expect(res.statusCode).toBe(200);
    expect((c.targetStore as MemoryObjectStore).ensured).toEqual(['one-bucket', 'two-bucket']);
  });

  it('puts the row back when the bridge refuses the change', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    c.bridge.failNext = FakeBridgeApi.refusal('there is no connection gone', 'connection_missing');
    const res = await c.call('PATCH', '/publish-targets/finance-lake', {
      label: 'Renamed',
      connectionId: 'gone',
    });
    expect(res.statusCode).toBe(422);
    expect(await c.targets.get('finance-lake')).toMatchObject({
      label: 'Finance lake',
      connectionId: 'finance-account',
    });
  });
});

describe('DELETE /api/publish-targets/:id', () => {
  it('never removes the default; 404 for an unknown target', async () => {
    const c = await setup();
    const res = await c.call('DELETE', '/publish-targets/default');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('default cannot be removed');
    expect((await c.call('DELETE', '/publish-targets/nope')).statusCode).toBe(404);
  });

  it('names up to three document types using it', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
      await c.templates.create(id, 1, { ...letter(1, 'finance-lake'), id }, 'draft');
      await c.templates.publish(id, 1, 'Ken');
    }
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Finance lake is used by alpha, beta, delta and 1 more');
  });

  it('counts delivered outputs when no published version names it', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    c.repo.outputs.set('j1', [
      {
        outputId: 'document',
        stage: 'published',
        format: 'json',
        bucket: 'finance-lake',
        key: 'ingest/a.json',
        rowCount: null,
        targetId: 'finance-lake',
      },
    ]);
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Finance lake is used by 1 delivered output');
  });

  it('counts a withdrawal still to run that names it', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    const withdraw = (status: 'queued' | 'running' | 'succeeded') => ({
      id: `w-${status}`,
      task: 'withdraw' as const,
      priority: 0,
      maxAttempts: 100,
      params: {
        objects: [{ bucket: 'finance-lake', key: 'ingest/a.json', target: 'finance-lake' }],
        graphs: [],
      },
      status,
      createdBy: null,
    });
    c.repo.backgroundJobs.push(withdraw('succeeded'));
    expect((await c.targets.usage('finance-lake')).pendingJobs).toBe(0);
    c.repo.backgroundJobs.push(withdraw('queued'), withdraw('running'));
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Finance lake is used by 2 pending withdrawals');
  });

  it('removes an unused target, on the bridge too', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    expect(c.bridge.targets.has('finance-lake')).toBe(true);
    expect((await c.call('DELETE', '/publish-targets/finance-lake')).statusCode).toBe(204);
    expect(await c.targets.get('finance-lake')).toBeNull();
    expect(c.bridge.targets.has('finance-lake')).toBe(false);
  });

  it('names a new target past the id of a removed one', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    expect((await c.call('DELETE', '/publish-targets/finance-lake')).statusCode).toBe(204);
    const again = await c.call('POST', '/publish-targets', externalBody());
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe('finance-lake-2');
  });

  it('keeps a target the bridge still has deliveries for', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    c.bridge.inUse.add('finance-lake');
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Finance lake has deliveries on the bridge');
    expect(await c.targets.get('finance-lake')).not.toBeNull();
  });

  it('never removes from the bridge a target used meanwhile', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    // Named by a recipe after the route's own usage check: the removal's check, which holds the
    // row while the bridge is asked, still sees it, so the bridge is never asked (a removed
    // target's id could not be put back there).
    await c.templates.create('alpha', 1, { ...letter(1, 'finance-lake'), id: 'alpha' }, 'draft');
    await c.templates.publish('alpha', 1, 'Ken');
    vi.spyOn(c.targets, 'usage').mockResolvedValueOnce({
      publishedVersions: 0,
      documentTypes: [],
      deliveredOutputs: 0,
      consumers: 0,
      pendingJobs: 0,
    });
    const deleted = vi.spyOn(c.bridge, 'deleteTarget');
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Finance lake is used by alpha');
    expect(deleted).not.toHaveBeenCalled();
    expect(c.bridge.targets.has('finance-lake')).toBe(true);
    expect(await c.targets.get('finance-lake')).not.toBeNull();
  });

  it('says so when the bridge removed it but the cache could not, and a second delete heals it', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    vi.spyOn(c.targets, 'makeInert').mockImplementationOnce(() => {
      throw new Error('the database went away');
    });
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('removed on the bridge; remove again');
    expect(c.bridge.removed.has('finance-lake')).toBe(true);
    expect(await c.targets.get('finance-lake')).not.toBeNull();
    expect((await c.call('DELETE', '/publish-targets/finance-lake')).statusCode).toBe(204);
    expect(await c.targets.get('finance-lake')).toBeNull();
  });

  it('says it may be removed on the bridge when the bridge did not answer in time', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    vi.spyOn(c.bridge, 'deleteTarget').mockRejectedValueOnce(
      new BridgeApiError(0, null, 'the bridge did not answer in time', true),
    );
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('removed on the bridge; remove again');
    expect(await c.targets.get('finance-lake')).not.toBeNull();
  });

  it('removes nothing while the bridge cannot be reached', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    vi.spyOn(c.bridge, 'deleteTarget').mockRejectedValueOnce(new Error('bridge went away'));
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(502);
    expect(await c.targets.get('finance-lake')).not.toBeNull();
    expect(c.bridge.targets.has('finance-lake')).toBe(true);
  });
});

describe('POST /api/publish-targets/test', () => {
  it('test proxies to the bridge and returns its step and message', async () => {
    const c = await setup();
    c.bridge.testResult = { ok: false, step: 'write', message: 'access denied' };
    const saved = await c.call('POST', '/publish-targets/test', { id: 'default' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ok: false, step: 'write', message: 'access denied' });
    expect(c.bridge.tests).toEqual([{ id: 'default' }]);

    const unsaved = await c.call('POST', '/publish-targets/test', externalBody());
    expect(unsaved.json()).toEqual({ ok: false, step: 'write', message: 'access denied' });
    expect(c.bridge.tests.at(-1)).toEqual({
      connectionId: 'finance-account',
      destination: {
        bucket: 'finance-lake',
        prefix: 'ingest/',
        sse: 'none',
        kmsKeyId: '',
        storageClass: '',
        layout: 'files',
      },
    });

    await c.call('POST', '/publish-targets/test', { kind: 'internal', bucket: 'new-archive' });
    expect(c.bridge.tests.at(-1)).toMatchObject({
      connectionId: 'internal',
      destination: { bucket: 'new-archive', prefix: '' },
    });
  });

  it('is a failed connect step when the bridge cannot be reached', async () => {
    const c = await setup();
    c.bridge.failNext = new BridgeApiError(0, null, 'the bridge could not be reached');
    const res = await c.call('POST', '/publish-targets/test', { id: 'default' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      step: 'connect',
      message: 'the delivery bridge could not be reached',
    });
  });

  it('is a 404 for an unknown target, and 400 for settings that cannot be saved', async () => {
    const c = await setup();
    expect((await c.call('POST', '/publish-targets/test', { id: 'nope' })).statusCode).toBe(404);
    const bad = await c.call('POST', '/publish-targets/test', { bucket: 'b' });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses to test CT Studio's own bucket as an internal target", async () => {
    const c = await setup();
    for (const bucket of ['runs', 'backups']) {
      const res = await c.call('POST', '/publish-targets/test', {
        label: 'Oops',
        kind: 'internal',
        bucket,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(`${bucket} is CT Studio's own ${bucket} bucket: pick another`);
    }
    expect(c.bridge.tests).toEqual([]);
  });
});

const published = (jobId: string, targetId: string, bucket: string, prefix: string): JobOutput => ({
  outputId: 'document',
  stage: 'published',
  format: 'json',
  bucket,
  key: `${prefix}tdemo/v1/document/${jobId}.json`,
  rowCount: null,
  targetId,
});

describe('reading published outputs through the bridge, from their recorded target', () => {
  async function delivered(c: Awaited<ReturnType<typeof setup>>) {
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'tdemo' }, { filename: 'a.pdf', content: fakePdf }),
    });
    const job = res.json() as JobSummary;
    c.repo.jobs.set(job.id, { ...c.repo.jobs.get(job.id)!, status: 'succeeded' });
    return job;
  }

  it('serves each output from its own target', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    await c.mirror();
    const a = await delivered(c);
    const b = await delivered(c);
    const onFinance = published(a.id, 'finance-lake', 'finance-lake', 'ingest/');
    const onDefault = published(b.id, 'default', 'published', 'pub/');
    c.repo.outputs.set(a.id, [onFinance]);
    c.repo.outputs.set(b.id, [onDefault]);
    c.bridge.put('finance-lake', 'finance-lake', onFinance.key, 'finance');
    c.bridge.put('default', 'published', onDefault.key, 'default');

    expect((await c.app.inject(`/api/jobs/${a.id}/outputs/document`)).body).toBe('finance');
    expect((await c.app.inject(`/api/jobs/${b.id}/outputs/document`)).body).toBe('default');
    const detail = (await c.app.inject(`/api/results/${a.id}`)).json();
    expect(detail.target).toEqual({
      id: 'finance-lake',
      label: 'Finance lake',
      bucket: 'finance-lake',
      prefix: 'ingest/',
    });
  });

  it('answers 502 naming the target when the bridge cannot read it, and still shows the result', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    c.bridge.failReads = new BridgeApiError(0, null, 'the bridge could not be reached');
    const a = await delivered(c);
    c.repo.outputs.set(a.id, [published(a.id, 'finance-lake', 'finance-lake', 'ingest/')]);
    for (const url of [`/api/jobs/${a.id}/outputs/document`, `/api/results/${a.id}/archive`]) {
      const res = await c.app.inject(url);
      expect([url, res.statusCode, res.json()]).toEqual([
        url,
        502,
        { error: 'publishing target Finance lake unavailable' },
      ]);
    }
    const detail = await c.app.inject(`/api/results/${a.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      documentError: 'target storage unavailable',
      outputs: [expect.objectContaining({ targetId: 'finance-lake' })],
    });
  });

  it('answers 502 when the bridge refuses the target (no connection)', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    c.bridge.failReads = FakeBridgeApi.refusal(
      'the target has no connection',
      'credential_missing',
    );
    const a = await delivered(c);
    c.repo.outputs.set(a.id, [published(a.id, 'finance-lake', 'finance-lake', 'ingest/')]);
    const res = await c.app.inject(`/api/jobs/${a.id}/outputs/document`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('publishing target Finance lake unavailable');
  });
});

describe('a recipe naming a publishing target', () => {
  const issuesOf = async (c: Awaited<ReturnType<typeof setup>>, version: number) =>
    (await c.call('GET', `/templates/letter/versions/${version}`)).json().issues as {
      path: string;
      message: string;
    }[];

  it('is a publishing issue when this deployment has no such target', async () => {
    const c = await setup();
    await c.templates.create('letter', 1, letter(1, 'nope'), 'draft');
    expect(await issuesOf(c, 1)).toEqual([
      { path: 'delivery.publishTo', message: 'no publishing target nope on this deployment' },
    ]);
    const publish = await c.call('POST', '/templates/letter/versions/1/publish', {});
    expect(publish.statusCode).toBe(400);
    expect((await c.templates.get('letter', 1))!.status).toBe('draft');
  });

  it('is fine when the target exists, or when none is named', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget());
    await c.templates.create('letter', 1, letter(1, 'finance-lake'), 'draft');
    expect(await issuesOf(c, 1)).toEqual([]);
    await c.templates.create('letter', 2, letter(2), 'draft');
    expect(await issuesOf(c, 2)).toEqual([]);
  });

  it('keeps the id of a YAML import and shows the issue', async () => {
    const c = await setup();
    const yaml = JSON.stringify(letter(3, 'finance-lake'));
    const imported = await c.call('POST', '/templates/import', { yaml });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().record.definition.delivery).toEqual({ publishTo: 'finance-lake' });
    expect(imported.json().issues).toEqual([
      {
        path: 'delivery.publishTo',
        message: 'no publishing target finance-lake on this deployment',
      },
    ]);
    const straight = await c.call('POST', '/templates/import', {
      yaml: JSON.stringify({ ...letter(4, 'finance-lake'), id: 'memo' }),
      publish: true,
    });
    expect(straight.statusCode).toBe(400);
  });
});

describe('the triple store target (rdf-default, from RDF_ENDPOINT)', () => {
  const seeded = async () => {
    const c = await setup();
    await seedRdfOnBridge(
      { targets: c.targets, bridge: c.bridge, log: c.app.log },
      { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' },
    );
    return c;
  };

  it('is listed with its endpoint, dataset and connection', async () => {
    const c = await seeded();
    c.bridge.summaries.push({
      id: 'rdf-default',
      name: 'Triple store',
      sinkId: 'rdf',
      status: 'ok',
      statusReason: null,
      fields: { endpoint: 'http://fuseki:3030', user: 'ct-writer' },
    });
    const targets = (await c.call('GET', '/publish-targets')).json().targets as PublishTargetView[];
    expect(targets.find((t) => t.id === 'rdf-default')).toMatchObject({
      label: 'Triple store',
      kind: 'rdf',
      bucket: 'ct',
      endpoint: 'http://fuseki:3030',
      connection: { id: 'rdf-default', name: 'Triple store', status: 'ok', statusReason: null },
    });
    const picker = (await c.call('GET', '/publish-targets/connections')).json();
    expect(JSON.stringify(picker)).not.toContain('rdf-default');
  });

  it('cannot be created', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', {
      label: 'Another store',
      kind: 'rdf',
      bucket: 'kb',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toContain(
      'triple store targets come from RDF_ENDPOINT',
    );
  });

  it('takes a new label, mirrored, and nothing else', async () => {
    const c = await seeded();
    const renamed = await c.call('PATCH', '/publish-targets/rdf-default', {
      label: 'Knowledge graph',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ label: 'Knowledge graph', kind: 'rdf' });
    expect(c.bridge.targets.get('rdf-default')).toMatchObject({
      label: 'Knowledge graph',
      sinkId: 'rdf',
      destination: { dataset: 'ct' },
    });
    const moved = await c.call('PATCH', '/publish-targets/rdf-default', { bucket: 'other-ds' });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toBe('the triple store target takes a label only');
  });

  it('is never removed', async () => {
    const c = await seeded();
    const res = await c.call('DELETE', '/publish-targets/rdf-default');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Triple store comes from RDF_ENDPOINT');
  });

  it('is no recipe target', async () => {
    const c = await seeded();
    await c.templates.create('letter', 1, letter(1, 'rdf-default'), 'draft');
    const issues = (await c.call('GET', '/templates/letter/versions/1')).json().issues;
    expect(issues).toEqual([
      {
        path: 'delivery.publishTo',
        message: 'rdf-default is a triple store: name an S3 target',
      },
    ]);
    const choices = (await c.call('GET', '/publish-targets/choices')).json();
    expect(JSON.stringify(choices)).not.toContain('rdf-default');
  });
});

describe('a target layout (files, or package for archives)', () => {
  it('creates a target with layout package, mirrored; files when none is given', async () => {
    const c = await setup();
    const archive = await c.call('POST', '/publish-targets', {
      label: 'Archive',
      kind: 'internal',
      bucket: 'archive-bucket',
      layout: 'package',
    });
    expect(archive.statusCode).toBe(201);
    expect(archive.json()).toMatchObject({ id: 'archive', layout: 'package' });
    expect(c.bridge.targets.get('archive')).toMatchObject({
      destination: { bucket: 'archive-bucket', layout: 'package' },
    });
    const plain = await c.call('POST', '/publish-targets', externalBody());
    expect(plain.json()).toMatchObject({ layout: 'files' });
    expect(c.bridge.targets.get('finance-lake')).toMatchObject({
      destination: { layout: 'files' },
    });
  });

  it('refuses an unknown layout', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', externalBody({ layout: 'zip' }));
    expect(res.statusCode).toBe(400);
  });

  it('layout is locked while a recipe names the target', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    const free = await c.call('PATCH', '/publish-targets/finance-lake', { layout: 'package' });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({ layout: 'package' });

    await publishLetter(c, 1, ['default', 'finance-lake']);
    const res = await c.call('PATCH', '/publish-targets/finance-lake', { layout: 'files' });
    expect([res.statusCode, res.json().error]).toEqual([
      409,
      'Finance lake is used by letter: add a new target instead',
    ]);
  });

  it('a target is in use when a list names it, and cannot be removed', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    await publishLetter(c, 1, ['default', 'finance-lake']);
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
  });

  it('a target is in use while an archive row records it', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody({ layout: 'package' }));
    const job = (
      await c.app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart({ specId: 'tdemo' }, { filename: 'a.pdf', content: fakePdf }),
      })
    ).json();
    c.repo.outputs.set(job.id, [
      {
        outputId: 'package:manifest',
        stage: 'published',
        format: 'json',
        bucket: 'finance-lake',
        key: 'ingest/packages/k/package.json',
        rowCount: null,
        targetId: 'finance-lake',
        isPrimary: false,
      },
    ]);
    const res = await c.call('DELETE', '/publish-targets/finance-lake');
    expect(res.statusCode).toBe(409);
  });

  it('an rdf target refuses layout package', async () => {
    const c = await setup();
    await seedRdfOnBridge(
      { targets: c.targets, bridge: c.bridge, log: c.app.log },
      { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' },
    );
    const res = await c.call('PATCH', '/publish-targets/rdf-default', { layout: 'package' });
    expect([res.statusCode, res.json().error]).toEqual([
      400,
      'the triple store target takes a label only',
    ]);
  });

  it('offers each choice with its prefix and layout', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody({ layout: 'package' }));
    const res = await c.call('GET', '/publish-targets/choices');
    expect(res.json().choices).toContainEqual(
      expect.objectContaining({ id: 'finance-lake', prefix: 'ingest/', layout: 'package' }),
    );
  });
});

describe('a recipe naming several publishing targets', () => {
  const issuesOf = async (c: Awaited<ReturnType<typeof setup>>, version: number) =>
    (await c.call('GET', `/templates/letter/versions/${version}`)).json().issues as {
      path: string;
      message: string;
    }[];

  it('names each unknown id in a list', async () => {
    const c = await setup();
    await c.templates.create('letter', 1, letter(1, ['default', 'nope', 'gone']), 'draft');
    expect(await issuesOf(c, 1)).toEqual([
      { path: 'delivery.publishTo', message: 'no publishing target nope on this deployment' },
      { path: 'delivery.publishTo', message: 'no publishing target gone on this deployment' },
    ]);
  });

  it('refuses the triple store in a list', async () => {
    const c = await setup();
    await seedRdfOnBridge(
      { targets: c.targets, bridge: c.bridge, log: c.app.log },
      { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' },
    );
    await c.templates.create('letter', 1, letter(1, ['default', 'rdf-default']), 'draft');
    expect(await issuesOf(c, 1)).toEqual([
      { path: 'delivery.publishTo', message: 'rdf-default is a triple store: name an S3 target' },
    ]);
  });

  it('takes a target of another sink beside an S3 one', async () => {
    const c = await setup();
    await c.targets.cache(
      {
        id: 'box',
        label: 'Box',
        sinkId: 'fake',
        instanceId: null,
        connectionId: null,
        destination: { space: 'prod' },
      },
      { source: 'ui' },
    );
    await c.templates.create('letter', 1, letter(1, ['default', 'box']), 'draft');
    expect(await issuesOf(c, 1)).toEqual([]);
  });

  it('asks for a files target when every listed target is an archive', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget({ layout: 'package' }));
    await c.templates.create('letter', 1, letter(1, ['finance-lake']), 'draft');
    expect(await issuesOf(c, 1)).toEqual([
      { path: 'delivery.publishTo', message: 'needs a target with the files layout' },
    ]);
    await c.templates.create('letter', 2, letter(2, ['finance-lake', 'default']), 'draft');
    expect(await issuesOf(c, 2)).toEqual([]);
  });
});

describe('the bridge is authoritative; the cache follows', () => {
  it('a locked change is refused before the bridge is asked', async () => {
    const c = await setup();
    await c.call('POST', '/publish-targets', externalBody());
    await publishLetter(c, 1, 'finance-lake');
    const puts = c.bridge.targetPuts;
    const res = await c.call('PATCH', '/publish-targets/finance-lake', { bucket: 'elsewhere' });
    expect(res.statusCode).toBe(409);
    expect(c.bridge.targetPuts).toBe(puts);
    expect(c.bridge.targets.get('finance-lake')!.destination).toMatchObject({
      bucket: 'finance-lake',
    });
  });

  it('with the bridge down, the list is the cache and writes change nothing', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget(), { source: 'ui', by: 'Ken' });
    const before = JSON.stringify(await c.targets.list());
    c.bridge.failReads = new BridgeApiError(0, null, 'the bridge could not be reached');
    const list = await c.call('GET', '/publish-targets');
    expect(list.statusCode).toBe(200);
    expect((list.json() as { targets: PublishTargetView[] }).targets.map((t) => t.id)).toEqual([
      'default',
      'finance-lake',
    ]);
    for (const [method, url, payload] of [
      ['POST', '/publish-targets', externalBody({ label: 'Another' })],
      ['PATCH', '/publish-targets/finance-lake', { label: 'Renamed' }],
    ] as const) {
      c.bridge.failNext = new BridgeApiError(0, null, 'the bridge could not be reached');
      const res = await c.call(method, url, payload);
      expect([url, res.statusCode]).toEqual([url, 502]);
    }
    c.bridge.failReads = null;
    expect(JSON.stringify(await c.targets.list())).toBe(before);
  });

  it('a cache write that fails after the bridge accepted answers 500 saved on the bridge; refresh, and the next pull heals it', async () => {
    const c = await setup();
    const real = c.targets.cache.bind(c.targets);
    c.targets.cache = async () => {
      throw new Error('database is down');
    };
    const res = await c.call('POST', '/publish-targets', externalBody());
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('saved on the bridge; refresh');
    expect(c.bridge.targets.has('finance-lake')).toBe(true);
    expect(await c.targets.get('finance-lake')).toBeNull();

    c.targets.cache = real;
    await pullTargets({ targets: c.targets, bridge: c.bridge, log: c.app.log });
    expect(await c.targets.get('finance-lake')).toMatchObject({ label: 'Finance lake' });
  });

  it('a target not on the bridge is listed with onBridge false', async () => {
    const c = await setup();
    await cacheS3(c.targets, financeTarget(), { source: 'ui', by: 'Ken' });
    await pullTargets({ targets: c.targets, bridge: c.bridge, log: c.app.log });
    const res = await c.call('GET', '/publish-targets');
    const { targets } = res.json() as { targets: PublishTargetView[] };
    expect(targets.find((t) => t.id === 'finance-lake')).toMatchObject({ onBridge: false });
  });
});
