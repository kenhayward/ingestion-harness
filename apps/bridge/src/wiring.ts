import { MemoryNonceStore } from '@ih/bridge-contract';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { buildBridge } from './app.js';
import type { BridgeConfig } from './config.js';
import { PgDeliveryRepo } from './deliveries/pg.js';
import type { RunnerDeps } from './deliveries/runner.js';
import { MemoryPackageStore } from './packages/store.js';
import { MapSinkRegistry } from './sinks/port.js';
import { PgTargetRepo } from './targets/pg.js';

export interface Built {
  app: FastifyInstance;
  runner: RunnerDeps;
}

/**
 * The bridge on Postgres, with what its loops need. Phase 1: packages are staged in memory and no
 * sink is registered yet (phase 2 adds S3 staging and the built-in sinks).
 */
export async function buildFromConfig(
  config: BridgeConfig,
  infra: { pool: pg.Pool; logger?: FastifyServerOptions['logger'] },
): Promise<Built> {
  const deliveries = new PgDeliveryRepo(infra.pool);
  const targets = new PgTargetRepo(infra.pool);
  const packages = new MemoryPackageStore();
  const sinks = new MapSinkRegistry({});
  const app = await buildBridge({
    config,
    deliveries,
    packages,
    targets,
    sinks,
    nonces: new MemoryNonceStore(),
    logger: infra.logger ?? false,
    ready: async () => {
      try {
        await infra.pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  });
  return {
    app,
    runner: {
      deliveries,
      packages,
      targets,
      sinks,
      maxAttempts: config.BRIDGE_MAX_ATTEMPTS,
      leaseSeconds: config.BRIDGE_LEASE_SECONDS,
    },
  };
}
