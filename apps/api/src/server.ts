import pg from 'pg';
import { PgAccessRepo } from './access/pg.js';
import { buildApp } from './app.js';
import { loadConfig, targetConfig } from './config.js';
import { PgRepo } from './repositories/pg.js';
import { SpecRegistry } from './specs/spec-registry.js';
import { S3ObjectStore } from './storage/s3.js';
import { PgTemplateRepo } from './templates/repo.js';
import { seedTemplates } from './templates/seed.js';

const config = loadConfig();
const target = targetConfig(config);
const repo = PgRepo.fromUrl(config.DATABASE_URL);
const templates = new PgTemplateRepo(
  new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 }),
);
const seeded = await seedTemplates(templates, config.SPECS_DIR);
const access = new PgAccessRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 }));

const app = await buildApp({
  repo,
  templates,
  store: new S3ObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  }),
  targetStore: new S3ObjectStore({
    endpoint: target.endpoint,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
  }),
  target: { bucket: target.bucket, prefix: target.prefix },
  specs: SpecRegistry.loadFromDir(config.SPECS_DIR),
  buckets: {
    inbox: config.S3_BUCKET_INBOX,
    outputs: config.S3_BUCKET_OUTPUTS,
    runs: config.S3_BUCKET_RUNS,
  },
  maxUploadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
  access, // always enforced in production (ADR 0006)
  ...(config.TRUST_PROXY ? { trustProxy: config.TRUST_PROXY } : {}),
  logger: { level: config.LOG_LEVEL },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await repo.close();
    process.exit(0);
  });
}

if (seeded.length) app.log.info({ seeded }, 'imported template files into the database');
// A new admin token on every start (deploy/restart); the previous one and its sessions end.
// Rotated before listening, so a failure stops startup rather than serving without an admin.
const adminToken = await access.rotateAdminToken();
app.log.warn(`ADMIN TOKEN (valid until the next restart): ${adminToken}`);
await app.listen({ host: config.HOST, port: config.PORT });
