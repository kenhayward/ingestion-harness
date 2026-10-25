import { z } from 'zod';
import { TargetIdSchema } from './publish-targets.js';

/**
 * Decomposition batches (phase 3, migration 202610251200): a person uploads Word files or a
 * folder and delivers them as decomposed documents. Each file is an item; a `decompose` job
 * converts and delivers it (worker `decompose`). The outcome is the worker's `DeliveryOutcome`.
 */
export const ITEM_OUTCOMES = [
  'queued',
  'decomposing',
  'delivering',
  'created',
  'updated',
  'already_loaded',
  'duplicate',
  'in_flight',
  'changed_in_target',
  'read_back_mismatch',
  'unresolved',
  'failed',
] as const;
export const ItemOutcomeSchema = z.enum(ITEM_OUTCOMES);
export type ItemOutcome = z.infer<typeof ItemOutcomeSchema>;

export const BATCH_STATES = ['open', 'started', 'discarded'] as const;
export const BatchStateSchema = z.enum(BATCH_STATES);
export type BatchState = z.infer<typeof BatchStateSchema>;

/** Who started a batch: the acting-user snapshot (null parts without access control). */
export const BatchCreatorSchema = z
  .object({ id: z.string().nullable(), name: z.string().nullable() })
  .strict();

export const BatchSchema = z
  .object({
    id: z.string().uuid(),
    targetId: TargetIdSchema,
    createdBy: BatchCreatorSchema,
    state: BatchStateSchema,
    force: z.boolean(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
  })
  .strict();
export type Batch = z.infer<typeof BatchSchema>;

export const ItemSchema = z
  .object({
    id: z.string().uuid(),
    batchId: z.string().uuid(),
    sourceKey: z.string().min(1),
    filename: z.string().min(1),
    contentSha256: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    objectKey: z.string().min(1),
    jobId: z.string().uuid().nullable(),
    outcome: ItemOutcomeSchema,
    detail: z.string().nullable(),
    registerEntryId: z.string().uuid().nullable(),
    reportKey: z.string().nullable(),
    link: z.string().nullable(),
    redeliverOf: z.string().uuid().nullable(),
  })
  .strict();
export type Item = z.infer<typeof ItemSchema>;

/** The longest source key a batch takes (in its NFC form). */
export const MAX_SOURCE_KEY = 1024;

/** Whether a text holds a control character (U+0000 to U+001F, or U+007F). */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why a source key can't name a document, or null when it can. A source key is the register's
 * identity for a document (a folder path or a file name), so one document has one spelling: the
 * key is judged (and stored) in its NFC form, relative, `/`-separated, with no empty, `.` or
 * `..` parts. The API refuses others on upload; the Conversion tab checks the same rule.
 */
export function sourceKeyProblem(key: string): string | null {
  const nfc = key.normalize('NFC');
  if (!nfc) return 'the source key is empty';
  if (nfc.length > MAX_SOURCE_KEY) {
    return `the source key is longer than ${MAX_SOURCE_KEY} characters`;
  }
  if (hasControlCharacter(nfc)) return 'the source key holds a control character';
  if (nfc.includes('\\')) return 'the source key holds a backslash: use / between folders';
  if (nfc.startsWith('/') || nfc.endsWith('/')) {
    return 'the source key must not start or end with /';
  }
  for (const part of nfc.split('/')) {
    if (!part) return 'the source key has an empty part (//)';
    if (part === '.' || part === '..') return 'the source key has a `' + part + '` part';
  }
  return null;
}

/** A source key the rule takes (`sourceKeyProblem`). */
export const SourceKeySchema = z
  .string()
  .min(1)
  .refine((key) => sourceKeyProblem(key) === null, { message: 'not a valid source key' });

/** A `decompose` job's params (worker `decompose.DecomposeParams`). */
export const DecomposeParamsSchema = z
  .object({
    batchId: z.string().uuid(),
    itemId: z.string().uuid(),
    targetId: TargetIdSchema,
    sourceKey: SourceKeySchema,
    force: z.boolean(),
  })
  .strict();
export type DecomposeParams = z.infer<typeof DecomposeParamsSchema>;

/** How many of a batch's items have each outcome (every outcome present, zero or more). */
export const ItemCountsSchema = z.record(ItemOutcomeSchema, z.number().int().nonnegative());
export type ItemCounts = z.infer<typeof ItemCountsSchema>;

/** A batch as the Conversion tab lists it: its items counted per outcome. */
export const BatchSummarySchema = BatchSchema.extend({
  itemCount: z.number().int().nonnegative(),
  counts: ItemCountsSchema,
}).strict();
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

/** A batch with its items, in upload order. */
export const BatchDetailSchema = z
  .object({ batch: BatchSchema, items: z.array(ItemSchema) })
  .strict();
export type BatchDetail = z.infer<typeof BatchDetailSchema>;

/** A target that takes decomposed documents, as the Conversion tab offers it. */
export const ConversionTargetSchema = z
  .object({ id: TargetIdSchema, label: z.string(), sinkName: z.string() })
  .strict();
export type ConversionTarget = z.infer<typeof ConversionTargetSchema>;

/** `POST /api/conversions/batches`: the target, and whether this is an explicit update. */
export const CreateBatchSchema = z
  .object({ targetId: TargetIdSchema, force: z.boolean().optional() })
  .strict();
export type CreateBatch = z.infer<typeof CreateBatchSchema>;

/**
 * One component a `changed_in_target` refusal lists (bridge contract `changedInTargetDetails`):
 * its version when it was delivered, and now (null: gone from the target).
 */
export const ChangedComponentSchema = z
  .object({ id: z.string(), expected: z.string(), actual: z.string().nullable() })
  .strict();
export type ChangedComponent = z.infer<typeof ChangedComponentSchema>;

/**
 * `GET /api/conversions/items/:id/accept`: what accepting the target's state would record, read
 * from the refusal (plan ruling R5). `reason` says why it can't be accepted here. `updatedAt` is
 * when the register entry last changed (null: no entry); the confirm sends it back as `seen`.
 */
export const AcceptPreviewSchema = z
  .object({
    changed: z.array(ChangedComponentSchema),
    acceptable: z.boolean(),
    reason: z.string().optional(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type AcceptPreview = z.infer<typeof AcceptPreviewSchema>;

/**
 * `POST /api/conversions/items/:id/accept`: the person's explicit confirmation of the preview
 * they saw (`seen`: its `updatedAt`), refused when the entry has changed since.
 */
export const AcceptTargetStateSchema = z
  .object({ confirm: z.literal(true), seen: z.string().min(1) })
  .strict();
export type AcceptTargetState = z.infer<typeof AcceptTargetStateSchema>;

/** What an accepted target state recorded: the item, and the components accepted. */
export const AcceptedTargetStateSchema = z
  .object({ item: ItemSchema, changed: z.array(ChangedComponentSchema) })
  .strict();
export type AcceptedTargetState = z.infer<typeof AcceptedTargetStateSchema>;
