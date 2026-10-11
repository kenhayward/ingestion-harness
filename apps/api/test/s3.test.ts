import { describe, expect, it } from 'vitest';
import { s3ClientConfig } from '../src/storage/s3.js';

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
