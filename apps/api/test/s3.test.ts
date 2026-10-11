import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3ObjectStore, s3ClientConfig } from '../src/storage/s3.js';

describe('s3ClientConfig', () => {
  it('bounds connection and request time so an unresponsive endpoint fails fast', () => {
    const config = s3ClientConfig({
      endpoint: 'http://target:8333',
      region: 'eu-west-2',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
    });
    expect(config).toMatchObject({
      endpoint: 'http://target:8333',
      region: 'eu-west-2',
      forcePathStyle: true,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    });
  });
});

const opts = { endpoint: 'http://s3', region: 'r', accessKeyId: 'a', secretAccessKey: 's' };

describe('S3ObjectStore deletes', () => {
  it('deletes a single key', async () => {
    const send = vi.fn(async (_cmd: unknown) => ({}));
    await new S3ObjectStore(opts, { send } as never).delete('b', 'k');
    const cmd = send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect((cmd as DeleteObjectCommand).input).toEqual({ Bucket: 'b', Key: 'k' });
  });

  it('lists every page under a prefix and deletes in batches', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return cmd.input.ContinuationToken
          ? { Contents: [{ Key: 'j1/c' }], IsTruncated: false }
          : {
              Contents: [{ Key: 'j1/a' }, { Key: 'j1/b' }],
              IsTruncated: true,
              NextContinuationToken: 't',
            };
      }
      return {};
    });
    expect(await new S3ObjectStore(opts, { send } as never).deletePrefix('runs', 'j1/')).toBe(3);
    const cmds = send.mock.calls.map((c) => c[0]);
    const deletes = cmds.filter((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand[];
    expect(deletes.flatMap((d) => d.input.Delete!.Objects!.map((o) => o.Key))).toEqual([
      'j1/a',
      'j1/b',
      'j1/c',
    ]);
    const lists = cmds.filter((c) => c instanceof ListObjectsV2Command) as ListObjectsV2Command[];
    expect(lists[0]!.input).toMatchObject({ Bucket: 'runs', Prefix: 'j1/' });
  });
});
