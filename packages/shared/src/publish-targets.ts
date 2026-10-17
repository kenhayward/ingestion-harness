import { z } from 'zod';

/** The seeded target every recipe without `delivery.publishTo` delivers to. */
export const DEFAULT_TARGET_ID = 'default';

/** A publishing target's id, as a recipe's `delivery.publishTo` names it. */
export const TARGET_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const TargetIdSchema = z.string().regex(TARGET_ID, 'a publishing target id');

/** An id made from a label (slug; `target` when nothing is left or it is the reserved `default`). */
export function publishTargetIdFrom(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/, '');
  return slug && slug !== DEFAULT_TARGET_ID ? slug : 'target';
}

export const TARGET_KINDS = ['internal', 'external'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const SSE_MODES = ['none', 'AES256', 'aws:kms'] as const;
export const STORAGE_CLASSES = [
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'GLACIER_IR',
] as const;

/** Trim, drop leading `/`, end in `/` when not empty (held in step with the worker by a fixture). */
export function normalisePrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+/, '');
  return p === '' || p.endsWith('/') ? p : `${p}/`;
}

export const TargetUsageSchema = z.object({
  publishedVersions: z.number().int().nonnegative(),
  documentTypes: z.array(z.string()),
  deliveredOutputs: z.number().int().nonnegative(),
  consumers: z.number().int().nonnegative(),
  /** Queued or running `withdraw` jobs whose params name the target. */
  pendingJobs: z.number().int().nonnegative(),
});
export type TargetUsage = z.infer<typeof TargetUsageSchema>;

/**
 * In use: a published version, a recorded output or graph version, a consumer grant, or an
 * queued or running withdrawal names it.
 */
export function targetInUse(u: TargetUsage): boolean {
  return u.publishedVersions > 0 || u.deliveredOutputs > 0 || u.consumers > 0 || u.pendingJobs > 0;
}

export const PublishTargetViewSchema = z.object({
  id: TargetIdSchema,
  label: z.string(),
  kind: z.enum(TARGET_KINDS),
  bucket: z.string(),
  prefix: z.string(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  accessKeyId: z.string().nullable(),
  secretSet: z.boolean(),
  keysFromEnv: z.object({ accessKey: z.string(), secretKey: z.string() }).nullable(),
  forcePathStyle: z.boolean(),
  sse: z.enum(SSE_MODES),
  kmsKeyId: z.string().nullable(),
  storageClass: z.string().nullable(),
  source: z.enum(['env', 'ui']),
  editedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  usage: TargetUsageSchema,
});
export type PublishTargetView = z.infer<typeof PublishTargetViewSchema>;

const BucketSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/, 'not a valid S3 bucket name');

/** S3-safe key characters only: no wildcard or policy variable can widen a consumer's access. */
const PrefixSchema = z
  .string()
  .trim()
  .max(512)
  .regex(/^[A-Za-z0-9!_.'()/-]*$/, "prefix may use letters, digits and ! _ . ' ( ) / - only")
  .refine((p) => !p.split('/').includes('..'), 'prefix must not contain a .. segment');

const EXTERNAL_ONLY = [
  'endpoint',
  'region',
  'accessKeyId',
  'secretAccessKey',
  'forcePathStyle',
  'sse',
  'kmsKeyId',
  'storageClass',
] as const;

const TargetFieldsSchema = z
  .object({
    id: TargetIdSchema.optional(),
    label: z.string().trim().min(1).max(80),
    kind: z.enum(TARGET_KINDS),
    bucket: BucketSchema,
    prefix: PrefixSchema.default(''),
    endpoint: z.string().url().optional(),
    region: z.string().min(1).optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    forcePathStyle: z.boolean().default(false),
    sse: z.enum(SSE_MODES).default('none'),
    kmsKeyId: z.string().min(1).optional(),
    storageClass: z.enum(STORAGE_CLASSES).optional(),
  })
  .strict();

export const TargetCreateBodySchema = TargetFieldsSchema.superRefine((b, ctx) => {
  const add = (message: string, path: string[] = []) =>
    ctx.addIssue({ code: 'custom', message, path });
  if (b.kind === 'internal') {
    const touched = EXTERNAL_ONLY.filter((k) => {
      const v = b[k];
      return v !== undefined && v !== false && v !== 'none';
    });
    if (touched.length > 0) add('internal targets take only a bucket and prefix', [touched[0]!]);
    return;
  }
  if (!b.region) add('an external target needs a region', ['region']);
  if (!b.accessKeyId) add('an external target needs an access key id', ['accessKeyId']);
  if (!b.secretAccessKey) add('an external target needs a secret access key', ['secretAccessKey']);
  if (b.kmsKeyId && b.sse !== 'aws:kms') add('a KMS key needs sse "aws:kms"', ['kmsKeyId']);
});
export type TargetCreateBody = z.infer<typeof TargetCreateBodySchema>;

/** What `null` clears in a patch (or a test of a stored target). */
const CLEARABLE = {
  endpoint: z.string().url().nullable(),
  kmsKeyId: z.string().min(1).nullable(),
  storageClass: z.enum(STORAGE_CLASSES).nullable(),
};

/** Fields left out are kept; `null` clears the endpoint, KMS key or storage class. */
export const TargetPatchBodySchema = TargetFieldsSchema.omit({ id: true, kind: true })
  .extend(CLEARABLE)
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');
export type TargetPatchBody = z.infer<typeof TargetPatchBodySchema>;

/**
 * Test connection: an existing id tests its stored settings overlaid with the body; no id means
 * the body must be a full create body.
 */
export const TargetTestBodySchema = TargetFieldsSchema.extend(CLEARABLE)
  .partial()
  .strict()
  .superRefine((b, ctx) => {
    if (b.id !== undefined) return;
    const full = TargetCreateBodySchema.safeParse(b);
    if (!full.success) full.error.issues.forEach((i) => ctx.addIssue({ ...i }));
  });
export type TargetTestBody = z.infer<typeof TargetTestBodySchema>;

export const TargetTestResultSchema = z.object({
  ok: z.boolean(),
  step: z.enum(['connect', 'write', 'read', 'delete']).nullable(),
  message: z.string(),
});
export type TargetTestResult = z.infer<typeof TargetTestResultSchema>;

/** What a recipe's picker offers: no credentials, no endpoint. */
export const TargetChoiceSchema = z.object({
  id: TargetIdSchema,
  label: z.string(),
  kind: z.enum(TARGET_KINDS),
  bucket: z.string(),
});
export type TargetChoice = z.infer<typeof TargetChoiceSchema>;

/** The target a recipe delivers to; absent means `default`. */
export function deliveryPublishTo(definition: { delivery?: { publishTo?: string } }): string {
  return definition.delivery?.publishTo ?? DEFAULT_TARGET_ID;
}
