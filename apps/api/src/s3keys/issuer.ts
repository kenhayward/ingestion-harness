import { randomBytes } from 'node:crypto';

/** What a consumer may do on the publish bucket (ADR 0008): read and list, nothing else. */
export const READ_ONLY_ACTIONS = ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'];

/** IAM users this feature owns. Nothing without the prefix is ever touched. */
export const USER_PREFIX = 'lake-';

/** One internal publishing target a consumer may read: its bucket and (normalised) key prefix. */
export interface Grant {
  bucket: string;
  /** Empty, or ends in `/` (`normalisePrefix`). */
  prefix: string;
}

/** A wildcard or policy variable in a bucket or prefix would widen what a key can read. */
export function assertLiteral(g: Grant): void {
  if (/[*?$]/.test(g.bucket) || /[*?$]/.test(g.prefix)) {
    throw new Error(`refusing a grant with a wildcard: ${g.bucket}/${g.prefix}`);
  }
}

/** The inline policy for a consumer: read and list each granted bucket, limited to its prefix. */
export function lakePolicy(grants: Grant[]) {
  for (const g of grants) assertLiteral(g);
  return {
    Version: '2012-10-17',
    Statement: grants.flatMap((g) => {
      const bucket = `arn:aws:s3:::${g.bucket}`;
      return [
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: [bucket] },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [bucket],
          ...(g.prefix ? { Condition: { StringLike: { 's3:prefix': [`${g.prefix}*`] } } } : {}),
        },
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: [`${bucket}/${g.prefix}*`] },
      ];
    }),
  };
}

export interface IssuedSecret {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The S3 server's identities (ADR 0008): `SeaweedIamIssuer` calls SeaweedFS's embedded IAM API;
 * `MemoryS3KeyIssuer` is for unit tests. Every call may throw when the server is unreachable.
 */
export interface S3KeyIssuer {
  /** A user that can only read and list the granted buckets and prefixes (idempotent). */
  createUser(userName: string, grants: Grant[]): Promise<void>;
  /** Replace what the user may read (idempotent). */
  setGrants(userName: string, grants: Grant[]): Promise<void>;
  /** A new access key; the secret exists only in the server and in this return value. */
  createKey(userName: string): Promise<IssuedSecret>;
  /** Idempotent: a key that's already gone is fine. */
  deleteKey(userName: string, accessKeyId: string): Promise<void>;
  /** Delete the user with its keys and policy (idempotent). */
  deleteUser(userName: string): Promise<void>;
  /** Users whose name starts with `prefix`, with their access key ids. */
  listUsers(prefix: string): Promise<{ userName: string; accessKeyIds: string[] }[]>;
}

interface MemoryUser {
  grants: Grant[];
  actions: string[];
  keys: Map<string, string>;
}

/** In-memory S3 identities for unit tests. */
export class MemoryS3KeyIssuer implements S3KeyIssuer {
  private readonly users = new Map<string, MemoryUser>();

  async createUser(userName: string, grants: Grant[]): Promise<void> {
    grants.forEach(assertLiteral);
    if (!this.users.has(userName)) {
      this.users.set(userName, {
        grants: grants.map((g) => ({ ...g })),
        actions: [...READ_ONLY_ACTIONS],
        keys: new Map(),
      });
    }
  }

  async setGrants(userName: string, grants: Grant[]): Promise<void> {
    grants.forEach(assertLiteral);
    const user = this.users.get(userName);
    if (!user) throw new Error(`no such user: ${userName}`);
    user.grants = grants.map((g) => ({ ...g }));
  }

  async createKey(userName: string): Promise<IssuedSecret> {
    const user = this.users.get(userName);
    if (!user) throw new Error(`no such user: ${userName}`);
    const accessKeyId = `AK${randomBytes(9).toString('hex').toUpperCase()}`;
    const secretAccessKey = randomBytes(30).toString('base64');
    user.keys.set(accessKeyId, secretAccessKey);
    return { accessKeyId, secretAccessKey };
  }

  async deleteKey(userName: string, accessKeyId: string): Promise<void> {
    this.users.get(userName)?.keys.delete(accessKeyId);
  }

  async deleteUser(userName: string): Promise<void> {
    this.users.delete(userName);
  }

  async listUsers(prefix: string) {
    return [...this.users]
      .filter(([name]) => name.startsWith(prefix))
      .map(([userName, u]) => ({ userName, accessKeyIds: [...u.keys.keys()] }));
  }

  /** Test inspection: a user's grants and allowed actions. */
  user(userName: string): { grants: Grant[]; actions: string[] } | undefined {
    const u = this.users.get(userName);
    return u && { grants: u.grants, actions: u.actions };
  }

  userNames(): string[] {
    return [...this.users.keys()];
  }

  /** Test inspection: the secret the server holds for a key (undefined once deleted). */
  secretOf(accessKeyId: string): string | undefined {
    for (const u of this.users.values()) {
      const secret = u.keys.get(accessKeyId);
      if (secret !== undefined) return secret;
    }
    return undefined;
  }
}
