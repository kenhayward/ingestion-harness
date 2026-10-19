import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { BridgeConfig } from './config.js';
import { healthRoutes } from './routes/health.js';

/** Everything the bridge's routes reach, as ports (fakes in tests). */
export interface BridgeDeps {
  config: Pick<BridgeConfig, 'BRIDGE_CLIENT_KEY' | 'BRIDGE_MAX_PACKAGE_MB'>;
  /** Whether the bridge can serve (its database answers). */
  ready: () => Promise<boolean>;
  logger?: FastifyBaseLogger | false;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: BridgeDeps;
  }
}

export async function buildBridge(deps: BridgeDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorate('deps', deps);
  // Route schemas are Zod and serve the OpenAPI document only: handlers validate with Zod
  // themselves, and responses are serialised as they are (as in apps/api).
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  await app.register(healthRoutes);
  return app;
}
