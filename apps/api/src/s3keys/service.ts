import { randomUUID } from 'node:crypto';
import type { TargetChoice } from '@ih/shared';
import type { PublishTargetRepo } from '../publish-targets/repo.js';
import { USER_PREFIX, type Grant, type S3KeyIssuer } from './issuer.js';
import { z } from 'zod';
import { S3ConsumerSchema, S3KeySchema, type S3Consumer, type S3KeyRepo } from './repo.js';

/** Returned once, when a key is created: the only time its secret leaves SeaweedFS. */
export const IssuedKeySchema = z.object({
  consumer: S3ConsumerSchema,
  key: S3KeySchema,
  secretAccessKey: z.string().describe('Shown only in this response.'),
});
export type IssuedKey = z.infer<typeof IssuedKeySchema>;

/** Active keys per consumer: two allow a rotation with overlap. */
export const MAX_ACTIVE_KEYS = 2;

/** A grant list that cannot be used: the route answers with `status` and `problem`. */
export interface GrantProblem {
  problem: string;
  status: 400 | 409;
}

/**
 * Read-only S3 keys for the internal publishing targets (ADR 0008). The database says which keys should
 * exist; SeaweedFS is changed to match - immediately on revoke, and by `reconcile()` for expiry
 * and anything a failed call left behind.
 *
 * Every operation runs one at a time (single API instance, like the admin token in ADR 0006),
 * so a reconcile can never see a key that has been created but not yet recorded.
 */
export class S3KeyService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: {
      repo: S3KeyRepo;
      issuer: S3KeyIssuer;
      /** Which targets exist: keys can be granted only on internal ones. */
      targets: PublishTargetRepo;
      /** The URL the data lake uses (the proxy in front of SeaweedFS), if configured. */
      endpoint: string | null;
    },
  ) {}

  /** What the data lake is configured with, besides the key pair. */
  get settings(): { endpoint: string | null } {
    return { endpoint: this.opts.endpoint };
  }

  async list(): Promise<{
    endpoint: string | null;
    internalTargets: TargetChoice[];
    consumers: S3Consumer[];
  }> {
    return {
      ...this.settings,
      internalTargets: await this.internalTargets(),
      consumers: await this.opts.repo.listConsumers(),
    };
  }

  /** The targets a key can be granted on: the internal ones, in the picker's order. */
  async internalTargets(): Promise<TargetChoice[]> {
    return (await this.opts.targets.choices()).filter((t) => t.kind === 'internal');
  }

  issue(
    label: string,
    expiresInDays: number | null,
    targetIds: string[],
  ): Promise<IssuedKey | GrantProblem> {
    return this.serial(async () => {
      const { repo, issuer } = this.opts;
      const grants = await this.resolve(targetIds);
      if ('problem' in grants) return grants;
      const id = randomUUID();
      const userName = `${USER_PREFIX}${id}`;
      let secret;
      try {
        await issuer.createUser(userName, grants.grants);
        secret = await issuer.createKey(userName);
      } catch (err) {
        await issuer.deleteUser(userName).catch(() => undefined); // else reconcile removes it
        throw err;
      }
      await repo.createConsumer(id, label, userName);
      await repo.setGrants(id, targetIds);
      const key = await repo.addKey(id, secret.accessKeyId, expiresInDays, null);
      return {
        consumer: (await repo.getConsumer(id))!,
        key,
        secretAccessKey: secret.secretAccessKey,
      };
    });
  }

  /** Replace the targets a consumer may read; the database first, then its policy. */
  setTargets(consumerId: string, targetIds: string[]): Promise<'ok' | 'not_found' | GrantProblem> {
    return this.serial(async () => {
      const { repo, issuer } = this.opts;
      const consumer = await repo.getConsumer(consumerId);
      if (!consumer) return 'not_found';
      const grants = await this.resolve(targetIds);
      if ('problem' in grants) return grants;
      await repo.setGrants(consumerId, targetIds);
      await issuer.setGrants(consumer.userName, grants.grants);
      return 'ok';
    });
  }

  /** A new key for the consumer; its other active keys expire within `graceDays`. */
  rotate(
    consumerId: string,
    expiresInDays: number | null,
    graceDays: number,
  ): Promise<IssuedKey | 'not_found' | 'limit'> {
    return this.serial(async () => {
      const { repo, issuer } = this.opts;
      const consumer = await repo.getConsumer(consumerId);
      if (!consumer) return 'not_found';
      const active = consumer.keys.filter((k) => k.status === 'active');
      if (active.length >= MAX_ACTIVE_KEYS) return 'limit';
      const secret = await issuer.createKey(consumer.userName);
      const key = await repo.addKey(
        consumerId,
        secret.accessKeyId,
        expiresInDays,
        active[0]?.id ?? null,
      );
      await repo.capExpiry(consumerId, graceDays, key.id);
      return {
        consumer: (await repo.getConsumer(consumerId))!,
        key,
        secretAccessKey: secret.secretAccessKey,
      };
    });
  }

  /** Revoked in the database first, so a SeaweedFS failure is retried by `reconcile()`. */
  revoke(keyId: string): Promise<'ok' | 'not_found'> {
    return this.serial(async () => {
      const found = await this.opts.repo.findKey(keyId);
      if (!found) return 'not_found';
      await this.opts.repo.revokeKey(keyId);
      await this.opts.issuer.deleteKey(found.userName, found.key.accessKeyId);
      return 'ok';
    });
  }

  remove(consumerId: string): Promise<'ok' | 'not_found'> {
    return this.serial(async () => {
      const { repo, issuer } = this.opts;
      const consumer = await repo.getConsumer(consumerId);
      if (!consumer) return 'not_found';
      for (const key of consumer.keys) if (key.status === 'active') await repo.revokeKey(key.id);
      await issuer.deleteUser(consumer.userName);
      await repo.deleteConsumer(consumerId);
      return 'ok';
    });
  }

  /** Delete expired and revoked keys, and any `lake-*` user or key with no record. */
  reconcile(): Promise<{ deletedKeys: number; deletedUsers: number }> {
    return this.serial(async () => {
      const { repo, issuer } = this.opts;
      // No internal target: no key can be granted, so SeaweedFS's IAM is not ours to keep in
      // step (and may be read-only there). Grants pin their targets, so none is left behind.
      if ((await this.internalTargets()).length === 0) return { deletedKeys: 0, deletedUsers: 0 };
      const wanted = new Map<string, Set<string>>();
      const consumers = await repo.listConsumers();
      for (const c of consumers) {
        const active = c.keys.filter((k) => k.status === 'active').map((k) => k.accessKeyId);
        wanted.set(c.userName, new Set(active));
      }
      // Rewrite each policy from its grants, so one changed behind our back is put right.
      for (const c of consumers) {
        const resolved = await this.resolve(c.targets);
        if ('grants' in resolved) {
          // A consumer SeaweedFS lost must not stop the cleanup below.
          await issuer.setGrants(c.userName, resolved.grants).catch(() => undefined);
        }
      }
      let deletedKeys = 0;
      let deletedUsers = 0;
      for (const user of await issuer.listUsers(USER_PREFIX)) {
        const keep = wanted.get(user.userName);
        if (!keep) {
          await issuer.deleteUser(user.userName);
          deletedUsers++;
          continue;
        }
        for (const accessKeyId of user.accessKeyIds) {
          if (keep.has(accessKeyId)) continue;
          await issuer.deleteKey(user.userName, accessKeyId);
          deletedKeys++;
        }
      }
      return { deletedKeys, deletedUsers };
    });
  }

  /** Every id must be an existing internal target; at least one. */
  private async resolve(targetIds: string[]): Promise<{ grants: Grant[] } | GrantProblem> {
    if (targetIds.length === 0) {
      return { problem: 'grant at least one publishing target', status: 400 };
    }
    const grants: Grant[] = [];
    for (const id of [...new Set(targetIds)].sort()) {
      const target = await this.opts.targets.get(id);
      if (!target || target.kind !== 'internal') {
        return { problem: `${id} is not an internal publishing target`, status: 400 };
      }
      grants.push({ bucket: target.bucket, prefix: target.prefix });
    }
    return { grants };
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
