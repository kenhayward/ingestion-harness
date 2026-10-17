import { z } from 'zod';

/**
 * Backup and restore from Administration: the manifest inside a backup, the views the API
 * returns, and the bodies it accepts. See the backup and restore design spec.
 */

export const BACKUP_FORMAT_VERSION = 1;
/** Size of one part of a chunked upload (64 MiB). */
export const BACKUP_PART_BYTES = 67108864;

export const BucketRoleSchema = z.enum(['inbox', 'outputs', 'runs', 'target']);
export type BucketRole = z.infer<typeof BucketRoleSchema>;

export const BackupManifestSchema = z
  .object({
    format: z.literal('ct-backup'),
    formatVersion: z.literal(BACKUP_FORMAT_VERSION),
    appVersion: z.string(),
    commit: z.string().nullable(),
    lastMigration: z.string(),
    migrations: z.array(z.string()),
    instanceName: z.string(),
    baseIri: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    createdBy: z.string(),
    buckets: z.array(
      z.object({
        role: BucketRoleSchema,
        name: z.string(),
        objects: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      }),
    ),
    parts: z.array(
      z.object({
        name: z.string(),
        bytes: z.number().int().nonnegative(),
        sha256: z.string(),
      }),
    ),
    fuseki: z.boolean(),
    lakeIdentities: z.number().int().nonnegative(),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export const BackupProgressSchema = z.object({
  phase: z.enum(['database', 'objects', 'identities', 'triples', 'finishing']),
  done: z.number(),
  of: z.number(),
  bytes: z.number(),
});

export const BackupViewSchema = z.object({
  id: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  createdBy: z.string(),
  bytes: z.number().nullable(),
  error: z.string().nullable(),
  progress: BackupProgressSchema.nullable(),
});
export type BackupView = z.infer<typeof BackupViewSchema>;

export const RestoreModeSchema = z.enum(['deployment', 'copy']);
export type RestoreMode = z.infer<typeof RestoreModeSchema>;

export const COPY_KEY_MESSAGE = 'paste the key of the deployment this backup came from';

export const RestoreStartBodySchema = z
  .object({
    uploadId: z.string().uuid(),
    mode: RestoreModeSchema,
    key: z.string().optional(),
  })
  .refine((b) => b.mode !== 'copy' || (b.key !== undefined && b.key !== ''), {
    message: COPY_KEY_MESSAGE,
    path: ['key'],
  });
export type RestoreStartBody = z.infer<typeof RestoreStartBodySchema>;

export const RestorePhaseSchema = z.enum([
  'checking',
  'checked',
  'restoring',
  'succeeded',
  'failed',
]);
export type RestorePhase = z.infer<typeof RestorePhaseSchema>;

export const RestoreReportSchema = z.object({
  restored: z.array(z.object({ table: z.string(), rows: z.number() })),
  objects: z.number(),
  missingObjects: z.array(z.object({ bucket: z.string(), key: z.string() })),
  copy: z
    .object({
      cancelledJobs: z.number(),
      droppedTargets: z.array(z.string()),
      withdrawnOutputs: z.number(),
      recipesNeedingModel: z.array(z.string()),
      recipesNeedingTarget: z.array(z.string()),
    })
    .nullable(),
  triples: z.enum(['restored', 'none-in-backup', 'no-triple-store', 'reminting']),
  previousDatabase: z.string(),
  adminTokenRotated: z.literal(true),
});
export type RestoreReport = z.infer<typeof RestoreReportSchema>;

export const RestorePlanSchema = z.object({
  dropped: z.array(z.string()),
  kept: z.array(z.string()),
});

export const RestoreStatusSchema = z.object({
  id: z.string(),
  mode: RestoreModeSchema,
  phase: RestorePhaseSchema,
  step: z.string().nullable(),
  done: z.number(),
  of: z.number(),
  manifest: BackupManifestSchema.nullable(),
  plan: RestorePlanSchema.nullable(),
  error: z.string().nullable(),
  report: RestoreReportSchema.nullable(),
  startedBy: z.string(),
  updatedAt: z.string(),
});
export type RestoreStatus = z.infer<typeof RestoreStatusSchema>;

export const RestoreConfirmBodySchema = z.object({ instanceName: z.string() });
export type RestoreConfirmBody = z.infer<typeof RestoreConfirmBodySchema>;

export const QueueControlViewSchema = z.object({
  paused: z.boolean(),
  pausedAt: z.string().nullable(),
  pausedBy: z.string().nullable(),
  reason: z.string().nullable(),
});
export type QueueControlView = z.infer<typeof QueueControlViewSchema>;

export const QueueControlBodySchema = z.object({ paused: z.boolean() });
export type QueueControlBody = z.infer<typeof QueueControlBodySchema>;

export const UploadViewSchema = z.object({
  id: z.string(),
  size: z.number(),
  partBytes: z.number(),
  parts: z.number(),
  received: z.array(z.number()),
});
export type UploadView = z.infer<typeof UploadViewSchema>;

export const UploadStartBodySchema = z.object({
  size: z
    .number()
    .int()
    .min(1)
    .max(2 ** 40),
  fileName: z.string().min(1).max(255),
});
export type UploadStartBody = z.infer<typeof UploadStartBodySchema>;

/** What a copy restore drops and keeps, worded for the confirmation dialog. */
export const copyPlan = (): { dropped: string[]; kept: string[] } => ({
  dropped: [
    "GitHub connections and users' linked GitHub accounts",
    'External publishing targets',
    "The backup's model endpoints, keys, model choices and settings",
    'Data-lake S3 keys',
    'Queued and running jobs (cancelled)',
  ],
  kept: [
    "This server's model endpoints, choices and settings",
    "This server's publishing targets",
    "This server's GitHub settings and instance name",
    "This server's data-lake keys",
    "This server's base IRI (graphs are re-minted)",
  ],
});
