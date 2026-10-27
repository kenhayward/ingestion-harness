import { DecomposedDocumentSchema } from '@ih/bridge-contract';
import { decompositionHeldManifestKey, decompositionHeldPageKey, type Item } from '@ih/shared';
import { z } from 'zod';
import type { ObjectStore } from '../storage/object-store.js';

/**
 * The held manifest the worker writes beside a PDF held for review (worker `decompose/hold.py`,
 * `HeldManifest`; its camelCase shape is a contract). Only what the API reads is checked here;
 * `document` is the decomposed document as it would be delivered, validated against the contract.
 */
const HeldManifestSchema = z.object({
  version: z.literal(1),
  document: DecomposedDocumentSchema,
  images: z.array(z.object({ id: z.string(), key: z.string(), contentType: z.string() })),
  pageCount: z.number().int().nonnegative(),
  pageMap: z.record(z.string(), z.array(z.number().int().positive())),
});
export type HeldManifest = z.infer<typeof HeldManifestSchema>;

/** Why the manifest could not be read: gone from storage, or not what the worker writes. */
export type HeldRead = { ok: true; manifest: HeldManifest } | { ok: false; reason: 'gone' | 'bad' };

/** The prefix every held file of the item lives under. */
const heldPrefix = (item: Pick<Item, 'batchId' | 'id'>) =>
  decompositionHeldManifestKey(item.batchId, item.id).replace(/manifest\.json$/, '');

/**
 * Whether a key the manifest names is one of the item's own held files: only those are ever
 * read or deleted, whatever a manifest says.
 */
export const isHeldKey = (item: Pick<Item, 'batchId' | 'id'>, key: string) =>
  key.startsWith(heldPrefix(item)) && !key.includes('..');

/** The item's held manifest. A storage error is thrown (the caller says it is unavailable). */
export async function readHeld(store: ObjectStore, bucket: string, item: Item): Promise<HeldRead> {
  const raw = await store.get(bucket, decompositionHeldManifestKey(item.batchId, item.id));
  if (!raw) return { ok: false, reason: 'gone' };
  try {
    const parsed = HeldManifestSchema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, reason: 'bad' };
  } catch {
    return { ok: false, reason: 'bad' };
  }
}

/**
 * Delete the item's held files, what the manifest names and then the manifest (the mirror of the
 * worker's `delete_held`). Missing objects, and no manifest at all, are no error. A manifest the
 * API cannot read is left alone: it cannot say what else is held.
 */
export async function deleteHeld(store: ObjectStore, bucket: string, item: Item): Promise<void> {
  const held = await readHeld(store, bucket, item);
  if (!held.ok) {
    if (held.reason === 'bad') throw new Error('the held manifest is not readable');
    return;
  }
  const { images, pageCount } = held.manifest;
  for (const image of images) {
    if (isHeldKey(item, image.key)) await store.delete(bucket, image.key);
  }
  for (let page = 1; page <= pageCount; page++) {
    await store.delete(bucket, decompositionHeldPageKey(item.batchId, item.id, page));
  }
  await store.delete(bucket, decompositionHeldManifestKey(item.batchId, item.id));
}
