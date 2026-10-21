import { randomUUID } from 'node:crypto';
import { signRequest, type BridgeEvent, type DeliveryView } from '@ih/bridge-contract';
import type { JobSummary } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/bridge/events.js';
import { reconcileOnce } from '../src/bridge/reconcile.js';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import { MemoryRepo } from '../src/repositories/memory.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { fakePdf, multipart, testApp, TEST_BRIDGE_KEY } from './helpers.js';

const T0 = new Date('2026-10-20T10:00:00.000Z');

async function setup() {
  const repo = new MemoryRepo();
  const targets = new MemoryPublishTargetRepo();
  await targets.create(
    {
      id: 'finance-lake',
      label: 'Finance lake',
      kind: 'external',
      bucket: 'finance',
      prefix: '',
      endpoint: null,
      region: null,
      accessKeyId: null,
      secretKeyEnc: null,
      accessKeyEnv: null,
      secretKeyEnv: null,
      forcePathStyle: false,
      sse: 'none',
      kmsKeyId: null,
      storageClass: null,
      connectionId: 'finance-account',
    },
    null,
  );
  const job = await repo.createDocumentAndJob(
    {
      id: randomUUID(),
      filename: 'a.pdf',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      specId: 'demo',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: 'demo/a.pdf',
    },
    null,
  );
  repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'delivering' });
  return { repo, targets, job, deps: { repo, targets } };
}

const event = (
  deliveryId: string,
  sequence: number,
  over: Partial<BridgeEvent> = {},
): BridgeEvent => ({
  eventId: randomUUID(),
  deliveryId,
  sequence,
  status: 'succeeded',
  error: null,
  receipt: { written: [] },
  at: T0.toISOString(),
  ...over,
});

const statusOf = (repo: MemoryRepo, id: string) => repo.jobs.get(id)!.status;

describe('applyEvent', () => {
  it('one target succeeded finalises the job as succeeded', async () => {
    const { repo, job, deps } = await setup();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    expect(await applyEvent(deps, event(d, 2, { status: 'running', receipt: null }))).toBe(
      'applied',
    );
    expect(statusOf(repo, job.id)).toBe('delivering');
    expect(await applyEvent(deps, event(d, 3))).toBe('applied');
    expect(statusOf(repo, job.id)).toBe('succeeded');
    expect(repo.events.get(job.id)?.at(-1)).toMatchObject({
      message: 'delivered',
      data: { targets: ['default'] },
    });
    expect((await repo.deliveriesOf(job.id))[0]).toMatchObject({
      status: 'succeeded',
      lastSequence: 3,
      receipt: { written: [] },
    });
  });

  it('two targets: the job stays delivering until both are terminal', async () => {
    const { repo, job, deps } = await setup();
    const [a, b] = [randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a },
      { targetId: 'finance-lake', deliveryId: b },
    ]);
    await applyEvent(deps, event(a, 2));
    expect(statusOf(repo, job.id)).toBe('delivering');
    await applyEvent(deps, event(b, 2, { status: 'skipped' }));
    expect(statusOf(repo, job.id)).toBe('succeeded');
  });

  it("needs_user returns the job to awaiting_review with the target's label in the reason", async () => {
    const { repo, job, deps } = await setup();
    const [a, b] = [randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a },
      { targetId: 'finance-lake', deliveryId: b },
    ]);
    await applyEvent(deps, event(a, 2));
    await applyEvent(
      deps,
      event(b, 2, {
        status: 'needs_user',
        receipt: null,
        error: { class: 'needs_user', code: 'credential_rejected', message: 'access denied' },
      }),
    );
    expect(repo.jobs.get(job.id)).toMatchObject({
      status: 'awaiting_review',
      reviewReasons: ['Finance lake: access denied'],
    });
  });

  it('a republish (no document to review) fails when a delivery needs a person', async () => {
    const { repo, deps } = await setup();
    const id = randomUUID();
    repo.backgroundJobs.push({
      id,
      task: 'republish',
      priority: 0,
      maxAttempts: 3,
      params: { templateId: 'demo' },
      status: 'delivering',
      createdBy: null,
    });
    const d = randomUUID();
    await repo.recordDeliveries(id, [{ targetId: 'finance-lake', deliveryId: d }]);
    await applyEvent(
      deps,
      event(d, 2, {
        status: 'needs_user',
        receipt: null,
        error: { class: 'needs_user', code: 'credential_rejected', message: 'access denied' },
      }),
    );
    expect(repo.backgroundJobs.find((j) => j.id === id)?.status).toBe('failed');
    expect((await repo.withdrawalStatus()).failed).toBe(1);
  });

  it('a failed delivery fails the job, naming the target', async () => {
    const { repo, job, deps } = await setup();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'finance-lake', deliveryId: d }]);
    await applyEvent(
      deps,
      event(d, 4, {
        status: 'failed',
        receipt: null,
        error: { class: 'retryable', code: 'instance_unavailable', message: 'no answer' },
      }),
    );
    expect(repo.jobs.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'Finance lake: no answer',
    });
  });

  it('a duplicate or older event is stale and changes nothing', async () => {
    const { repo, job, deps } = await setup();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    await applyEvent(deps, event(d, 3, { status: 'waiting', receipt: null }));
    expect(await applyEvent(deps, event(d, 3, { status: 'waiting', receipt: null }))).toBe('stale');
    expect(await applyEvent(deps, event(d, 2))).toBe('stale');
    expect(statusOf(repo, job.id)).toBe('delivering');
    expect((await repo.deliveriesOf(job.id))[0]).toMatchObject({
      status: 'waiting',
      lastSequence: 3,
    });
  });

  it('a final delivery takes no later event (a delayed one after the reconcile moved it on)', async () => {
    const { repo, job, deps } = await setup();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    expect(await applyEvent(deps, event(d, 2))).toBe('applied');
    expect(await applyEvent(deps, event(d, 3, { status: 'running', receipt: null }))).toBe('stale');
    expect((await repo.deliveriesOf(job.id))[0]).toMatchObject({
      status: 'succeeded',
      lastSequence: 2,
    });
  });

  it('an event after the job was finalised changes the delivery row only', async () => {
    const { repo, job, deps } = await setup();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    await applyEvent(deps, event(d, 2, { status: 'running', receipt: null }));
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'cancelled' });
    const events = repo.events.get(job.id)?.length ?? 0;
    await applyEvent(
      deps,
      event(d, 5, {
        status: 'failed',
        receipt: null,
        error: { class: 'retryable', code: 'internal', message: 'x' },
      }),
    );
    expect(statusOf(repo, job.id)).toBe('cancelled');
    expect(repo.events.get(job.id)?.length ?? 0).toBe(events);
    expect((await repo.deliveriesOf(job.id))[0]?.status).toBe('failed');
  });

  it('an unknown delivery is unknown (the bridge sends it again later)', async () => {
    const { deps } = await setup();
    expect(await applyEvent(deps, event(randomUUID(), 1))).toBe('unknown');
  });

  it('finishes a background (republish) job the same way', async () => {
    const { repo, deps } = await setup();
    const republish = randomUUID();
    repo.backgroundJobs.push({
      id: republish,
      task: 'republish',
      priority: 0,
      maxAttempts: 3,
      params: { templateId: 'demo' },
      status: 'delivering',
      createdBy: 'Ken',
    });
    const bg = repo.backgroundJobs.find((j) => j.id === republish)!;
    const d = randomUUID();
    await repo.recordDeliveries(republish, [{ targetId: 'default', deliveryId: d }]);
    await applyEvent(deps, event(d, 2));
    expect(bg.status).toBe('succeeded');
  });
});

describe("job state on each target's latest delivery", () => {
  const needsUser = (d: string, seq: number) =>
    event(d, seq, {
      status: 'needs_user',
      receipt: null,
      error: { class: 'needs_user', code: 'credential_rejected', message: 'access denied' },
    });

  it("a later round's success replaces the earlier needs_user", async () => {
    const { repo, job, deps } = await setup();
    const [a1, b1, a2, b2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a1 },
      { targetId: 'finance-lake', deliveryId: b1 },
    ]);
    await applyEvent(deps, event(a1, 2));
    await applyEvent(deps, needsUser(b1, 2));
    expect(statusOf(repo, job.id)).toBe('awaiting_review');

    // Approved again: a second round to both targets.
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'delivering' });
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a2 },
      { targetId: 'finance-lake', deliveryId: b2 },
    ]);
    expect((await repo.deliveriesOf(job.id)).map((d) => d.deliveryId)).toEqual([a2, b2]);
    await applyEvent(deps, event(a2, 2));
    expect(statusOf(repo, job.id)).toBe('delivering');
    await applyEvent(deps, event(b2, 2));
    expect(statusOf(repo, job.id)).toBe('succeeded');
  });

  it('several deliveries to one target in a round all count (a republish, ontology loads)', async () => {
    const { repo, job, deps } = await setup();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a },
      { targetId: 'default', deliveryId: b },
      { targetId: 'default', deliveryId: c },
    ]);
    expect(await repo.deliveriesOf(job.id)).toHaveLength(3);
    await applyEvent(deps, event(a, 2));
    await applyEvent(deps, event(b, 2));
    expect(statusOf(repo, job.id)).toBe('delivering');
    await applyEvent(
      deps,
      event(c, 2, {
        status: 'failed',
        receipt: null,
        error: { class: 'retryable', code: 'timeout', message: 'gave up' },
      }),
    );
    expect(statusOf(repo, job.id)).toBe('failed');
  });

  it('one target failed and one succeeded: the job fails, naming the failed target', async () => {
    const { repo, job, deps } = await setup();
    const [a, b] = [randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a },
      { targetId: 'finance-lake', deliveryId: b },
    ]);
    await applyEvent(deps, event(a, 2));
    await applyEvent(
      deps,
      event(b, 2, {
        status: 'failed',
        receipt: null,
        error: { class: 'retryable', code: 'timeout', message: 'gave up' },
      }),
    );
    expect(repo.jobs.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'Finance lake: gave up',
    });
  });

  it('one target needs the user and one failed: the job goes back to review', async () => {
    const { repo, job, deps } = await setup();
    const [a, b] = [randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a },
      { targetId: 'finance-lake', deliveryId: b },
    ]);
    await applyEvent(
      deps,
      event(a, 2, {
        status: 'failed',
        receipt: null,
        error: { class: 'retryable', code: 'timeout', message: 'gave up' },
      }),
    );
    await applyEvent(deps, needsUser(b, 2));
    expect(repo.jobs.get(job.id)).toMatchObject({
      status: 'awaiting_review',
      reviewReasons: ['Finance lake: access denied'],
    });
  });
});

describe('reconcileOnce', () => {
  const view = (id: string, over: Partial<DeliveryView> = {}): DeliveryView => ({
    id,
    packageId: randomUUID(),
    targetId: 'default',
    status: 'succeeded',
    attempts: 1,
    error: null,
    receipt: { written: [] },
    skippedFor: null,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...over,
  });

  it('applies a delivery the bridge finished but whose event was lost', async () => {
    const { repo, job, deps } = await setup();
    const bridge = new FakeBridgeApi();
    const [lost, fresh] = [randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: lost },
      { targetId: 'finance-lake', deliveryId: fresh },
    ]);
    repo.ageDelivery(lost, new Date(T0.getTime() - 11 * 60_000));
    repo.ageDelivery(fresh, new Date(T0.getTime() - 60_000));
    bridge.deliveries.set(lost, view(lost));
    bridge.deliveries.set(fresh, view(fresh, { targetId: 'finance-lake' }));
    expect(await reconcileOnce({ ...deps, bridge }, T0)).toBe(1);
    expect((await repo.deliveriesOf(job.id)).map((d) => [d.deliveryId, d.status])).toEqual([
      [lost, 'succeeded'],
      [fresh, 'queued'],
    ]);
    expect(statusOf(repo, job.id)).toBe('delivering');
  });

  it('leaves a delivery whose status the bridge still has as recorded', async () => {
    const { repo, job, deps } = await setup();
    const bridge = new FakeBridgeApi();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    repo.ageDelivery(d, new Date(T0.getTime() - 20 * 60_000));
    bridge.deliveries.set(d, view(d, { status: 'queued', receipt: null }));
    expect(await reconcileOnce({ ...deps, bridge }, T0)).toBe(0);
    bridge.failNext = new Error('down');
    expect(await reconcileOnce({ ...deps, bridge }, T0)).toBe(0);
  });

  it('fails a delivery the bridge no longer knows, which finishes the job', async () => {
    const { repo, job, deps } = await setup();
    const bridge = new FakeBridgeApi();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    repo.ageDelivery(d, new Date(T0.getTime() - 20 * 60_000));
    expect(await reconcileOnce({ ...deps, bridge }, T0)).toBe(1);
    expect((await repo.deliveriesOf(job.id))[0]).toMatchObject({
      status: 'failed',
      error: { code: 'not_found', message: 'the bridge has no record of this delivery' },
    });
    expect(statusOf(repo, job.id)).toBe('failed');
    expect(repo.jobs.get(job.id)?.error).toBe('Default: the bridge has no record of this delivery');
  });
});

describe('POST /api/bridge/events', () => {
  it('applies a signed event, and asks the bridge to resend one it cannot place yet', async () => {
    const c = await testApp();
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'tdemo' }, { filename: 'a.pdf', content: fakePdf }),
    });
    const job = res.json() as JobSummary;
    c.repo.jobs.set(job.id, { ...c.repo.jobs.get(job.id)!, status: 'delivering' });
    const d = randomUUID();
    await c.repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    const send = (e: BridgeEvent) => {
      const payload = JSON.stringify(e);
      return c.app.inject({
        method: 'POST',
        url: '/api/bridge/events',
        headers: {
          ...signRequest(TEST_BRIDGE_KEY, {
            method: 'POST',
            path: '/api/bridge/events',
            body: payload,
          }),
          'content-type': 'application/json',
        },
        payload,
      });
    };
    expect((await send(event(randomUUID(), 1))).statusCode).toBe(409);
    expect((await send(event(d, 2))).statusCode).toBe(204);
    expect(c.repo.jobs.get(job.id)?.status).toBe('succeeded');
    expect((await send(event(d, 2))).statusCode).toBe(204);
  });
});

describe('GET /api/jobs/:id deliveries', () => {
  it("lists each delivery with its target's label, status and problem", async () => {
    const c = await testApp();
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'tdemo' }, { filename: 'a.pdf', content: fakePdf }),
    });
    const job = res.json() as JobSummary;
    c.repo.jobs.set(job.id, { ...c.repo.jobs.get(job.id)!, status: 'delivering' });
    const [a, b] = [randomUUID(), randomUUID()];
    await c.repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a },
      { targetId: 'gone', deliveryId: b },
    ]);
    await applyEvent(
      { repo: c.repo, targets: c.targets },
      event(b, 2, {
        status: 'needs_user',
        receipt: null,
        error: { class: 'needs_user', code: 'target_missing', message: 'no target gone' },
      }),
    );
    const detail = (await c.app.inject(`/api/jobs/${job.id}`)).json();
    expect(detail.deliveries).toEqual([
      { targetId: 'default', label: 'Default', status: 'queued', message: null },
      { targetId: 'gone', label: 'gone', status: 'needs_user', message: 'no target gone' },
    ]);
  });
});
