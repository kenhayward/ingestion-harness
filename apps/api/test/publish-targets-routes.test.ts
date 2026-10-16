import { describe, expect, it } from 'vitest';
import type { JobOutput, JobSummary, PublishTargetView } from '@ih/shared';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import type { NewTarget } from '../src/publish-targets/repo.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { accessApp, fakePdf, multipart, signInNewUser, testApp } from './helpers.js';

const keys: SecretsKeys = { current: Buffer.alloc(32, 7), previous: null };
const SECRET = 'wJalrXUtnFEMI-very-secret';
const FINANCE_ENDPOINT = 'https://s3.finance.example';

const externalBody = (over: object = {}) => ({
  label: 'Finance lake',
  kind: 'external',
  bucket: 'finance-lake',
  prefix: 'ingest',
  endpoint: FINANCE_ENDPOINT,
  region: 'eu-west-2',
  accessKeyId: 'AKIAFINANCE',
  secretAccessKey: SECRET,
  ...over,
});

/** A stored external target, as a create through the route would leave it. */
const financeRecord = (over: Partial<NewTarget> = {}): NewTarget => ({
  id: 'finance-lake',
  label: 'Finance lake',
  kind: 'external',
  bucket: 'finance-lake',
  prefix: 'ingest/',
  endpoint: FINANCE_ENDPOINT,
  region: 'eu-west-2',
  accessKeyId: 'AKIAFINANCE',
  secretKeyEnc: encryptSecret(SECRET, keys),
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: true,
  sse: 'none',
  kmsKeyId: null,
  storageClass: null,
  ...over,
});

const letter = (version: number, publishTo?: string) => ({
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
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    ctx.app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}) });
  return { ...ctx, call };
}

/** A recipe version published naming `publishTo` (so the target is in use). */
async function publishLetter(
  ctx: Awaited<ReturnType<typeof setup>>,
  version: number,
  publishTo?: string,
) {
  await ctx.templates.create('letter', version, letter(version, publishTo), 'draft');
  await ctx.templates.publish('letter', version, 'Ken');
}

describe('publishing target routes: list and choices', () => {
  it('lists the default with its usage, never a secret', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), 'Ken');
    const res = await c.call('GET', '/publish-targets');
    expect(res.statusCode).toBe(200);
    const { targets } = res.json() as { targets: PublishTargetView[] };
    expect(targets.map((t) => t.id)).toEqual(['default', 'finance-lake']);
    expect(targets[1]).toMatchObject({ secretSet: true, accessKeyId: 'AKIAFINANCE' });
    expect(targets[1]!.usage).toEqual({
      publishedVersions: 0,
      documentTypes: [],
      deliveredOutputs: 0,
      consumers: 0,
      pendingJobs: 0,
    });
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('secretKeyEnc');
  });

  it('offers choices to designers; the rest is admin-only', async () => {
    const { app, adminCookie, userCookie } = await accessApp();
    const choices = await app.inject({
      url: '/api/publish-targets/choices',
      headers: { cookie: userCookie },
    });
    expect(choices.statusCode).toBe(200);
    expect(choices.json()).toEqual({
      choices: [{ id: 'default', label: 'Default', kind: 'internal', bucket: 'published' }],
    });
    const calls = [
      { method: 'GET' as const, url: '/api/publish-targets' },
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

describe('POST /api/publish-targets', () => {
  it('adds an internal target, creating its bucket, with an id made from the label', async () => {
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
      secretSet: false,
    });
    expect((c.targetStore as MemoryObjectStore).ensured).toEqual(['finance-bucket']);
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
    for (const bucket of ['inbox', 'outputs', 'runs']) {
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
    const res = await c.call('POST', '/publish-targets', externalBody({ region: undefined }));
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toContain('an external target needs a region');
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

  it('encrypts an external secret and never returns it', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets', externalBody());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'finance-lake', secretSet: true, prefix: 'ingest/' });
    expect(res.body).not.toContain(SECRET);
    const stored = (await c.targets.get('finance-lake'))!;
    expect(stored.secretKeyEnc).toMatch(/^v1:/);
    expect(stored.secretKeyEnc).not.toContain(SECRET);
  });

  it('is a 409 without LLM_SECRETS_KEY', async () => {
    const c = await setup(false);
    const res = await c.call('POST', '/publish-targets', externalBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('LLM_SECRETS_KEY is not set: the API cannot store keys');
    expect((await c.targets.list()).map((t) => t.id)).toEqual(['default']);
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
    await c.targets.create(financeRecord(), 'Ken');
    const free = await c.call('PATCH', '/publish-targets/finance-lake', {
      bucket: 'finance-other',
      prefix: 'p',
    });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({ bucket: 'finance-other', prefix: 'p/' });

    await publishLetter(c, 1, 'finance-lake');
    for (const change of [
      { bucket: 'finance-third' },
      { prefix: 'q/' },
      { endpoint: 'https://s3.other.example' },
      { region: 'us-east-1' },
    ]) {
      const res = await c.call('PATCH', '/publish-targets/finance-lake', change);
      expect([change, res.statusCode, res.json().error]).toEqual([
        change,
        409,
        'Finance lake is used by letter: add a new target instead',
      ]);
    }
    // The same value is no change; label, credentials and options stay editable.
    const same = await c.call('PATCH', '/publish-targets/finance-lake', {
      bucket: 'finance-other',
      prefix: 'p/',
      label: 'Finance',
      accessKeyId: 'AKIANEW',
      secretAccessKey: 'rotated-secret',
      sse: 'AES256',
      storageClass: 'STANDARD_IA',
    });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({
      label: 'Finance',
      accessKeyId: 'AKIANEW',
      sse: 'AES256',
      storageClass: 'STANDARD_IA',
    });
    expect(same.body).not.toContain('rotated-secret');
  });

  it('keeps fields a patch leaves out', async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/default', { label: 'Main' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: 'Main', bucket: 'published', prefix: 'pub/' });
  });

  it('refuses external settings on an internal target', async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/default', { region: 'eu-west-2' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toContain(
      'internal targets take only a bucket and prefix',
    );
  });

  it("refuses moving an internal target onto CT Studio's own bucket", async () => {
    const c = await setup();
    const res = await c.call('PATCH', '/publish-targets/default', { bucket: 'inbox' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("inbox is CT Studio's own inbox bucket: pick another");
    expect((await c.targets.get('default'))!.bucket).toBe('published');
  });

  it('clears optional settings with null, and the KMS key once encryption leaves KMS', async () => {
    const c = await setup();
    await c.targets.create(
      financeRecord({ sse: 'aws:kms', kmsKeyId: 'key-1', storageClass: 'STANDARD_IA' }),
      'Ken',
    );
    await publishLetter(c, 1, 'finance-lake');
    const offKms = await c.call('PATCH', '/publish-targets/finance-lake', { sse: 'AES256' });
    expect(offKms.statusCode).toBe(200);
    expect(offKms.json()).toMatchObject({ sse: 'AES256', kmsKeyId: null });
    expect((await c.targets.get('finance-lake'))!.kmsKeyId).toBeNull();

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

  it('clears the endpoint of a target not in use, never of one in use', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), 'Ken');
    const res = await c.call('PATCH', '/publish-targets/finance-lake', { endpoint: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ endpoint: null });
    await c.call('PATCH', '/publish-targets/finance-lake', { endpoint: FINANCE_ENDPOINT });
    await publishLetter(c, 1, 'finance-lake');
    const locked = await c.call('PATCH', '/publish-targets/finance-lake', { endpoint: null });
    expect(locked.statusCode).toBe(409);
  });

  it('keeps a prefix seeded verbatim from .env on other edits', async () => {
    const c = await setup();
    await c.targets.update('default', { prefix: 'ingest' }, null);
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

  it('replaces keys read from .env only as a pair', async () => {
    const c = await setup();
    await c.targets.create(
      financeRecord({
        accessKeyId: null,
        secretKeyEnc: null,
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'TARGET_S3_SECRET_KEY',
      }),
      null,
    );
    for (const half of [{ accessKeyId: 'AKIANEW' }, { secretAccessKey: 'new-secret' }]) {
      const res = await c.call('PATCH', '/publish-targets/finance-lake', half);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('set the access key and the secret together');
    }
    const both = await c.call('PATCH', '/publish-targets/finance-lake', {
      accessKeyId: 'AKIANEW',
      secretAccessKey: 'new-secret',
    });
    expect(both.statusCode).toBe(200);
    expect(both.json()).toMatchObject({
      accessKeyId: 'AKIANEW',
      secretSet: true,
      keysFromEnv: null,
    });
  });

  it('is a 409 for a secret without LLM_SECRETS_KEY', async () => {
    const c = await setup(false);
    await c.targets.create(financeRecord({ secretKeyEnc: null }), null);
    const res = await c.call('PATCH', '/publish-targets/finance-lake', { secretAccessKey: 'x' });
    expect(res.statusCode).toBe(409);
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
    await c.targets.create(financeRecord(), null);
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
    await c.targets.create(financeRecord(), null);
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
    await c.targets.create(financeRecord(), null);
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

  it('removes an unused target', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), null);
    expect((await c.call('DELETE', '/publish-targets/finance-lake')).statusCode).toBe(204);
    expect(await c.targets.get('finance-lake')).toBeNull();
  });
});

class FailingStore extends MemoryObjectStore {
  override async put(): Promise<void> {
    throw Object.assign(new Error(`denied for ${SECRET}`), { name: 'AccessDenied' });
  }
}

/** Remembers the keys written. */
class RecordingStore extends MemoryObjectStore {
  readonly keys: string[] = [];
  override async put(bucket: string, key: string, body: Buffer, type: string): Promise<void> {
    this.keys.push(key);
    return super.put(bucket, key, body, type);
  }
}

/** A bucket HEAD answers 404 for, as AWS and SeaweedFS do for a missing bucket. */
class MissingBucketStore extends MemoryObjectStore {
  override async ping(): Promise<void> {
    throw Object.assign(new Error('not found'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
  }
}

describe('POST /api/publish-targets/test', () => {
  it('tests settings before saving', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets/test', externalBody());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      step: null,
      message: 'Connected: wrote, read and deleted a test file',
    });
    expect(c.targetOptions.at(-1)).toMatchObject({
      endpoint: FINANCE_ENDPOINT,
      accessKeyId: 'AKIAFINANCE',
      secretAccessKey: SECRET,
    });
    expect(res.body).not.toContain(SECRET);
  });

  it('tests a stored target with its stored secret, overlaid with the body', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), null);
    const res = await c.call('POST', '/publish-targets/test', {
      id: 'finance-lake',
      accessKeyId: 'AKIAOTHER',
    });
    expect(res.json().ok).toBe(true);
    expect(c.targetOptions.at(-1)).toMatchObject({
      accessKeyId: 'AKIAOTHER',
      secretAccessKey: SECRET,
    });
    await c.call('POST', '/publish-targets/test', { id: 'finance-lake', secretAccessKey: 'typed' });
    expect(c.targetOptions.at(-1)).toMatchObject({ secretAccessKey: 'typed' });
  });

  it('validates the merged settings', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets/test', { id: 'default', region: 'r' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toContain(
      'internal targets take only a bucket and prefix',
    );
    expect((await c.call('POST', '/publish-targets/test', { id: 'nope' })).statusCode).toBe(404);
  });

  it('reports a failing step as ok: false, never echoing the secret', async () => {
    const c = await setup();
    c.endpointStores.set(FINANCE_ENDPOINT, new FailingStore());
    const res = await c.call('POST', '/publish-targets/test', externalBody());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, step: 'write', message: 'access denied' });
    expect(res.body).not.toContain(SECRET);
  });

  it('says no such bucket for an external target whose bucket is missing', async () => {
    const c = await setup();
    const store = new MissingBucketStore();
    c.endpointStores.set(FINANCE_ENDPOINT, store);
    const res = await c.call('POST', '/publish-targets/test', externalBody());
    expect(res.json()).toEqual({ ok: false, step: 'connect', message: 'no such bucket' });
    expect(store.objects.size).toBe(0);
  });

  // Saving an internal target creates its bucket, so testing it first must not fail on that.
  it('does not check the bucket of an internal target (saving creates it)', async () => {
    const c = await testApp({ llmSecrets: keys, targetStore: new MissingBucketStore() });
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets/test',
      payload: { label: 'Archive', kind: 'internal', bucket: 'new-archive', prefix: '' },
    });
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('tests a stored target with the same null clears and KMS rule as a save', async () => {
    const c = await setup();
    await c.targets.create(
      financeRecord({ sse: 'aws:kms', kmsKeyId: 'key-1', storageClass: 'STANDARD_IA' }),
      null,
    );
    const res = await c.call('POST', '/publish-targets/test', {
      id: 'finance-lake',
      sse: 'AES256',
      storageClass: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("refuses to test CT Studio's own bucket as an internal target", async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets/test', {
      label: 'Oops',
      kind: 'internal',
      bucket: 'runs',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("runs is CT Studio's own runs bucket: pick another");
    const overlay = await c.call('POST', '/publish-targets/test', {
      id: 'default',
      bucket: 'outputs',
    });
    expect(overlay.statusCode).toBe(400);
  });

  it('tests a prefix seeded verbatim from .env where it delivers', async () => {
    const store = new RecordingStore();
    const c = await testApp({ llmSecrets: keys, targetStore: store });
    await c.targets.update('default', { prefix: 'ingest' }, null);
    await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets/test',
      payload: { id: 'default' },
    });
    expect(store.keys.length).toBeGreaterThan(0);
    for (const key of store.keys) {
      expect([key, key.startsWith('ingest') && !key.startsWith('ingest/')]).toEqual([key, true]);
    }
  });

  it('tests the internal default', async () => {
    const c = await setup();
    const res = await c.call('POST', '/publish-targets/test', { id: 'default' });
    expect(res.json()).toMatchObject({ ok: true });
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

class Unreachable extends MemoryObjectStore {
  override async get(): Promise<Buffer | null> {
    throw new Error('connect ECONNREFUSED');
  }
}

describe('reading published outputs from their recorded target', () => {
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
  const doc = Buffer.from(JSON.stringify({ document_id: 'd', fields: {} }));

  it('serves each output from its own target', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), null);
    const finance = new MemoryObjectStore();
    c.endpointStores.set(FINANCE_ENDPOINT, finance);
    const a = await delivered(c);
    const b = await delivered(c);
    const onFinance = published(a.id, 'finance-lake', 'finance-lake', 'ingest/');
    const onDefault = published(b.id, 'default', 'published', 'pub/');
    c.repo.outputs.set(a.id, [onFinance]);
    c.repo.outputs.set(b.id, [onDefault]);
    await finance.put('finance-lake', onFinance.key, Buffer.from('finance'), 'application/json');
    await c.targetStore.put('published', onDefault.key, Buffer.from('default'), 'application/json');

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

  it('reads with the rotated credentials at once', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), null);
    const finance = new MemoryObjectStore();
    c.endpointStores.set(FINANCE_ENDPOINT, finance);
    const a = await delivered(c);
    const out = published(a.id, 'finance-lake', 'finance-lake', 'ingest/');
    c.repo.outputs.set(a.id, [out]);
    await finance.put('finance-lake', out.key, doc, 'application/json');
    expect((await c.app.inject(`/api/jobs/${a.id}/outputs/document`)).statusCode).toBe(200);

    const rotated = await c.call('PATCH', '/publish-targets/finance-lake', {
      accessKeyId: 'AKIAROTATED',
      secretAccessKey: 'rotated-secret',
    });
    expect(rotated.statusCode).toBe(200);
    const read = await c.app.inject(`/api/jobs/${a.id}/outputs/document`);
    expect(read.statusCode).toBe(200);
    expect(c.targetOptions.at(-1)).toMatchObject({
      accessKeyId: 'AKIAROTATED',
      secretAccessKey: 'rotated-secret',
    });
  });

  it('answers 502 naming the target when it cannot be reached, and still shows the result', async () => {
    const c = await setup();
    await c.targets.create(financeRecord(), null);
    c.endpointStores.set(FINANCE_ENDPOINT, new Unreachable());
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

  it('answers 502 when the target cannot be used', async () => {
    const c = await setup(false); // no master key: the stored secret cannot be decrypted
    await c.targets.create(financeRecord(), null);
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
    await c.targets.create(financeRecord(), null);
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
