import { z } from 'zod';

/** The seeded target every recipe without `delivery.publishTo` delivers to. */
export const DEFAULT_TARGET_ID = 'default';

/**
 * The triple store target, seeded from `RDF_ENDPOINT` (delivery bridge phase 3): recipes that
 * deliver `rdf` load their graphs into it as well as delivering to their S3 target.
 */
export const TRIPLE_STORE_TARGET_ID = 'rdf-default';

/** A publishing target's id, as a recipe's `delivery.publishTo` names it. */
export const TARGET_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const TargetIdSchema = z.string().regex(TARGET_ID, 'a publishing target id');

/** The most targets one recipe delivers to (delivery bridge phase 4). */
export const MAX_PUBLISH_TARGETS = 8;

/**
 * A recipe's `delivery.publishTo`: one target id, or a list of 1 to `MAX_PUBLISH_TARGETS`
 * distinct ids in order. A one-item list means the same as the string; the editor writes the
 * string, so recipes that keep one target keep their hash.
 */
export const PublishToSchema = z.union([
  TargetIdSchema,
  z
    .array(TargetIdSchema)
    .min(1)
    .max(MAX_PUBLISH_TARGETS)
    .refine((ids) => new Set(ids).size === ids.length, 'a target is listed twice'),
]);
export type PublishTo = z.infer<typeof PublishToSchema>;

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

/** What an admin can create: S3 targets. */
export const TARGET_KINDS = ['internal', 'external'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
/** Every kind a stored target has: S3, or the triple store seeded from `RDF_ENDPOINT`. */
export const PUBLISH_TARGET_KINDS = ['internal', 'external', 'rdf'] as const;

/**
 * How an S3 target writes a package: `files`, each rendered file at its key (today's keys), or
 * `package`, the whole package as an archive under `packages/{idempotency key}/`. The triple
 * store is always `files`.
 */
export const TARGET_LAYOUTS = ['files', 'package'] as const;
export type TargetLayout = (typeof TARGET_LAYOUTS)[number];
export type PublishTargetKind = (typeof PUBLISH_TARGET_KINDS)[number];
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

/** A connection id on the delivery bridge (where a target's credentials live). */
export const ConnectionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'a connection id');

export const CONNECTION_STATUSES = ['ok', 'needs_attention', 'untested'] as const;

/** A shared connection as the bridge shows it to CT Studio: never a credential. */
export const TargetConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(CONNECTION_STATUSES),
  statusReason: z.string().nullable(),
});
export type TargetConnection = z.infer<typeof TargetConnectionSchema>;

export const PublishTargetViewSchema = z.object({
  id: TargetIdSchema,
  label: z.string(),
  kind: z.enum(PUBLISH_TARGET_KINDS),
  /** S3: the bucket. The triple store: its dataset. */
  bucket: z.string(),
  prefix: z.string(),
  /** The triple store's URL (S3 targets: null; their endpoint is the connection's). */
  endpoint: z.string().nullable(),
  /** The bridge connection an external target delivers with (internal targets: null). */
  connectionId: z.string().nullable(),
  /** That connection as the bridge describes it now; null when there is none, or it is unknown. */
  connection: TargetConnectionSchema.nullable(),
  sse: z.enum(SSE_MODES),
  kmsKeyId: z.string().nullable(),
  storageClass: z.string().nullable(),
  layout: z.enum(TARGET_LAYOUTS),
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

const EXTERNAL_ONLY = ['connectionId', 'sse', 'kmsKeyId', 'storageClass'] as const;

/** A target's fields without defaults: patches and tests keep what they leave out. */
const TARGET_FIELDS = {
  id: TargetIdSchema.optional(),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(TARGET_KINDS, {
    error: 'kind is internal or external: triple store targets come from RDF_ENDPOINT',
  }),
  bucket: BucketSchema,
  prefix: PrefixSchema,
  /** External targets: the bridge connection holding the credentials. */
  connectionId: ConnectionIdSchema.optional(),
  sse: z.enum(SSE_MODES),
  kmsKeyId: z.string().min(1).optional(),
  storageClass: z.enum(STORAGE_CLASSES).optional(),
  layout: z.enum(TARGET_LAYOUTS),
};

const TargetFieldsSchema = z
  .object({
    ...TARGET_FIELDS,
    prefix: TARGET_FIELDS.prefix.default(''),
    sse: TARGET_FIELDS.sse.default('none'),
    layout: TARGET_FIELDS.layout.default('files'),
  })
  .strict();

/** The create rules, shared by a create and a test of unsaved settings. */
function checkTarget(
  b: Pick<z.infer<typeof TargetFieldsSchema>, 'kind' | (typeof EXTERNAL_ONLY)[number]>,
  ctx: z.RefinementCtx,
): void {
  const add = (message: string, path: string[] = []) =>
    ctx.addIssue({ code: 'custom', message, path });
  if (b.kind === 'internal') {
    const touched = EXTERNAL_ONLY.filter((k) => {
      const v = b[k];
      return v !== undefined && v !== 'none';
    });
    if (touched.length > 0) add('internal targets take only a bucket and prefix', [touched[0]!]);
    return;
  }
  if (!b.connectionId) add('an external target needs a connection', ['connectionId']);
  // The bridge's own S3 keys reach CT Studio's own buckets: only internal targets (and their
  // bucket rules) may use them.
  if (b.connectionId === 'internal') {
    add('the built-in connection is for internal targets only', ['connectionId']);
  }
  if (b.kmsKeyId && b.sse !== 'aws:kms') add('a KMS key needs sse "aws:kms"', ['kmsKeyId']);
}

/** No credential is ever accepted here: they live on the delivery bridge's connections page. */
export const TargetCreateBodySchema = TargetFieldsSchema.superRefine(checkTarget);
export type TargetCreateBody = z.infer<typeof TargetCreateBodySchema>;

/** What `null` clears in a patch. */
const CLEARABLE = {
  kmsKeyId: z.string().min(1).nullable(),
  storageClass: z.enum(STORAGE_CLASSES).nullable(),
};

/** Fields left out are kept; `null` clears the KMS key or storage class. */
export const TargetPatchBodySchema = z
  .object(TARGET_FIELDS)
  .omit({ id: true, kind: true })
  .extend(CLEARABLE)
  .partial()
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');
export type TargetPatchBody = z.infer<typeof TargetPatchBodySchema>;

/**
 * Test connection: a saved target by its id alone, or settings not saved yet (a create body
 * whose label may be left out).
 */
export const TargetTestBodySchema = z.union([
  z.object({ id: TargetIdSchema }).strict(),
  TargetFieldsSchema.extend({ label: TARGET_FIELDS.label.optional() })
    .omit({ id: true })
    .superRefine(checkTarget),
]);
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
  prefix: z.string(),
  layout: z.enum(TARGET_LAYOUTS),
});
export type TargetChoice = z.infer<typeof TargetChoiceSchema>;

/**
 * The targets a recipe delivers to, in its order; absent means `["default"]`. The triple store
 * (`rdf-default`) is never listed: the worker adds it when the recipe delivers `rdf`.
 */
export function publishTargetsOf(definition: { delivery?: { publishTo?: PublishTo } }): string[] {
  const to = definition.delivery?.publishTo;
  if (to === undefined) return [DEFAULT_TARGET_ID];
  return typeof to === 'string' ? [to] : [...to];
}
