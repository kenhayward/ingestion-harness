import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PgRepo } from './repositories/pg.js';
import { SpecRegistry } from './specs/spec-registry.js';
import { S3ObjectStore } from './storage/s3.js';

const config = loadConfig();
const repo = PgRepo.fromUrl(config.DATABASE_URL);

const app = await buildApp({
  repo,
  store: new S3ObjectStore({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  }),
  specs: SpecRegistry.loadFromDir(config.SPECS_DIR),
  buckets: { inbox: config.S3_BUCKET_INBOX, outputs: config.S3_BUCKET_OUTPUTS },
  maxUploadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
  logger: { level: config.LOG_LEVEL },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await repo.close();
    process.exit(0);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
