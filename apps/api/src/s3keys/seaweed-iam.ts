import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  IAMClient,
  type IAMClientConfig,
  ListAccessKeysCommand,
  ListUsersCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import type { S3Options } from '../storage/s3.js';
import { lakePolicy, type Grant, type IssuedSecret, type S3KeyIssuer } from './issuer.js';

/** The one inline policy each consumer has. */
export const POLICY_NAME = 'lake-read';

/** IAM calls go to the S3 gateway itself (SeaweedFS embeds IAM on the S3 port, ADR 0008). */
export function iamClientConfig(opts: S3Options): IAMClientConfig {
  return {
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  };
}

const hasCode = (err: unknown, code: string) => {
  const e = err as { name?: string; Code?: string } | null;
  return e?.name === `${code}Exception` || e?.name === code || e?.Code === code;
};

/** Run an IAM call, treating the given error code as success (idempotent create/delete). */
async function tolerate(code: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (!hasCode(err, code)) throw err;
  }
}

/** S3 identities through SeaweedFS's embedded IAM API, signed with the admin identity. */
export class SeaweedIamIssuer implements S3KeyIssuer {
  private readonly client: Pick<IAMClient, 'send'>;

  /** `client` is for tests (a stub `send`); production builds one from `opts`. */
  constructor(opts: S3Options, client?: Pick<IAMClient, 'send'>) {
    this.client = client ?? new IAMClient(iamClientConfig(opts));
  }

  async createUser(userName: string, grants: Grant[]): Promise<void> {
    await tolerate('EntityAlreadyExists', () =>
      this.client.send(new CreateUserCommand({ UserName: userName })),
    );
    await this.setGrants(userName, grants);
  }

  async setGrants(userName: string, grants: Grant[]): Promise<void> {
    if (grants.length === 0) {
      await tolerate('NoSuchEntity', () =>
        this.client.send(
          new DeleteUserPolicyCommand({ UserName: userName, PolicyName: POLICY_NAME }),
        ),
      );
      return;
    }
    await this.client.send(
      new PutUserPolicyCommand({
        UserName: userName,
        PolicyName: POLICY_NAME,
        PolicyDocument: JSON.stringify(lakePolicy(grants)),
      }),
    );
  }

  async createKey(userName: string): Promise<IssuedSecret> {
    const res = await this.client.send(new CreateAccessKeyCommand({ UserName: userName }));
    const key = res.AccessKey;
    if (!key?.AccessKeyId || !key.SecretAccessKey) {
      throw new Error('SeaweedFS returned no access key');
    }
    return { accessKeyId: key.AccessKeyId, secretAccessKey: key.SecretAccessKey };
  }

  async deleteKey(userName: string, accessKeyId: string): Promise<void> {
    await tolerate('NoSuchEntity', () =>
      this.client.send(
        new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }),
      ),
    );
  }

  async deleteUser(userName: string): Promise<void> {
    let keys: string[];
    try {
      keys = await this.keysOf(userName);
    } catch (err) {
      if (hasCode(err, 'NoSuchEntity')) return;
      throw err;
    }
    for (const accessKeyId of keys) await this.deleteKey(userName, accessKeyId);
    await tolerate('NoSuchEntity', () =>
      this.client.send(
        new DeleteUserPolicyCommand({ UserName: userName, PolicyName: POLICY_NAME }),
      ),
    );
    await tolerate('NoSuchEntity', () =>
      this.client.send(new DeleteUserCommand({ UserName: userName })),
    );
  }

  async listUsers(prefix: string) {
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(new ListUsersCommand(marker ? { Marker: marker } : {}));
      for (const u of res.Users ?? []) if (u.UserName?.startsWith(prefix)) names.push(u.UserName);
      marker = res.IsTruncated ? res.Marker : undefined;
    } while (marker);
    const users = [];
    for (const userName of names)
      users.push({ userName, accessKeyIds: await this.keysOf(userName) });
    return users;
  }

  private async keysOf(userName: string): Promise<string[]> {
    const res = await this.client.send(new ListAccessKeysCommand({ UserName: userName }));
    return (res.AccessKeyMetadata ?? []).flatMap((k) => (k.AccessKeyId ? [k.AccessKeyId] : []));
  }
}
