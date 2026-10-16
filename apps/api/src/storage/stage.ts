import { DEFAULT_TARGET_ID, type JobOutput } from '@ih/shared';
import type { AppDeps } from '../app.js';
import type { ObjectStore } from './object-store.js';

type Deps = Pick<AppDeps, 'store' | 'targets' | 'targetStores'>;

/** An output could not be read: its storage or publishing target cannot be reached or used. */
export class OutputUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'OutputUnavailableError';
  }
}

/**
 * Where an output lives: drafts in the outputs bucket (the API's store), published copies on the
 * publishing target recorded with them (its current client and credentials; the recorded bucket
 * and key are used as they are).
 */
export async function outputStore(
  deps: Deps,
  output: Pick<JobOutput, 'stage' | 'targetId'>,
): Promise<ObjectStore> {
  if (output.stage === 'draft') return deps.store;
  return (await deps.targetStores.storeFor(output.targetId ?? DEFAULT_TARGET_ID)).store;
}

/**
 * Read an output's object (null when missing). Throws `OutputUnavailableError`
 * (`publishing target <label> unavailable`, or `storage unavailable` for a draft) when the
 * target is missing, cannot be used or does not answer.
 */
export async function readOutput(
  deps: Deps,
  output: Pick<JobOutput, 'stage' | 'targetId' | 'bucket' | 'key'>,
): Promise<Buffer | null> {
  try {
    return await (await outputStore(deps, output)).get(output.bucket, output.key);
  } catch (err) {
    if (output.stage === 'draft') throw new OutputUnavailableError('storage unavailable', err);
    const id = output.targetId ?? DEFAULT_TARGET_ID;
    const target = await deps.targets.get(id).catch(() => null);
    throw new OutputUnavailableError(`publishing target ${target?.label ?? id} unavailable`, err);
  }
}
