import { CONNECTION_ID } from '@ih/bridge-contract';
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

/**
 * A personal connection for an (owner, sink, instance) that already has one under another id:
 * a user holds one connection per instance, so the runner always knows which to use.
 */
export class ConnectionConflict extends Error {
  constructor(readonly existingId: string | null) {
    super('a personal connection for this sink and instance exists already');
    this.name = 'ConnectionConflict';
  }
}

export interface ConnectionRepo {
  list(filter: { kind?: 'shared' | 'personal'; owner?: string }): Promise<Connection[]>;
  get(id: string): Promise<Connection | null>;
  /** The owner's personal connection to a sink instance (null instance: a sink with none). */
  findPersonal(
    owner: string,
    sinkId: string,
    instanceId: string | null,
  ): Promise<Connection | null>;
  /**
   * Creates or updates; throws when the id or the kind/owner pair is not valid, and
   * ConnectionConflict for a second personal connection to the same owner, sink and instance.
   */
  put(c: NewConnection): Promise<void>;
  /** Deletes the owner's personal connections (none a target names); how many went. */
  removeOwner(owner: string): Promise<number>;
  /** Deletes the personal connections of every owner not listed (none a target names). */
  removeOwnersNotIn(owners: readonly string[]): Promise<number>;
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
  // The triple store writer's password (the seeded rdf-default connection).
  'RDF_PASSWORD',
]);

const ID = CONNECTION_ID;

/** Writes the built-in connection when it is missing; never touches it afterwards. */
export async function seedInternalConnection(connections: ConnectionRepo): Promise<void> {
  if (await connections.get(INTERNAL_CONNECTION_ID)) return;
  await connections.put({
    id: INTERNAL_CONNECTION_ID,
    kind: 'shared',
    owner: null,
    sinkId: 's3',
    instanceId: null,
    name: 'This deployment',
    fields: {},
    secretEnv: null,
    status: 'untested',
    statusReason: null,
    secretEnc: null,
  });
}

/** The rules the database's CHECKs enforce, for the memory repo and for early, clear errors. */
export function connectionProblem(c: NewConnection): string | null {
  if (!ID.test(c.id)) return 'an id is 1-64 of a-z, 0-9, _ and -, starting with a letter or digit';
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

const samePlace = (c: Connection, owner: string, sinkId: string, instanceId: string | null) =>
  c.kind === 'personal' && c.owner === owner && c.sinkId === sinkId && c.instanceId === instanceId;

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

  async findPersonal(
    owner: string,
    sinkId: string,
    instanceId: string | null,
  ): Promise<Connection | null> {
    const c = [...this.rows.values()].find((r) => samePlace(r, owner, sinkId, instanceId));
    return c ? view(c) : null;
  }

  async put(c: NewConnection): Promise<void> {
    const problem = connectionProblem(c);
    if (problem) throw new Error(problem);
    if (c.kind === 'personal') {
      const other = [...this.rows.values()].find(
        (r) => r.id !== c.id && samePlace(r, c.owner!, c.sinkId, c.instanceId),
      );
      if (other) throw new ConnectionConflict(other.id);
    }
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

  async removeOwner(owner: string): Promise<number> {
    return this.removeWhere((c) => c.owner === owner);
  }

  async removeOwnersNotIn(owners: readonly string[]): Promise<number> {
    const live = new Set(owners);
    return this.removeWhere((c) => c.owner !== null && !live.has(c.owner));
  }

  private async removeWhere(match: (c: Stored) => boolean): Promise<number> {
    const named = new Set((await this.targets.list()).map((t) => t.connectionId));
    let n = 0;
    for (const c of [...this.rows.values()]) {
      if (c.kind === 'personal' && match(c) && !named.has(c.id)) {
        this.rows.delete(c.id);
        n += 1;
      }
    }
    return n;
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
