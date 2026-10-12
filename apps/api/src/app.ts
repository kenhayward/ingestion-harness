import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { AccessRepo } from './access/repo.js';
import { registerAccess } from './access/routes.js';
import type { IngestionRepo } from './repositories/types.js';
import type { ObjectStore } from './storage/object-store.js';
import type { SpecRegistry } from './specs/spec-registry.js';
import type { TemplateRepo } from './templates/repo.js';
import { templateRoutes } from './routes/templates.js';
import { referenceRoutes } from './routes/references.js';
import { healthRoutes } from './routes/health.js';
import { specRoutes } from './routes/specs.js';
import { documentRoutes } from './routes/documents.js';
import { jobRoutes } from './routes/jobs.js';
import { modelRoutes } from './routes/models.js';
import { reviewRoutes } from './routes/review.js';
import { resultRoutes } from './routes/results.js';

export interface AppDeps {
  repo: IngestionRepo;
  store: ObjectStore;
  /** Final publish target (`TARGET_S3_*`); published job outputs are read from here. */
  targetStore: ObjectStore;
  target: { bucket: string; prefix: string };
  specs: SpecRegistry;
  templates: TemplateRepo;
  buckets: { inbox: string; outputs: string; runs: string };
  maxUploadBytes: number;
  /** Token access (ADR 0006). null disables enforcement - unit tests only. */
  access: AccessRepo | null;
  /** Fastify trustProxy: whose X-Forwarded-* to believe (client IP, https). */
  trustProxy?: string | boolean;
  logger?: boolean | { level: string };
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

/** The proxies in front of the API (app nginx, NGINX Proxy Manager) live on private networks. */
export const PRIVATE_NETWORKS = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1,fc00::/7';

/** Composition root. Tests call this with in-memory deps and use `app.inject()`. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // TRUST_PROXY adds to the private networks: the app nginx (Docker network) must stay trusted,
  // or X-Forwarded-Proto/-For from the TLS proxy would be ignored.
  const trustProxy =
    typeof deps.trustProxy === 'string' && deps.trustProxy.trim()
      ? `${PRIVATE_NETWORKS},${deps.trustProxy}`
      : (deps.trustProxy ?? PRIVATE_NETWORKS);
  const app = Fastify({ logger: deps.logger ?? false, trustProxy });
  app.decorate('deps', deps);

  await app.register(multipart, { limits: { fileSize: deps.maxUploadBytes, files: 1 } });
  await app.register(cookie);
  await registerAccess(app); // before the route plugins: its hook must cover them all

  await app.register(healthRoutes);
  await app.register(specRoutes, { prefix: '/api' });
  await app.register(documentRoutes, { prefix: '/api' });
  await app.register(jobRoutes, { prefix: '/api' });
  await app.register(modelRoutes, { prefix: '/api' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(templateRoutes, { prefix: '/api' });
  await app.register(referenceRoutes, { prefix: '/api' });
  await app.register(resultRoutes, { prefix: '/api' });

  return app;
}
