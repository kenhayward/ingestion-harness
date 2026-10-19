import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgDeliveryRepo } from '../../src/deliveries/pg.js';
import { deliveriesContract, delivery, pkg } from '../deliveries-contract.js';
import { freshBridge, url } from './db.js';

describe.skipIf(!url)('PgDeliveryRepo', () => {
  let pool: pg.Pool | undefined;
  const make = async () => {
    await pool?.end();
    pool = await freshBridge();
    await pool.query(
      `INSERT INTO bridge.targets (id, label, sink_id) VALUES ('t1', 'T1', 'fake'), ('t2', 'T2', 'fake')`,
    );
    return new PgDeliveryRepo(pool);
  };
  afterAll(async () => {
    await pool?.end();
  });

  deliveriesContract('pg', make);

  it('two claims in parallel never return the same delivery', async () => {
    const repo = await make();
    const now = new Date('2026-10-19T12:00:00.000Z');
    const all = Array.from({ length: 20 }, () => delivery());
    await repo.create(pkg(), all, now);
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (;;) {
          const row = await repo.claim(now, 300);
          if (!row) return;
          claimed.push(row.id);
        }
      }),
    );
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed).size).toBe(20);
  });
});
