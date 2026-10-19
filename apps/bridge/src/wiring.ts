import { MemoryNonceStore } from '@ih/bridge-contract';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { buildBridge } from './app.js';
import type { BridgeConfig } from './config.js';
import { Credentials } from './connections/credential.js';
import { PgConnectionRepo } from './connections/pg.js';
import { PgDeliveryRepo } from './deliveries/pg.js';
import type { RunnerDeps } from './deliveries/runner.js';
import { S3PackageStore } from './packages/s3.js';
import { S3ObjectStore, type ObjectStorePort } from './s3/store.js';
import { MapSinkRegistry } from './sinks/port.js';
import { S3_SINK_ID, S3Sink } from './sinks/s3.js';
import { PgTargetRepo } from './targets/pg.js';

export interface Built {
  app: FastifyInstance;
  runner: RunnerDeps;
  /** The deployment's own S3, where packages are staged. */
  internalStore: ObjectStorePort;
}

/**
 * The bridge on Postgres, with what its loops need: packages staged in the deployment's own S3
 * (`BRIDGE_STAGING_BUCKET`), and the built-in `s3` sink.
 */
export async function buildFromConfig(
  config: BridgeConfig,
  infra: {
    pool: pg.Pool;
    logger?: FastifyServerOptions['logger'];
    /** Where env-keyed connections read their keys (allowlisted names only). */
    env?: Record<string, string | undefined>;
  },
): Promise<Built> {
  const internal = {
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
    forcePathStyle: true,
  };
  const internalStore = new S3ObjectStore(internal);
  const deliveries = new PgDeliveryRepo(infra.pool);
  const targets = new PgTargetRepo(infra.pool);
  const connections = new PgConnectionRepo(infra.pool);
  const credentials = new Credentials({
    connections,
    secrets: config.secrets,
    env: infra.env ?? process.env,
  });
  const packages = new S3PackageStore(internalStore, config.BRIDGE_STAGING_BUCKET);
  const sinks = new MapSinkRegistry({
    [S3_SINK_ID]: new S3Sink({ internal, reservedBuckets: [config.BRIDGE_STAGING_BUCKET] }),
  });
  const app = await buildBridge({
    config,
    deliveries,
    packages,
    targets,
    sinks,
    connections,
    credentials,
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
    internalStore,
    runner: {
      deliveries,
      packages,
      targets,
      sinks,
      credentials,
      connections,
      maxAttempts: config.BRIDGE_MAX_ATTEMPTS,
      leaseSeconds: config.BRIDGE_LEASE_SECONDS,
    },
  };
}
