import type pg from 'pg';
import { afterAll, describe } from 'vitest';
import { PgTargetRepo } from '../../src/targets/pg.js';
import { targetsContract } from '../targets-contract.js';
import { freshBridge, url } from './db.js';

describe.skipIf(!url)('PgTargetRepo', () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });
  targetsContract('pg', async () => {
    await pool?.end();
    pool = await freshBridge();
    return new PgTargetRepo(pool);
  });
});
