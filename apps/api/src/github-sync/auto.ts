import type { PushOutcome } from '@ih/shared';
import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { NOT_LINKED_TO_PUSH, pushVersion } from './push.js';

/** How long a publish waits for its automatic push before answering without it. */
export const AUTO_PUSH_DEADLINE_MS = 15_000;
export const SLOW_PUSH = 'GitHub is slow: check Versions for the result.';

/** The automatic push itself; never throws. */
async function pushNow(
  deps: AppDeps,
  req: FastifyRequest,
  typeId: string,
  version: number,
): Promise<PushOutcome | null> {
  try {
    const link = await deps.githubSync.link(typeId);
    if (!link?.pushOnPublish) return null;
    const auth = req.auth;
    if (!auth?.userId) return { kind: 'skipped', reason: NOT_LINKED_TO_PUSH };
    return await pushVersion(deps, {
      typeId,
      version,
      user: { id: auth.userId, name: auth.label },
      origin: `${req.protocol}://${req.host}`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, typeId, version }, 'automatic GitHub push failed');
    return { kind: 'failed', reason };
  }
}

/**
 * The automatic push after a publish committed: null when the type is not linked or pushes only
 * on request. Publishing never depends on GitHub, so nothing thrown escapes: it is a `failed`
 * outcome. Only the publisher's own account pushes; with no signed-in user there is none. A push
 * still going after `AUTO_PUSH_DEADLINE_MS` (`githubAutoPushDeadlineMs`) is answered as
 * `GitHub is slow` and finishes, and is recorded, after the publish has answered.
 */
export async function pushAfterPublish(
  deps: AppDeps,
  req: FastifyRequest,
  typeId: string,
  version: number,
): Promise<PushOutcome | null> {
  const push = pushNow(deps, req, typeId, version);
  const slow: PushOutcome = { kind: 'failed', reason: SLOW_PUSH };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<PushOutcome>((resolve) => {
    timer = setTimeout(() => resolve(slow), deps.githubAutoPushDeadlineMs ?? AUTO_PUSH_DEADLINE_MS);
  });
  const outcome = await Promise.race([push, deadline]);
  clearTimeout(timer);
  if (outcome === slow) {
    void push.then((late) =>
      req.log.info(
        { typeId, version, outcome: late?.kind ?? null },
        'automatic GitHub push finished after the publish answered',
      ),
    );
  }
  return outcome;
}
