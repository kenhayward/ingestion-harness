import { describe, expect, it } from 'vitest';
import { Credentials } from '../src/connections/credential.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { encryptSecret } from '../src/secrets.js';
import { SinkError } from '../src/sinks/port.js';
import { INTERNAL_CREDENTIAL, S3Sink } from '../src/sinks/s3.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { connection } from './connections-contract.js';
import { SECRETS } from './helpers.js';

const s3 = () =>
  new S3Sink({
    internal: {
      endpoint: 'http://seaweedfs:8333',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    },
  }).describe();

async function setup(env: Record<string, string> = {}) {
  const connections = new MemoryConnectionRepo(new MemoryTargetRepo());
  return { connections, credentials: new Credentials({ connections, secrets: SECRETS, env }) };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof SinkError) return err.error.code;
    throw err;
  }
  return 'resolved';
};

describe('Credentials', () => {
  it('gives the fields with the decrypted secret under the sink’s secret field', async () => {
    const { connections, credentials } = await setup();
    await connections.put({
      ...connection('c1', {
        fields: {
          endpoint: 'https://s3.example.com',
          accessKeyId: 'AKIA1',
          forcePathStyle: 'true',
        },
      }),
      secretEnc: encryptSecret('the-secret', SECRETS),
    });
    expect(await credentials.resolve('c1', await s3())).toEqual({
      endpoint: 'https://s3.example.com',
      accessKeyId: 'AKIA1',
      forcePathStyle: 'true',
      secretAccessKey: 'the-secret',
    });
  });

  it('reads env-keyed connections from the allowlisted variables', async () => {
    const { connections, credentials } = await setup({
      TARGET_S3_ACCESS_KEY: 'AKIAENV',
      TARGET_S3_SECRET_KEY: 'env-secret',
    });
    await connections.put(
      connection('env', {
        fields: { endpoint: 'https://s3.example.com', accessKeyIdEnv: 'TARGET_S3_ACCESS_KEY' },
        secretEnv: 'TARGET_S3_SECRET_KEY',
      }),
    );
    expect(await credentials.resolve('env', await s3())).toEqual({
      endpoint: 'https://s3.example.com',
      accessKeyId: 'AKIAENV',
      secretAccessKey: 'env-secret',
    });
  });

  it('never reads a variable outside the allowlist', async () => {
    const { connections, credentials } = await setup({ DATABASE_URL: 'postgres://secret' });
    await connections.put(
      connection('sneaky', { fields: { accessKeyIdEnv: 'DATABASE_URL', accessKeyId: 'x' } }),
    );
    expect(await codeOf(credentials.resolve('sneaky', await s3()))).toBe('credential_missing');
  });

  it('drops fields the sink does not declare', async () => {
    const { connections, credentials } = await setup();
    await connections.put({
      ...connection('c1', { fields: { accessKeyId: 'AKIA1', internal: 'true' } }),
      secretEnc: encryptSecret('s', SECRETS),
    });
    expect(await credentials.resolve('c1', await s3())).toEqual({
      accessKeyId: 'AKIA1',
      secretAccessKey: 's',
    });
  });

  it('the internal connection is the bridge’s own S3', async () => {
    const { connections, credentials } = await setup();
    await connections.put(connection('internal', { fields: {} }));
    expect(await credentials.resolve('internal', await s3())).toEqual(INTERNAL_CREDENTIAL);
  });

  it('no connection gives no credential; a missing one or an undecryptable secret is refused', async () => {
    const { connections, credentials } = await setup();
    expect(await credentials.resolve(null, await s3())).toBeNull();
    expect(await codeOf(credentials.resolve('gone', await s3()))).toBe('connection_missing');
    await connections.put({
      ...connection('bad', { fields: { accessKeyId: 'AKIA1' } }),
      secretEnc: encryptSecret('s', { current: Buffer.alloc(32, 9), previous: null }),
    });
    expect(await codeOf(credentials.resolve('bad', await s3()))).toBe('credential_missing');
  });
});
