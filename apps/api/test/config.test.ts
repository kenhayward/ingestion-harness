import { describe, expect, it } from 'vitest';
import { loadConfig, targetConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/ih',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.S3_BUCKET_INBOX).toBe('ingest-inbox');
  });

  it('reports every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*S3_ENDPOINT/);
  });

  it('resolves the target like the worker: TARGET_S3_* falling back to S3_*', () => {
    expect(targetConfig(loadConfig(base))).toEqual({
      endpoint: 'http://localhost:8333',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'ingest-published',
      prefix: '',
    });
    expect(
      targetConfig(
        loadConfig({
          ...base,
          TARGET_S3_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com',
          TARGET_S3_REGION: 'eu-west-2',
          TARGET_S3_ACCESS_KEY: 'AK',
          TARGET_S3_SECRET_KEY: 'SK',
          TARGET_S3_BUCKET: 'lake',
          TARGET_S3_PREFIX: 'ingest/',
        }),
      ),
    ).toEqual({
      endpoint: 'https://s3.eu-west-2.amazonaws.com',
      region: 'eu-west-2',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      bucket: 'lake',
      prefix: 'ingest/',
    });
  });

  it('treats empty TARGET_S3_* values (docker-compose defaults) as unset', () => {
    const t = targetConfig(
      loadConfig({
        ...base,
        TARGET_S3_ENDPOINT: '',
        TARGET_S3_REGION: '',
        TARGET_S3_ACCESS_KEY: '',
        TARGET_S3_SECRET_KEY: '',
        TARGET_S3_BUCKET: '',
        TARGET_S3_PREFIX: '',
      }),
    );
    expect(t).toMatchObject({
      endpoint: 'http://localhost:8333',
      accessKeyId: 'k',
      bucket: 'ingest-published',
      prefix: '',
    });
  });

  it('rejects a malformed target endpoint', () => {
    expect(() => loadConfig({ ...base, TARGET_S3_ENDPOINT: 'not a url' })).toThrow(
      /TARGET_S3_ENDPOINT/,
    );
  });
});
