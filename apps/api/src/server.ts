import pg from 'pg';
import { PgAccessRepo } from './access/pg.js';
import { SIGN_IN_RETENTION_DAYS } from './access/repo.js';
import { buildApp } from './app.js';
import {
  githubConfig,
  loadConfig,
  s3KeysConfig,
  targetConfig,
  versionFromConfig,
} from './config.js';
import { PgJobWatch } from './jobs/watch.js';
import { PgLlmConfigRepo } from './llm/repo.js';
import { PgOntologyRepo } from './ontologies/repo.js';
import { PgGitHubSyncRepo } from './github-sync/pg.js';
import { HttpGitHub } from './profile/github.js';
import { PgProfileRepo } from './profile/pg.js';
import { PgLinkedDataRepo } from './linked-data/repo.js';
import { PgMaintenanceRepo } from './maintenance/repo.js';
import { secretsKeys } from './llm/secrets.js';
import { PgRepo } from './repositories/pg.js';
import { PgS3KeyRepo } from './s3keys/pg.js';
import { startReconciler } from './s3keys/reconciler.js';
import { SeaweedIamIssuer } from './s3keys/seaweed-iam.js';
import { S3KeyService } from './s3keys/service.js';
import { SpecRegistry } from './specs/spec-registry.js';
import { S3ObjectStore } from './storage/s3.js';
import { PgTemplateRepo } from './templates/repo.js';
import { seedTemplates } from './templates/seed.js';
import { warmListCache } from './workbench/list.js';
import { PgWorkbenchRepo } from './workbench/repo.js';

const config = loadConfig();
const target = targetConfig(config);
const repo = PgRepo.fromUrl(config.DATABASE_URL);
const templates = new PgTemplateRepo(
  new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 }),
);
const workbench = new PgWorkbenchRepo(
  new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 }),
);
const seeded = await seedTemplates(templates, config.SPECS_DIR);
const access = new PgAccessRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 }));
const githubOAuth = githubConfig(config);
const githubHttp = githubOAuth && new HttpGitHub(githubOAuth);
const s3 = {
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY,
  secretAccessKey: config.S3_SECRET_KEY,
};
// Read-only keys for the data lake (ADR 0008), issued through SeaweedFS's IAM with the admin
// identity; only when the publish target is that SeaweedFS.
const s3KeySettings = s3KeysConfig(config);
const s3Keys =
  s3KeySettings &&
  new S3KeyService({
    repo: new PgS3KeyRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })),
    issuer: new SeaweedIamIssuer(s3),
    ...s3KeySettings,
  });

// One LISTEN connection for every live job stream; errors are logged once the app has a logger.
let logWatchError: (err: unknown) => void = () => {};
const jobWatch = new PgJobWatch(config.DATABASE_URL, (err) => logWatchError(err));

const linkedData = new PgLinkedDataRepo(
  new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 }),
);
// .env seeds the customer and base once; Administration > Linked data wins afterwards.
if (config.LINKED_DATA_CUSTOMER) {
  const [slug, ...name] = config.LINKED_DATA_CUSTOMER.split('=');
  await linkedData.seed({
    customerSlug: slug!.trim(),
    customerName: name.join('=').trim() || slug!.trim(),
    baseIri: config.LINKED_DATA_BASE_IRI ?? null,
  });
}

const app = await buildApp({
  repo,
  jobWatch,
  templates,
  workbench,
  store: new S3ObjectStore(s3),
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
  profiles: new PgProfileRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })),
  githubSync: new PgGitHubSyncRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })),
  github: githubHttp,
  githubRepos: githubHttp,
  githubRedirectUrl: githubOAuth?.redirectUrl ?? null,
  s3Keys,
  llm: new PgLlmConfigRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })),
  ontologies: new PgOntologyRepo(new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 })),
  linkedData,
  maintenance: new PgMaintenanceRepo(
    new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 }),
  ),
  ontologyFetch: {
    hosts: config.ONTOLOGY_FETCH_ALLOW.split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    maxBytes: config.ONTOLOGY_MAX_BYTES,
  },
  // Throws on a malformed key: better a failed start than keys that can't be read back.
  llmSecrets: secretsKeys(process.env),
  ...(config.TRUST_PROXY ? { trustProxy: config.TRUST_PROXY } : {}),
  frameAncestors: config.FRAME_ANCESTORS,
  version: versionFromConfig(config),
  rdfPublicUrl: config.RDF_PUBLIC_URL ?? null,
  logger: { level: config.LOG_LEVEL },
});

logWatchError = (err) => app.log.warn({ err }, 'job change notifications lost; reconnecting');

let stopReconciler = () => {};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopReconciler();
    await app.close();
    await jobWatch.close();
    await repo.close();
    process.exit(0);
  });
}

if (seeded.length) app.log.info({ seeded }, 'imported template files into the database');
// A new password for the admin from the log on every start (deploy/restart); the previous one
// and its sessions end (ADR 0013). Rotated before listening, so a failure stops startup rather
// than serving without an admin.
const adminToken = await access.rotateAdminPassword();
// Written straight to stdout (not the logger): printed whatever LOG_LEVEL is, and in a fixed
// shape deploy/scripts/admin-token.sh matches exactly (request URLs can't forge it - no spaces).
process.stdout.write(`ADMIN TOKEN (valid until the next restart): ${adminToken}\n`);
process.stdout.write('Sign in as "admin" with that token as the password.\n');
await app.listen({ host: config.HOST, port: config.PORT });
// Sign-in events are kept SIGN_IN_RETENTION_DAYS (D11): pruned now and every hour.
const pruneSignIns = () =>
  access
    .pruneSignIns(new Date(Date.now() - SIGN_IN_RETENTION_DAYS * 86_400_000))
    .then((removed) => app.log.debug({ removed }, 'old sign-in events pruned'))
    .catch((err: unknown) => app.log.warn({ err }, 'sign-in event pruning failed'));
void pruneSignIns();
setInterval(() => void pruneSignIns(), 3_600_000).unref();
if (s3Keys) stopReconciler = startReconciler(s3Keys, app.log);
// Fill the project list cache in the background (a cold cache takes seconds at scale).
warmListCache(app).catch((err) => app.log.warn({ err }, 'project list cache warm-up failed'));
