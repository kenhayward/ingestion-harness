import type { NonceStore } from '@ih/bridge-contract';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { BridgeConfig } from './config.js';
import type { Credentials } from './connections/credential.js';
import type { ConnectionRepo } from './connections/repo.js';
import type { DeliveryRepo } from './deliveries/repo.js';
import { registerGuard, requestIds } from './http/guard.js';
import { registerOpenApi } from './openapi.js';
import { catalogRoutes } from './routes/catalog.js';
import type { PackageStore } from './packages/store.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { pageRoutes } from './page/routes.js';
import type { ProducerClient } from './producer/client.js';
import { healthRoutes } from './routes/health.js';
import { connectionRoutes } from './routes/connections.js';
import { sinkAdminRoutes } from './routes/sink-admin.js';
import { targetRoutes } from './routes/targets.js';
import type { SinkRegistry } from './sinks/port.js';
import type { TargetRepo } from './targets/repo.js';

/** Everything the bridge's routes reach, as ports (fakes in tests). */
export interface BridgeDeps {
  config: Pick<
    BridgeConfig,
    | 'BRIDGE_CLIENT_KEY'
    | 'BRIDGE_MAX_PACKAGE_MB'
    | 'BRIDGE_PACKAGE_RETENTION_DAYS'
    | 'BRIDGE_PUBLIC_URL'
    | 'BRIDGE_COOKIE_SECURE'
    | 'BRIDGE_APP_ORIGIN'
    | 'BRIDGE_STAGING_BUCKET'
    | 'secrets'
  >;
  deliveries: DeliveryRepo;
  packages: PackageStore;
  targets: TargetRepo;
  sinks: SinkRegistry;
  connections: ConnectionRepo;
  /** Turns a target's connection into its sink's credential. */
  credentials: Credentials;
  /** Signed calls back to CT Studio (handoff codes). */
  producer: ProducerClient;
  /** Whether the bridge can serve (its database answers). */
  ready: () => Promise<boolean>;
  /** Signature nonces seen inside the replay window. */
  nonces: NonceStore;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: BridgeDeps;
  }
}

export async function buildBridge(deps: BridgeDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, ...requestIds() });
  app.decorate('deps', deps);
  registerGuard(app, {
    key: deps.config.BRIDGE_CLIENT_KEY,
    nonces: deps.nonces,
    maxBodyBytes: deps.config.BRIDGE_MAX_PACKAGE_MB * 2 ** 20,
  });
  // Route schemas are Zod and serve the OpenAPI document only: handlers validate with Zod
  // themselves, and responses are serialised as they are (as in apps/api).
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  await registerOpenApi(app); // before the routes: swagger collects them as they are added
  await app.register(healthRoutes);
  await app.register(deliveryRoutes);
  await app.register(catalogRoutes);
  await app.register(sinkAdminRoutes);
  await app.register(targetRoutes);
  await app.register(connectionRoutes);
  await app.register(pageRoutes);
  return app;
}
