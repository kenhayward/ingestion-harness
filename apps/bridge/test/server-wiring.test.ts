import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadBridgeConfig } from '../src/config.js';
import { S3PackageStore } from '../src/packages/s3.js';
import { buildFromConfig } from '../src/wiring.js';

const config = loadBridgeConfig({
  DATABASE_URL: 'postgres://x/y',
  BRIDGE_CLIENT_KEY: 'k'.repeat(32),
  BRIDGE_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  S3_ENDPOINT: 'http://seaweedfs:8333',
  S3_ACCESS_KEY: 'internal-key',
  S3_SECRET_KEY: 'internal-secret',
  BRIDGE_PRODUCER_URL: 'http://api:3000/api',
  BRIDGE_PUBLIC_URL: 'https://ct.example.com/bridge',
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
    expect(built.runner.packages).toBe(built.app.deps.packages);
    expect(built.runner.credentials).toBe(built.app.deps.credentials);
    expect(built.runner.connections).toBe(built.app.deps.connections);
    expect(built.runner).toMatchObject({ maxAttempts: 8, leaseSeconds: 300 });
  });

  it('registers the built-in s3 sink and stages packages in S3', async () => {
    const built = await buildFromConfig(config, { pool: pool(async () => ({ rows: [] })) });
    expect(built.app.deps.sinks.ids()).toEqual(['s3']);
    expect(built.app.deps.packages).toBeInstanceOf(S3PackageStore);
  });
});
