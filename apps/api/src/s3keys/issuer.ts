import { randomBytes } from 'node:crypto';

/** What a consumer may do on the publish bucket (ADR 0008): read and list, nothing else. */
export const READ_ONLY_ACTIONS = ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'];

/** IAM users this feature owns. Nothing without the prefix is ever touched. */
export const USER_PREFIX = 'lake-';

export interface IssuedSecret {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The S3 server's identities (ADR 0008): `SeaweedIamIssuer` calls SeaweedFS's embedded IAM API;
 * `MemoryS3KeyIssuer` is for unit tests. Every call may throw when the server is unreachable.
 */
export interface S3KeyIssuer {
  /** A user that can only read and list `bucket` (idempotent). */
  createUser(userName: string, bucket: string): Promise<void>;
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
  bucket: string;
  actions: string[];
  keys: Map<string, string>;
}

/** In-memory S3 identities for unit tests. */
export class MemoryS3KeyIssuer implements S3KeyIssuer {
  private readonly users = new Map<string, MemoryUser>();

  async createUser(userName: string, bucket: string): Promise<void> {
    if (!this.users.has(userName)) {
      this.users.set(userName, { bucket, actions: [...READ_ONLY_ACTIONS], keys: new Map() });
    }
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

  /** Test inspection: a user's bucket and allowed actions. */
  user(userName: string): { bucket: string; actions: string[] } | undefined {
    const u = this.users.get(userName);
    return u && { bucket: u.bucket, actions: u.actions };
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
