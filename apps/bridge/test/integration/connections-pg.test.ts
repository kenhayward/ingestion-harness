import type pg from 'pg';
import { afterAll, describe } from 'vitest';
import { PgConnectionRepo } from '../../src/connections/pg.js';
import { PgTargetRepo } from '../../src/targets/pg.js';
import { connectionsContract } from '../connections-contract.js';
import { freshBridge, url } from './db.js';

describe.skipIf(!url)('PgConnectionRepo', () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });
  connectionsContract('pg', async () => {
    await pool?.end();
    pool = await freshBridge();
    return { connections: new PgConnectionRepo(pool), targets: new PgTargetRepo(pool) };
  });
});
