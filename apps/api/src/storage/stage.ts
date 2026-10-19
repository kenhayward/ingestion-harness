import { DEFAULT_TARGET_ID, type JobOutput } from '@ih/shared';
import type { AppDeps } from '../app.js';

type Deps = Pick<AppDeps, 'store' | 'targets' | 'bridge'>;

/** An output could not be read: its storage or publishing target cannot be reached or used. */
export class OutputUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'OutputUnavailableError';
  }
}

/**
 * Read an output's object (null when missing): a draft from the outputs bucket (the API's
 * store), a published copy through the delivery bridge, from the publishing target recorded with
 * it (the bridge holds its credentials; the recorded bucket and key are used as they are, so
 * outputs delivered before the bridge read the same way). Throws `OutputUnavailableError`
 * (`publishing target <label> unavailable`, or `storage unavailable` for a draft) when the
 * target is missing, cannot be used or does not answer.
 */
export async function readOutput(
  deps: Deps,
  output: Pick<JobOutput, 'stage' | 'targetId' | 'bucket' | 'key'>,
): Promise<Buffer | null> {
  try {
    if (output.stage === 'draft') return await deps.store.get(output.bucket, output.key);
    return await deps.bridge.readObject(
      output.targetId ?? DEFAULT_TARGET_ID,
      output.bucket,
      output.key,
    );
  } catch (err) {
    if (output.stage === 'draft') throw new OutputUnavailableError('storage unavailable', err);
    const id = output.targetId ?? DEFAULT_TARGET_ID;
    const target = await deps.targets.get(id).catch(() => null);
    throw new OutputUnavailableError(`publishing target ${target?.label ?? id} unavailable`, err);
  }
}
