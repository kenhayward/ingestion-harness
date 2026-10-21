/**
 * Opt-in Postgres test of delivering jobs (delivery bridge phase 2, migration
 * 202610201100_job_deliveries): events recorded once and in order, and a job finished exactly
 * once however its last events race. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY
 * database (it applies db/migrations and writes rows).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BridgeEvent } from '@ih/bridge-contract';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEvent } from '../../src/bridge/events.js';
import { migrate } from '../../src/db/migrate.js';
import { PgPublishTargetRepo } from '../../src/publish-targets/pg.js';
import { PgRepo } from '../../src/repositories/pg.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('job deliveries against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  let targets: PgPublishTargetRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 4 });
    repo = PgRepo.fromUrl(url!);
    targets = new PgPublishTargetRepo(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await repo?.close();
  });

  async function delivering() {
    const id = randomUUID();
    const job = await repo.createDocumentAndJob(
      {
        id,
        filename: `${id}.pdf`,
        sha256: 'c'.repeat(64),
        sizeBytes: 10,
        specId: 'demo',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `${id}.pdf`,
      },
      null,
    );
    await pool.query(`UPDATE jobs SET status = 'delivering' WHERE id = $1`, [job.id]);
    return job;
  }

  const event = (deliveryId: string, sequence: number, over: Partial<BridgeEvent> = {}) =>
    ({
      eventId: randomUUID(),
      deliveryId,
      sequence,
      status: 'succeeded',
      error: null,
      receipt: { written: [] },
      at: new Date().toISOString(),
      ...over,
    }) satisfies BridgeEvent;

  const statusOf = async (id: string) =>
    (await pool.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [id])).rows[0]!
      .status;

  it('records events in order, refuses stale ones, and finishes the job with an event', async () => {
    const job = await delivering();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]); // idempotent
    expect(
      await applyEvent({ repo, targets }, event(d, 3, { status: 'waiting', receipt: null })),
    ).toBe('applied');
    expect(await applyEvent({ repo, targets }, event(d, 2))).toBe('stale');
    expect(await statusOf(job.id)).toBe('delivering');
    expect(await applyEvent({ repo, targets }, event(d, 4))).toBe('applied');
    expect(await statusOf(job.id)).toBe('succeeded');
    expect(await repo.deliveriesOf(job.id)).toEqual([
      expect.objectContaining({ deliveryId: d, status: 'succeeded', lastSequence: 4 }),
    ]);
    const events = await pool.query(
      `SELECT message, data FROM job_events WHERE job_id = $1 AND message = 'delivered'`,
      [job.id],
    );
    expect(events.rows).toEqual([{ message: 'delivered', data: { targets: ['default'] } }]);
    expect(await applyEvent({ repo, targets }, event(randomUUID(), 1))).toBe('unknown');
  });

  it("a later round's success replaces the earlier needs_user", async () => {
    const job = await delivering();
    await pool.query(
      `INSERT INTO publish_targets (id, label, kind, bucket) VALUES ('lake-2', 'Lake 2', 'internal', 'lake-2')
       ON CONFLICT (id) DO NOTHING`,
    );
    const [a1, b1, a2, b2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a1 },
      { targetId: 'lake-2', deliveryId: b1 },
    ]);
    await applyEvent({ repo, targets }, event(a1, 2));
    await applyEvent(
      { repo, targets },
      event(b1, 2, {
        status: 'needs_user',
        receipt: null,
        error: { class: 'needs_user', code: 'credential_rejected', message: 'access denied' },
      }),
    );
    expect(await statusOf(job.id)).toBe('awaiting_review');
    await pool.query(`UPDATE jobs SET status = 'delivering' WHERE id = $1`, [job.id]);
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: a2 },
      { targetId: 'lake-2', deliveryId: b2 },
    ]);
    expect((await repo.deliveriesOf(job.id)).map((d) => d.deliveryId)).toEqual([a2, b2]);
    await applyEvent({ repo, targets }, event(a2, 2));
    expect(await statusOf(job.id)).toBe('delivering');
    await applyEvent({ repo, targets }, event(b2, 2));
    expect(await statusOf(job.id)).toBe('succeeded');
  });

  it('a needs_user delivery puts the job back in review with the target label', async () => {
    const job = await delivering();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    await applyEvent(
      { repo, targets },
      event(d, 2, {
        status: 'needs_user',
        receipt: null,
        error: { class: 'needs_user', code: 'credential_rejected', message: 'access denied' },
      }),
    );
    const row = await pool.query(`SELECT status, review_reasons FROM jobs WHERE id = $1`, [job.id]);
    expect(row.rows[0]).toEqual({
      status: 'awaiting_review',
      review_reasons: ['Default: access denied'],
    });
  });

  it('a republish (no document to review) fails when a delivery needs a person', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (task, status, params) VALUES ('republish', 'delivering', '{}') RETURNING id`,
    );
    const id = rows[0]!.id;
    const d = randomUUID();
    await repo.recordDeliveries(id, [{ targetId: 'default', deliveryId: d }]);
    await applyEvent(
      { repo, targets },
      event(d, 2, {
        status: 'needs_user',
        receipt: null,
        error: { class: 'needs_user', code: 'credential_rejected', message: 'access denied' },
      }),
    );
    const row = await pool.query(`SELECT status, error FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: 'failed', error: 'Default: access denied' });
  });

  it('a delivery that ends failed leaves its published outputs withdrawn, so republish finds them', async () => {
    const job = await delivering();
    const d = randomUUID();
    await repo.recordDeliveries(job.id, [{ targetId: 'default', deliveryId: d }]);
    await pool.query(
      `INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key, target_id, delivery_id)
       VALUES ($1, 'fields', 'published', 'csv', 'pub', 'k.csv', 'default', $2)`,
      [job.id, d],
    );
    await applyEvent(
      { repo, targets },
      event(d, 2, {
        status: 'failed',
        receipt: null,
        error: { class: 'retryable', code: 'instance_unavailable', message: 'down' },
      }),
    );
    const row = await pool.query(
      `SELECT withdrawn_at IS NOT NULL AS withdrawn FROM job_outputs WHERE job_id = $1`,
      [job.id],
    );
    expect(row.rows).toEqual([{ withdrawn: true }]);
    // The job failed, so it was never published: a republish of its type has nothing to do.
    await pool.query(
      `UPDATE documents SET spec_id = $2 FROM jobs j
                       WHERE j.id = $1 AND documents.id = j.document_id`,
      [job.id, `rf-${d.slice(0, 8)}`],
    );
    expect(await repo.republishType(`rf-${d.slice(0, 8)}`, 'admin')).toBeNull();
  });

  it('two concurrent events for the last two deliveries finalise the job exactly once', async () => {
    for (let round = 0; round < 5; round++) {
      const job = await delivering();
      const [a, b] = [randomUUID(), randomUUID()];
      await repo.recordDeliveries(job.id, [
        { targetId: 'default', deliveryId: a },
        { targetId: 'default', deliveryId: b },
      ]);
      await Promise.all([
        applyEvent({ repo, targets }, event(a, 2)),
        applyEvent({ repo, targets }, event(b, 2)),
      ]);
      expect(await statusOf(job.id)).toBe('succeeded');
      const finished = await pool.query(
        `SELECT count(*)::int AS n FROM job_events WHERE job_id = $1 AND message = 'delivered'`,
        [job.id],
      );
      expect(finished.rows[0].n).toBe(1);
    }
  });

  it('lists the stragglers of delivering jobs only', async () => {
    const job = await delivering();
    const [old, fresh, done] = [randomUUID(), randomUUID(), randomUUID()];
    await repo.recordDeliveries(job.id, [
      { targetId: 'default', deliveryId: old },
      { targetId: 'default', deliveryId: fresh },
      { targetId: 'default', deliveryId: done },
    ]);
    await pool.query(
      `UPDATE job_deliveries SET updated_at = now() - interval '20 minutes'
        WHERE delivery_id IN ($1, $2)`,
      [old, done],
    );
    await pool.query(`UPDATE job_deliveries SET status = 'succeeded' WHERE delivery_id = $1`, [
      done,
    ]);
    const ids = (await repo.stragglers(10, new Date())).map((d) => d.deliveryId);
    expect(ids).toContain(old);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(done);
  });
});
