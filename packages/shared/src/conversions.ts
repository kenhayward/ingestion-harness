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
  'awaiting_review',
  'rejected',
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

/**
 * What became of an item's document since (§8), read from the item's register entry:
 * - `detached`: the entry was detached, or is gone (the worker replaces a detached tombstone
 *   with a new entry);
 * - `accepted`: the target's state was accepted;
 * - `superseded`: the item was refused as changed in the target, and that refusal is no longer
 *   the entry's: a later run moved it on (pending, delivered, incomplete, failed), or refused it
 *   again from a newer delivery (changed, from another batch, after this item's batch started).
 *   Neither detach nor accept applies to such an item.
 *
 * Null: none of these.
 */
export const ITEM_RESOLUTIONS = ['detached', 'accepted', 'superseded'] as const;
export const ItemResolutionSchema = z.enum(ITEM_RESOLUTIONS);
export type ItemResolution = z.infer<typeof ItemResolutionSchema>;

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
    resolution: ItemResolutionSchema.nullable(),
    /**
     * The item's register entry holds a document whose component versions were never recorded
     * (the worker's `unresolved`, §8): no update can be checked against the target's copy, and
     * only detach resolves it. Read from the entry, like `resolution`: it has a persistent id,
     * no recorded components, and is neither pending nor detached.
     */
    unversioned: z.boolean(),
    /**
     * The item's register entry is gone from the target (§8, owner's call 2026-10-26): it has a
     * persistent id and failed because the sink refused its update with the missing-document
     * marker for that document (`not_found`, details `reason: document_missing` and its
     * `persistentId`; deleted there, say). Any other `not_found` is not gone. Updating it can
     * never go through: only *Load as a new document* (`POST /api/conversions/items/{id}/reload`)
     * or detach resolves it. Read from the entry, like `unversioned`.
     */
    gone: z.boolean(),
    /**
     * The item's register entry is a create the target may have taken: it has no document, and
     * failed with an error that was not a refusal before acceptance. The worker sends it again
     * only under its stored key, and a sink that refuses that key for good (one whose earlier
     * delivery stopped part-way) leaves it stuck, force or not. Only detach frees it: the next
     * run then creates under a new key, so check the target for a document it left first.
     */
    unconfirmed: z.boolean(),
    /**
     * The item's register entry failed because the sink refused its key as part-way (details
     * `reason: delivery_part_way`): an earlier delivery under that key stopped part-way and may
     * have left topics, or a partly updated document, in the target. The worker sends it again
     * only under that key, which the sink never takes, so only detach frees it (owner's call,
     * 2026-10-28): the next run then creates a new document, so check the target first.
     */
    partWay: z.boolean(),
    /**
     * Links the target gave with the refusal or failure of the item's register entry (the bridge
     * error's `details.links`, e.g. the document and the component that blocked it): web
     * addresses only, at most five, labels cut to 100 characters. Read from the entry while it is
     * `changed` or `failed`, like `gone`; empty otherwise.
     */
    links: z.array(z.object({ label: z.string(), url: z.string() })),
    /**
     * Whether *Load as a new document* applies, exactly as the route decides: the entry is gone,
     * or is still the detached tombstone (no later create replaced it), and the row is not
     * `superseded`. A reload whose rerun failed after its detach can so be tried again.
     */
    reloadable: z.boolean(),
    /**
     * The batch this item was last run again in (an item naming it as `redeliverOf`: a re-run,
     * force-load, redeliver or reload), and when that batch started; null when it never was.
     * Re-running failed documents (`POST /api/conversions/batches/{id}/retry`) takes an item
     * only while this is null: a failed re-run is re-run from its own batch.
     */
    rerunIn: z.string().uuid().nullable(),
    rerunAt: z.string().nullable(),
    /**
     * When the worker first took the item (`decomposing`; a retry keeps it), and when it reached
     * a final outcome (the worker's decision, or the settle of its delivery); null until then,
     * and for items converted before migration 202610261331.
     */
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    /**
     * How many flags the decomposition report holds (null until the worker wrote the report, and
     * for items converted before migration 202610271200): a Word row says it, and a PDF is held
     * for review whatever it is.
     */
    flagCount: z.number().int().nonnegative().nullable(),
    /**
     * A converted PDF is held for review: its held files are in the runs bucket. True only while
     * the item is `awaiting_review` (not once it is approved, rejected or delivered).
     */
    held: z.boolean(),
    /** Who approved or rejected the held document, and when, with their note (§14). */
    reviewedBy: BatchCreatorSchema.nullable(),
    reviewedAt: z.string().nullable(),
    reviewNote: z.string().nullable(),
  })
  .strict();
export type Item = z.infer<typeof ItemSchema>;

/**
 * What a document gone from the target says on its row (the API's settle and the worker's
 * `deliver.GONE`, word for word).
 */
export const GONE_DETAIL =
  'The target no longer has this document (it may have been deleted). Load it as a new ' +
  'document to create it again.';

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
    /** Deliver a held document as reviewed (an approval's run), not decompose the source again. */
    approved: z.boolean().optional(),
  })
  .strict();
export type DecomposeParams = z.infer<typeof DecomposeParamsSchema>;

/** A person's decision on a held document: approve, with an optional note. */
export const ReviewDecisionSchema = z.object({ note: z.string().optional() }).strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** Rejecting a held document says why: a note that is more than spaces (stored trimmed). */
export const RejectDecisionSchema = z.object({ note: z.string().trim().min(1) }).strict();
export type RejectDecision = z.infer<typeof RejectDecisionSchema>;

/**
 * What the review page reads for a held item (`GET /api/conversions/items/:id/review`), from the
 * worker's held manifest: the decomposed document as it would be delivered (a `DecomposedDocument`
 * of `@ih/bridge-contract`, which the API validates and this package does not depend on), the
 * pages it came from, and the held images by position (`/images/:index` serves each).
 */
export const ConversionReviewSchema = z
  .object({
    item: ItemSchema,
    document: z.record(z.string(), z.unknown()),
    pageCount: z.number().int().nonnegative(),
    /** The 1-based pages each section and block came from, by id. */
    pageMap: z.record(z.string(), z.array(z.number().int().positive())),
    images: z.array(z.object({ id: z.string(), contentType: z.string() })),
  })
  .strict();
export type ConversionReview = z.infer<typeof ConversionReviewSchema>;

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

/** The most documents one *Re-run failed* request names. */
export const MAX_RETRY_ITEMS = 1000;

/**
 * `POST /api/conversions/batches/{id}/retry`: the batch's failed items to run again (each once),
 * and whether to deliver them as an explicit update (absent: as the batch was started).
 */
export const RetryItemsSchema = z
  .object({
    itemIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_RETRY_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, 'each item once'),
    force: z.boolean().optional(),
  })
  .strict();
export type RetryItems = z.infer<typeof RetryItemsSchema>;

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

/**
 * One flag of a decomposition report (spec §5.9; worker `decompose.model.Flag`): its code, how
 * much it matters, where it applies (a section, block or table id) and what it says. The code is
 * any string, so a flag the worker learns later still shows.
 */
export const ReportFlagSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning']),
  at: z.string().nullable().optional(),
  message: z.string(),
});
export type ReportFlag = z.infer<typeof ReportFlagSchema>;

/** `GET /api/conversions/items/:id/report`: the report the worker wrote beside the source (R4). */
export const DecompositionReportSchema = z.object({ flags: z.array(ReportFlagSchema) });
export type DecompositionReport = z.infer<typeof DecompositionReportSchema>;
