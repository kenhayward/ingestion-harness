import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadBridgeConfig } from '../src/config.js';
import { buildFromConfig } from '../src/wiring.js';

const config = loadBridgeConfig({
  DATABASE_URL: 'postgres://x/y',
  BRIDGE_CLIENT_KEY: 'k'.repeat(32),
});

const pool = (answer: () => Promise<unknown>) => ({ query: answer }) as unknown as pg.Pool;

describe('buildFromConfig', () => {
  it('is ready when the database answers', async () => {
    const { app } = await buildFromConfig(config, { pool: pool(async () => ({ rows: [] })) });
    expect((await app.inject('/readyz')).statusCode).toBe(200);
  });

  it('is not ready when the database does not', async () => {
    const { app } = await buildFromConfig(config, {
      pool: pool(async () => {
        throw new Error('down');
      }),
    });
    expect((await app.inject('/readyz')).statusCode).toBe(503);
  });

  it('gives the loops the same repos the routes use', async () => {
    const built = await buildFromConfig(config, { pool: pool(async () => ({ rows: [] })) });
    expect(built.runner.deliveries).toBe(built.app.deps.deliveries);
    expect(built.runner).toMatchObject({ maxAttempts: 8, leaseSeconds: 300 });
  });
});
