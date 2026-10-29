import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgDeliveryRepo } from '../../src/deliveries/pg.js';
import { delivery, pkg } from '../deliveries-contract.js';
import { LANE_TARGETS, LIMITS, lanesContract } from '../lanes-contract.js';
import { freshBridge, url } from './db.js';

describe.skipIf(!url)('PgDeliveryRepo lanes', () => {
  let pool: pg.Pool | undefined;
  const make = async () => {
    await pool?.end();
    pool = await freshBridge();
    for (const t of LANE_TARGETS) {
      await pool.query(
        'INSERT INTO bridge.targets (id, label, sink_id, instance_id) VALUES ($1, $1, $2, $3)',
        [t.id, t.sinkId, t.instanceId],
      );
    }
    return new PgDeliveryRepo(pool);
  };
  afterAll(async () => {
    await pool?.end();
  });

  lanesContract('pg', make);

  it('two runners never exceed the lane', async () => {
    const repo = await make();
    const now = new Date('2026-10-19T12:00:00.000Z');
    await repo.create(
      pkg(),
      Array.from({ length: 20 }, () => delivery('two')),
      now,
    );
    const claimed = await Promise.all(
      Array.from({ length: 20 }, () => repo.claim(now, 300, LIMITS)),
    );
    expect(claimed.filter((c) => c !== null)).toHaveLength(2);
  });
});
