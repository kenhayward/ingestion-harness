/**
 * Opt-in Postgres test of the decomposition register (decomposition phase 2, migration
 * 202610231300_decomposition_register): its keys, and entries settled from the bridge's events.
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database (it applies db/migrations and
 * writes rows).
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bridgeError, type BridgeEvent, type Receipt } from '@ih/bridge-contract';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEvent } from '../../src/bridge/events.js';
import { migrate } from '../../src/db/migrate.js';
import { PgPublishTargetRepo } from '../../src/publish-targets/pg.js';
import { PgRepo } from '../../src/repositories/pg.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('the decomposition register against Postgres', { timeout: 30_000 }, () => {
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

  /** A pending entry, as the worker writes it. */
  async function pending(
    over: { instanceId?: string | null; sourceKey?: string; persistentId?: string | null } = {},
  ) {
    const deliveryId = randomUUID();
    const sinkId = `sink-${randomUUID()}`;
    await pool.query(
      `INSERT INTO decomposition_register
         (sink_id, instance_id, source_key, content_sha256, persistent_id, state,
          idempotency_key, delivery_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [
        sinkId,
        over.instanceId === undefined ? 'tenant-1' : over.instanceId,
        over.sourceKey ?? 'batch/a.docx',
        'a'.repeat(64),
        over.persistentId ?? null,
        'k'.repeat(64),
        deliveryId,
      ],
    );
    return { deliveryId, sinkId };
  }

  const receipt = (persistentId: string, ok = true): Receipt => ({
    written: [{ kind: 'document', id: persistentId, label: null, url: null }],
    document: {
      persistentId,
      components: [{ kind: 'section', element: 's1', id: 'c1', version: '1' }],
      readBack: { ok, at: null, detail: null },
    },
  });

  const event = (deliveryId: string, over: Partial<BridgeEvent> = {}): BridgeEvent => ({
    eventId: randomUUID(),
    deliveryId,
    sequence: 1,
    status: 'succeeded',
    error: null,
    receipt: { written: [] },
    at: new Date().toISOString(),
    ...over,
  });

  it('refuses a second entry for one source on a tenant, with or without an instance', async () => {
    const { sinkId } = await pending();
    const again = (instanceId: string | null) =>
      pool.query(
        `INSERT INTO decomposition_register
           (sink_id, instance_id, source_key, content_sha256, state, idempotency_key)
         VALUES ($1, $2, 'batch/a.docx', $3, 'pending', 'k')`,
        [sinkId, instanceId, 'b'.repeat(64)],
      );
    await expect(again('tenant-1')).rejects.toThrow(/unique/);
    await again('tenant-2'); // another tenant: another document
    await again(null);
    await expect(again(null)).rejects.toThrow(/unique/);
    await expect(
      pool.query(
        `INSERT INTO decomposition_register
           (sink_id, source_key, content_sha256, state, idempotency_key)
         VALUES ($1, 'x', 'c', 'settled', 'k')`,
        [sinkId],
      ),
    ).rejects.toThrow(/check/);
  });

  it('settles a pending entry once, from a final event of its delivery', async () => {
    const { deliveryId } = await pending();
    expect(
      await applyEvent({ repo, targets }, event(deliveryId, { status: 'running', receipt: null })),
    ).toBe('stale');
    const r = receipt('doc-1');
    expect(await applyEvent({ repo, targets }, event(deliveryId, { receipt: r }))).toBe('applied');
    const entry = await repo.registerEntryByDelivery(deliveryId);
    expect(entry).toMatchObject({
      state: 'delivered',
      persistentId: 'doc-1',
      lastReceipt: r,
      lastError: null,
      instanceId: 'tenant-1',
    });
    expect(entry?.deliveredAt).not.toBeNull();
    const late = bridgeError('internal', 'late');
    expect(
      await applyEvent({ repo, targets }, event(deliveryId, { status: 'failed', error: late })),
    ).toBe('stale');
    expect(await repo.registerEntryByDelivery(deliveryId)).toMatchObject({ state: 'delivered' });
    expect(await applyEvent({ repo, targets }, event(randomUUID()))).toBe('unknown');
  });

  it('keeps a known persistent id and last receipt through a refusal and a failure', async () => {
    const changed = await pending({ persistentId: 'doc-1' });
    const error = bridgeError('changed_in_target', 'changed in the target');
    await applyEvent(
      { repo, targets },
      event(changed.deliveryId, { status: 'needs_user', error, receipt: null }),
    );
    expect(await repo.registerEntryByDelivery(changed.deliveryId)).toMatchObject({
      state: 'changed',
      persistentId: 'doc-1',
      lastError: error,
      lastReceipt: null,
      deliveredAt: null,
    });

    const failed = await pending({ instanceId: null });
    await applyEvent(
      { repo, targets },
      event(failed.deliveryId, {
        status: 'failed',
        error: bridgeError('internal', 'failed part-way'),
        receipt: receipt('doc-2', false),
      }),
    );
    expect(await repo.registerEntryByDelivery(failed.deliveryId)).toMatchObject({
      state: 'failed',
      persistentId: 'doc-2',
      instanceId: null,
    });
  });

  it('lists pending entries with a delivery not updated for a while, oldest first', async () => {
    const now = new Date();
    const stuck = await pending();
    const young = await pending();
    await pool.query(`UPDATE decomposition_register SET updated_at = $2 WHERE delivery_id = $1`, [
      stuck.deliveryId,
      new Date(now.getTime() - 30 * 60_000),
    ]);
    const unsent = await pending();
    await pool.query(
      `UPDATE decomposition_register SET delivery_id = NULL, updated_at = $2
        WHERE delivery_id = $1`,
      [unsent.deliveryId, new Date(now.getTime() - 30 * 60_000)],
    );
    const ids = (await repo.registerStragglers(10, now)).map((e) => e.deliveryId);
    expect(ids).toContain(stuck.deliveryId);
    expect(ids).not.toContain(young.deliveryId);
    expect(ids).not.toContain(null);
  });

  it('fails pending entries never given a delivery once they are old enough', async () => {
    const now = new Date();
    const age = async (deliveryId: string, minutes: number) =>
      pool.query(
        `UPDATE decomposition_register SET delivery_id = NULL, updated_at = $2
          WHERE delivery_id = $1 RETURNING id::text`,
        [deliveryId, new Date(now.getTime() - minutes * 60_000)],
      );
    const old = (await age((await pending()).deliveryId, 31)).rows[0].id as string;
    const fresh = (await age((await pending()).deliveryId, 29)).rows[0].id as string;
    const sent = await pending();
    await pool.query(`UPDATE decomposition_register SET updated_at = $2 WHERE delivery_id = $1`, [
      sent.deliveryId,
      new Date(now.getTime() - 60 * 60_000),
    ]);
    const error = { class: 'retryable' as const, code: 'not_recorded', message: 'never recorded' };
    expect(await repo.expireUnrecordedRegisterEntries(30, now, error)).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      `SELECT id::text, state, last_error FROM decomposition_register WHERE id = ANY($1)`,
      [[old, fresh]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[old]).toMatchObject({ state: 'failed', last_error: error });
    expect(byId[fresh]).toMatchObject({ state: 'pending' });
    expect(await repo.registerEntryByDelivery(sent.deliveryId)).toMatchObject({ state: 'pending' });
  });
});
