import type { ComponentVersion, Receipt } from '@ih/bridge-contract';
import { ChangedComponentSchema, type ChangedComponent } from '@ih/shared';
import { z } from 'zod';
import type { RegisterEntry } from '../repositories/types.js';

/**
 * Accepting the target's state (spec §8 "Resolving a refused document"; plan ruling R5): the
 * bridge has no call that reads a document's current versions, so the `changed_in_target`
 * refusal's details are what the target holds now. Each listed component takes its `actual`
 * version, one gone from the target (`actual: null`) is dropped, and one the target added
 * (listed as not expected) is added. The result is what the next update expects.
 */
export interface AcceptPlan {
  /** What the refusal listed, as the person is shown it. */
  changed: ChangedComponent[];
  /** Why it can't be accepted here; null when it can. */
  reason: string | null;
  /** The components the entry's last receipt holds once accepted. */
  components: ComponentVersion[];
}

export const NOT_CHANGED = 'the document is not changed in the target';
export const TOO_MANY = 'too many changes to accept here; detach instead';
const UNLISTED = 'the refusal does not list what changed; detach instead';
const NO_VERSIONS = 'no component versions are recorded for this document; detach instead';
const CUT = 'a component id or version is too long to accept here; detach instead';
const GONE = 'the document is gone from the target; detach instead';

/** The kind recorded for a component the target added: the refusal gives only its id. */
export const ADDED_KIND = 'component';

/** A refusal's details (bridge contract `changedInTargetDetails`). */
const DetailsSchema = z.object({
  changed: z.array(ChangedComponentSchema),
  more: z.number().int().positive().optional(),
});

/** The longest id or version the refusal lists whole; a longer one ends `…` (contract `cut`). */
const LISTED_TEXT = 200;
const isCut = (s: string | null) =>
  s !== null && s.endsWith('…') && Array.from(s).length === LISTED_TEXT + 1;

/** What accepting the entry's refusal would record, or why it can't be accepted here. */
export function acceptPlanOf(entry: RegisterEntry): AcceptPlan {
  const refuse = (reason: string, changed: ChangedComponent[] = []): AcceptPlan => ({
    changed,
    reason,
    components: [],
  });
  if (entry.state !== 'changed') return refuse(NOT_CHANGED);
  const details = DetailsSchema.safeParse(entry.lastError?.details);
  if (!details.success) return refuse(UNLISTED);
  const { changed, more } = details.data;
  if (more !== undefined) return refuse(TOO_MANY, changed);
  const document = entry.lastReceipt?.document;
  if (!document?.components.length) return refuse(NO_VERSIONS, changed);
  if (changed.some((c) => isCut(c.id) || isCut(c.actual))) return refuse(CUT, changed);

  const components = document.components.map((c) => ({ ...c }));
  for (const c of changed) {
    const i = components.findIndex((k) => k.id === c.id);
    if (i >= 0 && c.actual === null) components.splice(i, 1);
    else if (i >= 0) components[i]!.version = c.actual!;
    else if (c.actual === null) return refuse(GONE, changed);
    else components.push({ kind: ADDED_KIND, id: c.id, version: c.actual, element: null });
  }
  if (!components.length) return refuse(GONE, changed);
  return { changed, reason: null, components };
}

/** The entry's last receipt with the accepted components: what the next update expects. */
export function acceptedReceipt(receipt: Receipt, components: ComponentVersion[]): Receipt {
  return { ...receipt, document: { ...receipt.document!, components } };
}
