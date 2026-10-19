import type { NonceStore } from '@ih/bridge-contract';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { BridgeConfig } from './config.js';
import type { DeliveryRepo } from './deliveries/repo.js';
import { registerGuard, requestIds } from './http/guard.js';
import type { PackageStore } from './packages/store.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { healthRoutes } from './routes/health.js';
import type { SinkRegistry } from './sinks/port.js';
import type { TargetRepo } from './targets/repo.js';

/** Everything the bridge's routes reach, as ports (fakes in tests). */
export interface BridgeDeps {
  config: Pick<
    BridgeConfig,
    'BRIDGE_CLIENT_KEY' | 'BRIDGE_MAX_PACKAGE_MB' | 'BRIDGE_PACKAGE_RETENTION_DAYS'
  >;
  deliveries: DeliveryRepo;
  packages: PackageStore;
  targets: TargetRepo;
  sinks: SinkRegistry;
  /** Whether the bridge can serve (its database answers). */
  ready: () => Promise<boolean>;
  /** Signature nonces seen inside the replay window. */
  nonces: NonceStore;
  logger?: FastifyBaseLogger | false;
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
  await app.register(healthRoutes);
  await app.register(deliveryRoutes);
  return app;
}
