import type { PushOutcome } from '@ih/shared';
import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { NOT_LINKED_TO_PUSH, pushVersion } from './push.js';

/**
 * The automatic push after a publish committed: null when the type is not linked or pushes only
 * on request. Publishing never depends on GitHub, so nothing thrown escapes: it is a `failed`
 * outcome. Only the publisher's own account pushes; with no signed-in user there is none.
 */
export async function pushAfterPublish(
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
