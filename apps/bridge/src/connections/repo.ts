import type { TargetRepo } from '../targets/repo.js';

/**
 * Credentials for one sink instance. A shared connection is owned by admins; a personal one by
 * one CT Studio user (`owner`). Its secret is never part of this view: `secretSet` says one is
 * stored, `secretEnv` names the environment variable it is read from instead.
 */
export interface Connection {
  id: string;
  kind: 'shared' | 'personal';
  owner: string | null;
  sinkId: string;
  instanceId: string | null;
  name: string;
  /** The non-secret credential fields. */
  fields: Record<string, string>;
  secretSet: boolean;
  secretEnv: string | null;
  status: 'ok' | 'needs_attention' | 'untested';
  statusReason: string | null;
  lastUsedAt: Date | null;
}

export type ConnectionStatus = Connection['status'];

/** A connection as written; `secretEnc` undefined keeps the stored secret, null clears it. */
export type NewConnection = Omit<Connection, 'secretSet' | 'lastUsedAt'> & {
  secretEnc?: string | null;
};

export interface ConnectionRepo {
  list(filter: { kind?: 'shared' | 'personal'; owner?: string }): Promise<Connection[]>;
  get(id: string): Promise<Connection | null>;
  /** Creates or updates; throws when the id or the kind/owner pair is not valid. */
  put(c: NewConnection): Promise<void>;
  /** `in_use`: a target names it, and it is kept. */
  remove(id: string): Promise<'deleted' | 'missing' | 'in_use'>;
  secretOf(id: string): Promise<{ secretEnc: string | null; secretEnv: string | null } | null>;
  mark(id: string, status: ConnectionStatus, reason: string | null, usedAt?: Date): Promise<void>;
}

/** The built-in connection: the deployment's own SeaweedFS, with the bridge's `S3_*` keys. */
export const INTERNAL_CONNECTION_ID = 'internal';

/**
 * The only environment variables a connection may read its keys from (as CT Studio's API
 * allowed for targets: apps/api/src/publish-targets/stores.ts), so a stored name can never make
 * the bridge read any other secret of its environment.
 */
export const CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set([
  'TARGET_S3_ACCESS_KEY',
  'TARGET_S3_SECRET_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
]);

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The rules the database's CHECKs enforce, for the memory repo and for early, clear errors. */
export function connectionProblem(c: NewConnection): string | null {
  if (!ID.test(c.id)) return 'an id is 1-40 of a-z, 0-9, _ and -, starting with a letter or digit';
  if ((c.kind === 'personal') !== (c.owner !== null)) {
    return 'a personal connection has an owner, a shared one has none';
  }
  if (c.secretEnv !== null && !CREDENTIAL_ENV_NAMES.has(c.secretEnv)) {
    return `${c.secretEnv} is not a credential variable`;
  }
  return null;
}

interface Stored extends Connection {
  secretEnc: string | null;
}

const view = ({ secretEnc: _s, ...c }: Stored): Connection => structuredClone(c);

export class MemoryConnectionRepo implements ConnectionRepo {
  private readonly rows = new Map<string, Stored>();

  constructor(private readonly targets: TargetRepo) {}

  async list(filter: { kind?: 'shared' | 'personal'; owner?: string }): Promise<Connection[]> {
    return [...this.rows.values()]
      .filter(
        (c) =>
          (filter.kind === undefined || c.kind === filter.kind) &&
          (filter.owner === undefined || c.owner === filter.owner),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(view);
  }

  async get(id: string): Promise<Connection | null> {
    const c = this.rows.get(id);
    return c ? view(c) : null;
  }

  async put(c: NewConnection): Promise<void> {
    const problem = connectionProblem(c);
    if (problem) throw new Error(problem);
    const before = this.rows.get(c.id);
    const { secretEnc, ...rest } = c;
    const kept = secretEnc === undefined ? (before?.secretEnc ?? null) : secretEnc;
    this.rows.set(c.id, {
      ...structuredClone(rest),
      secretEnc: kept,
      secretSet: kept !== null,
      lastUsedAt: before?.lastUsedAt ?? null,
    });
  }

  async remove(id: string): Promise<'deleted' | 'missing' | 'in_use'> {
    if (!this.rows.has(id)) return 'missing';
    if ((await this.targets.list()).some((t) => t.connectionId === id)) return 'in_use';
    this.rows.delete(id);
    return 'deleted';
  }

  async secretOf(
    id: string,
  ): Promise<{ secretEnc: string | null; secretEnv: string | null } | null> {
    const c = this.rows.get(id);
    return c ? { secretEnc: c.secretEnc, secretEnv: c.secretEnv } : null;
  }

  async mark(
    id: string,
    status: ConnectionStatus,
    reason: string | null,
    usedAt?: Date,
  ): Promise<void> {
    const c = this.rows.get(id);
    if (!c) return;
    c.status = status;
    c.statusReason = reason;
    if (usedAt) c.lastUsedAt = usedAt;
  }
}
