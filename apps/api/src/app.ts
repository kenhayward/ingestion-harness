import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
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
  logger?: boolean | { level: string };
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

/** Composition root. Tests call this with in-memory deps and use `app.inject()`. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorate('deps', deps);

  await app.register(multipart, { limits: { fileSize: deps.maxUploadBytes, files: 1 } });

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
