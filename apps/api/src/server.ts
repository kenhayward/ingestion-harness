import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { effectiveBaseIri } from '@ih/shared';
import { PgAccessRepo } from './access/pg.js';
import { SIGN_IN_RETENTION_DAYS } from './access/repo.js';
import { buildApp } from './app.js';
import { internalTargetBuckets } from './backup/create.js';
import { FusekiTripleStore } from './backup/fuseki.js';
import { databaseName, PgDatabaseTools } from './backup/pg-tools.js';
import { PgQueueControlRepo } from './backup/queue-control.js';
import { PgLiveDatabase, PgSideDatabase } from './backup/restore-pg.js';
import { NoLakeIdentities } from './backup/seaweed-iam-file.js';
import { BackupService } from './backup/service.js';
import { BackupUploads } from './backup/uploads.js';
import {
  fusekiConfig,
  githubConfig,
  loadConfig,
  s3KeysConfig,
  versionFromConfig,
} from './config.js';
import { migrateRestored } from './db/migrate.js';
import { PgJobWatch } from './jobs/watch.js';
import { PgLlmConfigRepo } from './llm/repo.js';
import { PgOntologyRepo } from './ontologies/repo.js';
import { captureDeps, reconcileAll } from './mapping-memory/capture.js';
import { PgMappingMemoryRepo } from './mapping-memory/pg.js';
import { PgGitHubSyncRepo } from './github-sync/pg.js';
import { HttpGitHub } from './profile/github.js';
import { PgProfileRepo } from './profile/pg.js';
import { PgLinkedDataRepo } from './linked-data/repo.js';
import { PgMaintenanceRepo } from './maintenance/repo.js';
import { HttpBridgeApi } from './bridge/client.js';
import { HandoffCodes } from './bridge/handoff.js';
import { pullTargets, resyncAfterRestore, startTargetSync } from './bridge/sync.js';
import { reconcileOnce } from './bridge/reconcile.js';
import { reconcileUsersOnce } from './bridge/users-reconcile.js';
import { secretsKeys } from './llm/secrets.js';
import { PgPublishTargetRepo } from './publish-targets/pg.js';
import { PgPluginCatalogue } from './plugins/catalogue.js';
import { defaultSeed, rdfSeed } from './publish-targets/seed.js';
import { TargetStores } from './publish-targets/stores.js';
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
// An idle pooled connection the server ends (a restore's database swap terminates them all) emits
// 'error' on its pool; unhandled, that would crash the API. Logged through the app once it exists.
let logPoolError = (err: unknown) => console.error('database connection lost', err);
/** Every pool of the API: on the live database, with that error logged instead of thrown. */
const makePool = (max: number): pg.Pool => {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max });
  pool.on('error', (err) => logPoolError(err));
  return pool;
};
const repo = new PgRepo(makePool(10));
const templates = new PgTemplateRepo(makePool(5));
const workbench = new PgWorkbenchRepo(makePool(3));
const seeded = await seedTemplates(templates, config.SPECS_DIR);
const access = new PgAccessRepo(makePool(3));
const githubOAuth = githubConfig(config);
const githubHttp = githubOAuth && new HttpGitHub(githubOAuth);
const s3 = {
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  accessKeyId: config.S3_ACCESS_KEY,
  secretAccessKey: config.S3_SECRET_KEY,
};
// One LISTEN connection for every live job stream; errors are logged once the app has a logger.
let logWatchError: (err: unknown) => void = () => {};
const jobWatch = new PgJobWatch(config.DATABASE_URL, (err) => logWatchError(err));

// Throws on a malformed key: better a failed start than keys that can't be read back.
const llmSecrets = secretsKeys(process.env);
// Publishing targets: the delivery bridge's registry, cached in publish_targets. .env seeds
// `default` (and the triple store from RDF_ENDPOINT) on the bridge once; the bridge wins afterwards.
const targets = new PgPublishTargetRepo(makePool(2));
const plugins = new PgPluginCatalogue(makePool(1));
const seed = defaultSeed(config);
const tripleStoreSeed = rdfSeed(config);
// Internal targets' buckets are created on this deployment's SeaweedFS when they are saved.
const targetStores = new TargetStores({ internal: s3 });
// The delivery bridge publishes and holds the targets; their old keys are moved there once.
const bridge = new HttpBridgeApi(config.BRIDGE_URL, config.BRIDGE_CLIENT_KEY);
const bridgeAuth = {
  key: config.BRIDGE_CLIENT_KEY,
  publicUrl: config.BRIDGE_PUBLIC_URL,
  ...(config.BRIDGE_APP_ORIGIN ? { appOrigin: config.BRIDGE_APP_ORIGIN } : {}),
  codes: new HandoffCodes(),
};

// Read-only keys for the data lake (ADR 0008), issued through SeaweedFS's IAM with the admin
// identity, granted per internal publishing target.
const s3Keys = new S3KeyService({
  repo: new PgS3KeyRepo(makePool(2)),
  issuer: new SeaweedIamIssuer(s3),
  targets,
  ...s3KeysConfig(config),
});

const linkedData = new PgLinkedDataRepo(makePool(2));
// .env seeds the customer and base once; Administration > Linked data wins afterwards.
if (config.LINKED_DATA_CUSTOMER) {
  const [slug, ...name] = config.LINKED_DATA_CUSTOMER.split('=');
  await linkedData.seed({
    customerSlug: slug!.trim(),
    customerName: name.join('=').trim() || slug!.trim(),
    baseIri: config.LINKED_DATA_BASE_IRI ?? null,
  });
}

const store = new S3ObjectStore(s3);
const ontologies = new PgOntologyRepo(makePool(2));
const mappingMemory = new PgMappingMemoryRepo(makePool(2));
const githubSync = new PgGitHubSyncRepo(makePool(2));
const buckets = {
  inbox: config.S3_BUCKET_INBOX,
  outputs: config.S3_BUCKET_OUTPUTS,
  runs: config.S3_BUCKET_RUNS,
  backups: config.S3_BUCKET_BACKUPS,
};
const version = versionFromConfig(config);
const maintenance = new PgMaintenanceRepo(makePool(2));
// Backup and restore (Administration > Backup): every backup is encrypted under LLM_SECRETS_KEY,
// so without it there are none. Data-lake identities cannot be carried on SeaweedFS 4.48
// (seaweed-iam-file.ts).
let logBackupError: (obj: object, msg: string) => void = () => {};
const backup =
  llmSecrets &&
  new BackupService({
    db: new PgDatabaseTools(config.DATABASE_URL),
    store,
    buckets,
    // The bridge's package staging bucket is on this deployment's storage too.
    internalTargetBuckets: () =>
      internalTargetBuckets(targets, Object.values(buckets), [config.BRIDGE_STAGING_BUCKET]),
    triples: new FusekiTripleStore(fusekiConfig(config)),
    lake: new NoLakeIdentities(),
    master: llmSecrets.current,
    previousMaster: llmSecrets.previous,
    version: { appVersion: version.version, commit: version.commit },
    instanceName: async () => (await githubSync.settings()).instanceName,
    baseIri: async () => effectiveBaseIri(await linkedData.get()) ?? '',
    now: () => new Date(),
    queue: new PgQueueControlRepo(makePool(1)),
    maintenance,
    log: { error: (obj, msg) => logBackupError(obj, msg) },
  });

const backupUploads = llmSecrets && new BackupUploads({ store, bucket: buckets.backups });

const app = await buildApp({
  repo,
  jobWatch,
  templates,
  workbench,
  store,
  plugins,
  targets,
  targetStores,
  bridge,
  bridgeAuth,
  specs: SpecRegistry.loadFromDir(config.SPECS_DIR),
  buckets,
  bridgeStagingBucket: config.BRIDGE_STAGING_BUCKET,
  maxUploadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
  access, // always enforced in production (ADR 0006)
  profiles: new PgProfileRepo(makePool(2)),
  githubSync,
  github: githubHttp,
  githubRepos: githubHttp,
  githubRedirectUrl: githubOAuth?.redirectUrl ?? null,
  s3Keys,
  llm: new PgLlmConfigRepo(makePool(2)),
  ontologies,
  mappingMemory,
  linkedData,
  maintenance,
  ontologyFetch: {
    hosts: config.ONTOLOGY_FETCH_ALLOW.split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    maxBytes: config.ONTOLOGY_MAX_BYTES,
  },
  llmSecrets,
  backup,
  backupUploads,
  ...(config.TRUST_PROXY ? { trustProxy: config.TRUST_PROXY } : {}),
  frameAncestors: config.FRAME_ANCESTORS,
  version,
  rdfPublicUrl: config.RDF_PUBLIC_URL ?? null,
  logger: { level: config.LOG_LEVEL },
});

logWatchError = (err) => app.log.warn({ err }, 'job change notifications lost; reconnecting');
logPoolError = (err) => app.log.warn({ err }, 'database connection lost; the pool reconnects');
logBackupError = (obj, msg) => app.log.error(obj, msg);

// Written straight to stdout (not the logger): printed whatever LOG_LEVEL is, and in a fixed
// shape deploy/scripts/admin-token.sh matches exactly (request URLs can't forge it - no spaces).
const printAdminToken = (token: string) => {
  process.stdout.write(`ADMIN TOKEN (valid until the next restart): ${token}\n`);
  process.stdout.write('Sign in as "admin" with that token as the password.\n');
};

// A restore (backup/restore.ts) migrates the restored database with this server's migrations,
// then rotates the admin token as a restart would: the restored database has its own sessions.
const migrationsDir =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../db/migrations', import.meta.url));
backup?.enableRestore({
  gate: app.maintenance,
  localMigrations: async () =>
    readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(),
  migrate: (url) =>
    migrateRestored(url, {
      migrations: migrationsDir,
      bridgeMigrations:
        process.env.BRIDGE_MIGRATIONS_DIR ??
        fileURLToPath(new URL('../../../db/bridge-migrations', import.meta.url)),
    }),
  rotateAdminToken: async () => printAdminToken(await access.rotateAdminPassword()),
  createEmbedJobs: (model) => ontologies.createEmbedJobs(model),
  liveDatabaseName: databaseName(config.DATABASE_URL),
  live: new PgLiveDatabase(makePool(2)),
  openSide: (url) => PgSideDatabase.open(url),
  lakeIssuer: new SeaweedIamIssuer(s3),
  // A restored target's keys from before the bridge are moved there, the triple store target is
  // seeded again (a backup from before it lacks it), and the cache takes the bridge's registry.
  onSwapped: () =>
    void resyncAfterRestore({
      targets,
      bridge,
      secrets: llmSecrets,
      log: app.log,
      seed,
      rdfSeed: tripleStoreSeed,
    }).catch((err: unknown) => app.log.error({ err }, 'restored targets could not be synced')),
});

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
// A restore cut off by this restart is marked failed, and maintenance stays on (restore.ts).
await backup
  ?.recover()
  .catch((err: unknown) => app.log.error({ err }, 'interrupted restores could not be checked'));
printAdminToken(adminToken);
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
// A delivery whose event was lost is read from the bridge, so no job is left delivering.
setInterval(
  () =>
    void reconcileOnce({ repo, bridge, targets }, new Date())
      .then((n) => n && app.log.info({ moved: n }, 'deliveries reconciled with the bridge'))
      .catch((err: unknown) => app.log.warn({ err }, 'delivery reconcile failed')),
  60_000,
).unref();
// The registry and the sinks' lanes are pulled again every 10 minutes, so a tenant's lane count
// changed on its sink reaches the worker without a restart (the start's sync pulls first).
setInterval(
  () =>
    void pullTargets({ targets, bridge, log: app.log }).catch((err: unknown) =>
      app.log.warn({ err }, 'publishing targets could not be pulled from the bridge'),
    ),
  600_000,
).unref();
// The personal connections of users who are gone are deleted on the bridge: now and hourly.
const reconcileUsers = () => reconcileUsersOnce({ users: access, bridge, log: app.log });
void reconcileUsers();
setInterval(() => void reconcileUsers(), 3_600_000).unref();
// In the background, retried until the bridge answers: old keys move to the bridge once, .env
// seeds the default and the triple store there, and the cache takes the bridge's registry.
void startTargetSync({
  targets,
  bridge,
  secrets: llmSecrets,
  log: app.log,
  seed,
  rdfSeed: tripleStoreSeed,
}).then(({ moved, skipped, pulled }) => {
  if (moved.length) app.log.info({ moved }, 'publishing target keys moved to the bridge');
  if (skipped.length) app.log.warn({ skipped }, 'publishing targets left without keys');
  app.log.info({ cached: pulled.cached }, 'publishing targets synced from the bridge');
});
// Fill the project list cache in the background (a cold cache takes seconds at scale).
warmListCache(app).catch((err) => app.log.warn({ err }, 'project list cache warm-up failed'));
// The mapping memory's backfill and repair: every recipe's votes recorded again.
reconcileAll(captureDeps(app.deps)).catch((err) =>
  app.log.warn({ err }, 'mapping memory reconcile failed'),
);
