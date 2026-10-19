import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { VersionInfo } from '@ih/shared';
import type { AccessRepo } from './access/repo.js';
import { registerAccess } from './access/routes.js';
import type { BackupService } from './backup/service.js';
import type { BackupUploads } from './backup/uploads.js';
import type { JobWatch } from './jobs/watch.js';
import type { GitHubSyncRepo } from './github-sync/repo.js';
import type { GitHubOAuth, GitHubRepoApi } from './profile/github.js';
import type { ProfileRepo } from './profile/repo.js';
import { registerOpenApi } from './openapi/plugin.js';
import { jobLiveRoutes } from './routes/job-live.js';
import type { S3KeyService } from './s3keys/service.js';
import type { LlmConfigRepo } from './llm/repo.js';
import type { OntologyRepo } from './ontologies/repo.js';
import type { LinkedDataRepo } from './linked-data/repo.js';
import { MaintenanceGate, type MaintenanceRepo } from './maintenance/repo.js';
import type { SecretsKeys } from './llm/secrets.js';
import type { PublishTargetRepo } from './publish-targets/repo.js';
import type { TargetStores } from './publish-targets/stores.js';
import type { IngestionRepo } from './repositories/types.js';
import type { ObjectStore } from './storage/object-store.js';
import type { SpecRegistry } from './specs/spec-registry.js';
import type { TemplateRepo } from './templates/repo.js';
import type { MappingMemoryRepo } from './mapping-memory/repo.js';
import { captureDeps, recordRecipe, rememberingTemplates } from './mapping-memory/capture.js';
import { mappingMemoryRoutes } from './routes/mapping-memory.js';
import type { WorkbenchRepo } from './workbench/repo.js';
import { templateRoutes } from './routes/templates.js';
import { referenceRoutes } from './routes/references.js';
import { healthRoutes } from './routes/health.js';
import { versionRoutes } from './routes/version.js';
import { specRoutes } from './routes/specs.js';
import { documentRoutes } from './routes/documents.js';
import { jobRoutes } from './routes/jobs.js';
import { modelRoutes } from './routes/models.js';
import { reviewRoutes } from './routes/review.js';
import { resultRoutes } from './routes/results.js';
import { workbenchRoutes } from './routes/workbench.js';
import { workbenchBundleRoutes } from './routes/workbench-bundle.js';
import { workbenchOverviewRoutes } from './routes/workbench-overview.js';
import { workbenchGraphRoutes } from './routes/workbench-graph.js';
import { workbenchSuggestionRoutes } from './routes/workbench-suggestions.js';
import { workbenchPinsRoutes } from './routes/workbench-pins.js';
import { s3KeyRoutes } from './routes/s3-keys.js';
import { llmRoutes } from './routes/llm.js';
import { ontologyRoutes } from './routes/ontologies.js';
import { linkedDataRoutes } from './routes/linked-data.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { MemoryNonceStore, type NonceStore } from '@ih/bridge-contract';
import type { BridgeApi } from './bridge/client.js';
import type { HandoffCodes } from './bridge/handoff.js';
import { bridgeRoutes } from './routes/bridge.js';
import { publishTargetRoutes } from './routes/publish-targets.js';
import { backupRoutes } from './routes/backup.js';

export interface AppDeps {
  repo: IngestionRepo;
  store: ObjectStore;
  /** Publishing targets (migration 202610170019): where recipes deliver, edited under Administration. */
  targets: PublishTargetRepo;
  /** One object store per publishing target; published outputs are read through their own. */
  targetStores: TargetStores;
  /** The delivery bridge: targets are mirrored to it, published files read back through it. */
  bridge: BridgeApi;
  /**
   * How the bridge and CT Studio trust each other in this direction: the shared key its signed
   * calls carry, where browsers reach its connections page, and the one-time codes that hand a
   * signed-in user to that page.
   */
  bridgeAuth: { key: string; publicUrl: string; codes: HandoffCodes; nonces?: NonceStore };
  specs: SpecRegistry;
  templates: TemplateRepo;
  /** Workbench projects, samples and briefs (ADR 0007). */
  workbench: WorkbenchRepo;
  /** CT Studio's own buckets; `backups` holds backups and restore uploads. */
  buckets: { inbox: string; outputs: string; runs: string; backups: string };
  /** The delivery bridge's package staging bucket, on this deployment's storage too. */
  bridgeStagingBucket: string;
  maxUploadBytes: number;
  /** Token access (ADR 0006). null disables enforcement - unit tests only. */
  access: AccessRepo | null;
  /** Users' own profiles (docs/design/profile.md). */
  profiles: ProfileRepo;
  /** GitHub recipe sync: settings, links and push records (migration 0048). */
  githubSync: GitHubSyncRepo;
  /** The GitHub OAuth app (`GITHUB_CLIENT_ID`/`_SECRET`); null/absent: GitHub cannot be linked. */
  github?: GitHubOAuth | null;
  /** GitHub repositories for recipe sync (the same `HttpGitHub`); null/absent: sync is unavailable. */
  githubRepos?: GitHubRepoApi | null;
  /** How long a publish waits for its automatic GitHub push (default 15 s; tests shorten it). */
  githubAutoPushDeadlineMs?: number;
  /** `GITHUB_REDIRECT_URL`: the callback registered with GitHub; absent: from the request. */
  githubRedirectUrl?: string | null;
  /** Read-only S3 keys for the data lake (ADR 0008); null when the target isn't local SeaweedFS. */
  s3Keys: S3KeyService | null;
  /** LLM endpoints and curated models (ADR 0010), for Administration > Models. */
  llm: LlmConfigRepo;
  /** The ontology library (ADR 0011): imported versions and their indexed terms. */
  ontologies: OntologyRepo;
  /** The mapping memory (docs/design/mapping-memory.md): mappings designers accepted. */
  mappingMemory: MappingMemoryRepo;
  /** Who may be fetched by URL (ONTOLOGY_FETCH_ALLOW; empty: URL imports are off). */
  ontologyFetch: { hosts: string[]; maxBytes: number };
  /** The customer and the base IRI RDF is minted under (ADR 0011). */
  linkedData: LinkedDataRepo;
  /** Maintenance mode (migration 0048): only admins get in while it is on. */
  maintenance: MaintenanceRepo;
  /** `LLM_SECRETS_KEY` (and `_PREVIOUS`); null: keys can't be entered in the UI. */
  llmSecrets: SecretsKeys | null;
  /** Backup and restore under Administration > Backup; null without `LLM_SECRETS_KEY`. */
  backup: BackupService | null;
  /** Chunked upload of a backup to restore; null without `LLM_SECRETS_KEY`. */
  backupUploads: BackupUploads | null;
  /** Job change notifications for live streams (Postgres NOTIFY); null: heartbeats only. */
  jobWatch?: JobWatch | null;
  /** How often a live job stream re-reads its job and pings (default 15 s; tests shorten it). */
  liveHeartbeatMs?: number;
  /**
   * Sites allowed to frame the app (`FRAME_ANCESTORS`, ADR 0012): over HTTPS the session cookie
   * is then SameSite=None; Secure; Partitioned. null/absent: SameSite=Strict, no framing.
   */
  frameAncestors?: string | null;
  /** The build's version (`GET /api/version`, ADR 0014); default a dev build. */
  version?: VersionInfo;
  /** `RDF_PUBLIC_URL`: where consumers query the triple store (shown under Administration > Linked data). */
  rdfPublicUrl?: string | null;
  /** Fastify trustProxy: whose X-Forwarded-* to believe (client IP, https). */
  trustProxy?: string | boolean;
  logger?: boolean | { level: string };
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    /** Maintenance mode as the access hook reads it (cached briefly). */
    maintenance: MaintenanceGate;
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
  // Every recipe write that counts records the recipe's votes in the mapping memory.
  const remembering: AppDeps = {
    ...deps,
    templates: rememberingTemplates(
      deps.templates,
      async (id, by) => {
        await recordRecipe(captureDeps(deps), id, by);
      },
      (err, id) => app.log.warn({ err, id }, 'mapping memory not recorded'),
    ),
    // Signed calls from the bridge: nonces seen inside the replay window (one API instance).
    bridgeAuth: { ...deps.bridgeAuth, nonces: deps.bridgeAuth.nonces ?? new MemoryNonceStore() },
  };
  app.decorate('deps', remembering);
  app.decorate('maintenance', new MaintenanceGate(deps.maintenance));

  await app.register(multipart, { limits: { fileSize: deps.maxUploadBytes, files: 1 } });
  await app.register(cookie);
  await registerOpenApi(app); // before the routes: swagger collects them as they are added
  await registerAccess(app); // before the route plugins: its hook must cover them all

  await app.register(healthRoutes);
  await app.register(specRoutes, { prefix: '/api' });
  await app.register(documentRoutes, { prefix: '/api' });
  await app.register(jobRoutes, { prefix: '/api' });
  await app.register(jobLiveRoutes, { prefix: '/api' });
  await app.register(modelRoutes, { prefix: '/api' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(templateRoutes, { prefix: '/api' });
  await app.register(referenceRoutes, { prefix: '/api' });
  await app.register(resultRoutes, { prefix: '/api' });
  await app.register(workbenchRoutes, { prefix: '/api' });
  await app.register(workbenchBundleRoutes, { prefix: '/api' });
  await app.register(workbenchOverviewRoutes, { prefix: '/api' });
  await app.register(workbenchGraphRoutes, { prefix: '/api' });
  await app.register(workbenchSuggestionRoutes, { prefix: '/api' });
  await app.register(workbenchPinsRoutes, { prefix: '/api' });
  await app.register(s3KeyRoutes, { prefix: '/api' });
  await app.register(llmRoutes, { prefix: '/api' });
  await app.register(ontologyRoutes, { prefix: '/api' });
  await app.register(mappingMemoryRoutes, { prefix: '/api' });
  await app.register(linkedDataRoutes, { prefix: '/api' });
  await app.register(maintenanceRoutes, { prefix: '/api' });
  await app.register(publishTargetRoutes, { prefix: '/api' });
  await app.register(bridgeRoutes, { prefix: '/api' });
  await app.register(backupRoutes, { prefix: '/api' });
  await app.register(versionRoutes, { prefix: '/api' });

  return app;
}
