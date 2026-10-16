import { CreateUserCommand, ListAccessKeysCommand, ListUsersCommand } from '@aws-sdk/client-iam';
import { describe, expect, it, vi } from 'vitest';
import { MemoryS3KeyIssuer } from '../src/s3keys/issuer.js';
import { iamClientConfig, SeaweedIamIssuer } from '../src/s3keys/seaweed-iam.js';

type Cmd = { input: Record<string, unknown> };
const opts = {
  endpoint: 'http://seaweedfs:8333',
  region: 'us-east-1',
  accessKeyId: 'a',
  secretAccessKey: 's',
};

/** An IAM error as the SDK raises it for SeaweedFS's `<Code>` values. */
const iamError = (code: string) => Object.assign(new Error(code), { name: code, Code: code });

function stub(reply: (cmd: Cmd) => unknown = () => ({})) {
  const send = vi.fn(async (cmd: Cmd) => reply(cmd));
  const issuer = new SeaweedIamIssuer(opts, { send } as never);
  const calls = () => send.mock.calls.map(([c]) => [c.constructor.name, c.input] as const);
  return { issuer, send, calls };
}

describe('iamClientConfig', () => {
  it('talks to the S3 gateway (embedded IAM) and fails fast when it is unreachable', () => {
    expect(iamClientConfig(opts)).toMatchObject({
      endpoint: 'http://seaweedfs:8333',
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    });
  });
});

describe('SeaweedIamIssuer', () => {
  it('creates a user with a read-only inline policy per granted bucket and prefix', async () => {
    const { issuer, calls } = stub();
    await issuer.createUser('lake-1', [
      { bucket: 'ingest-published', prefix: '' },
      { bucket: 'finance', prefix: 'out/' },
    ]);
    const [create, policy] = calls();
    expect(create).toEqual(['CreateUserCommand', { UserName: 'lake-1' }]);
    expect(policy![0]).toBe('PutUserPolicyCommand');
    const input = policy![1] as { UserName: string; PolicyName: string; PolicyDocument: string };
    expect(input.UserName).toBe('lake-1');
    expect(input.PolicyName).toBe('lake-read');
    expect(JSON.parse(input.PolicyDocument)).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: ['arn:aws:s3:::ingest-published'] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::ingest-published'] },
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::ingest-published/*'] },
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: ['arn:aws:s3:::finance'] },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: ['arn:aws:s3:::finance'],
          Condition: { StringLike: { 's3:prefix': ['out/*'] } },
        },
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::finance/out/*'] },
      ],
    });
  });

  it('replaces the policy when grants change, and drops it when none are left', async () => {
    const { issuer, calls } = stub();
    await issuer.setGrants('lake-1', [{ bucket: 'b', prefix: '' }]);
    await issuer.setGrants('lake-1', []);
    expect(calls().map(([name]) => name)).toEqual([
      'PutUserPolicyCommand',
      'DeleteUserPolicyCommand',
    ]);
  });

  it.each([
    { bucket: 'b', prefix: 'a*' },
    { bucket: 'b', prefix: 'a?b/' },
    { bucket: 'b', prefix: '${aws:username}/' },
    { bucket: 'b*', prefix: '' },
  ])('refuses a grant that is not literal: %j', async (grant) => {
    const { issuer, send } = stub();
    await expect(issuer.setGrants('lake-1', [grant])).rejects.toThrow(/wildcard/);
    expect(send).not.toHaveBeenCalled();
    await expect(new MemoryS3KeyIssuer().createUser('lake-1', [grant])).rejects.toThrow(/wildcard/);
  });

  it('treats an existing user as created (and still sets the policy)', async () => {
    const { issuer, calls } = stub((cmd) => {
      if (cmd instanceof CreateUserCommand) throw iamError('EntityAlreadyExistsException');
      return {};
    });
    await issuer.createUser('lake-1', [{ bucket: 'ingest-published', prefix: '' }]);
    expect(calls().map(([name]) => name)).toEqual(['CreateUserCommand', 'PutUserPolicyCommand']);
  });

  it('returns the new key pair', async () => {
    const { issuer, calls } = stub(() => ({
      AccessKey: {
        UserName: 'lake-1',
        AccessKeyId: 'AKID',
        SecretAccessKey: 'SECRET',
        Status: 'Active',
      },
    }));
    expect(await issuer.createKey('lake-1')).toEqual({
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    });
    expect(calls()).toEqual([['CreateAccessKeyCommand', { UserName: 'lake-1' }]]);
  });

  it('rejects a create-key reply without a secret', async () => {
    const { issuer } = stub(() => ({ AccessKey: { AccessKeyId: 'AKID' } }));
    await expect(issuer.createKey('lake-1')).rejects.toThrow(/no access key/i);
  });

  it('deletes a key, and a key that is already gone is fine', async () => {
    const { issuer, calls } = stub();
    await issuer.deleteKey('lake-1', 'AKID');
    expect(calls()).toEqual([
      ['DeleteAccessKeyCommand', { UserName: 'lake-1', AccessKeyId: 'AKID' }],
    ]);
    const gone = stub(() => {
      throw iamError('NoSuchEntityException');
    });
    await expect(gone.issuer.deleteKey('lake-1', 'AKID')).resolves.toBeUndefined();
  });

  it('passes other errors through', async () => {
    const { issuer } = stub(() => {
      throw iamError('AccessDenied');
    });
    await expect(issuer.deleteKey('lake-1', 'AKID')).rejects.toThrow('AccessDenied');
  });

  it('deletes a user with its keys and policy', async () => {
    const { issuer, calls } = stub((cmd) =>
      cmd instanceof ListAccessKeysCommand
        ? { AccessKeyMetadata: [{ AccessKeyId: 'K1' }, { AccessKeyId: 'K2' }] }
        : {},
    );
    await issuer.deleteUser('lake-1');
    expect(calls()).toEqual([
      ['ListAccessKeysCommand', { UserName: 'lake-1' }],
      ['DeleteAccessKeyCommand', { UserName: 'lake-1', AccessKeyId: 'K1' }],
      ['DeleteAccessKeyCommand', { UserName: 'lake-1', AccessKeyId: 'K2' }],
      ['DeleteUserPolicyCommand', { UserName: 'lake-1', PolicyName: 'lake-read' }],
      ['DeleteUserCommand', { UserName: 'lake-1' }],
    ]);
  });

  it('deletes a user that is already gone without complaint', async () => {
    const { issuer } = stub(() => {
      throw iamError('NoSuchEntityException');
    });
    await expect(issuer.deleteUser('lake-1')).resolves.toBeUndefined();
  });

  it('lists prefixed users across pages with their access key ids', async () => {
    const { issuer, calls } = stub((cmd) => {
      if (cmd instanceof ListUsersCommand) {
        return cmd.input.Marker
          ? { Users: [{ UserName: 'lake-2' }], IsTruncated: false }
          : {
              Users: [{ UserName: 'lake-1' }, { UserName: 'ingest-admin' }],
              IsTruncated: true,
              Marker: 'm1',
            };
      }
      if (cmd instanceof ListAccessKeysCommand) {
        return cmd.input.UserName === 'lake-1'
          ? { AccessKeyMetadata: [{ AccessKeyId: 'K1' }] }
          : { AccessKeyMetadata: [] };
      }
      return {};
    });
    expect(await issuer.listUsers('lake-')).toEqual([
      { userName: 'lake-1', accessKeyIds: ['K1'] },
      { userName: 'lake-2', accessKeyIds: [] },
    ]);
    expect(calls().filter(([n]) => n === 'ListAccessKeysCommand')).toHaveLength(2);
  });
});
