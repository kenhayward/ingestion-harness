import { describe, expect, it } from 'vitest';
import { loadConfig, s3KeysConfig, targetConfig } from '../src/config.js';

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

  it.each([
    ['', null],
    ['   ', null],
    ['https://*.3dexperience.3ds.com', 'https://*.3dexperience.3ds.com'],
    [
      ' https://*.3dexperience.3ds.com   https://portal.example.com:8443 ',
      'https://*.3dexperience.3ds.com https://portal.example.com:8443',
    ],
  ])('reads FRAME_ANCESTORS %j as %j', (value, expected) => {
    expect(loadConfig({ ...base, FRAME_ANCESTORS: value }).FRAME_ANCESTORS).toBe(expected);
  });

  it.each([
    "'none'",
    '*',
    'http://insecure.example.com',
    'https://*',
    'https://a.example.com; script-src *',
    "https://a.example.com 'unsafe-inline'",
    'https://a.example.com/path',
  ])('refuses FRAME_ANCESTORS %j: only https hosts, a leading *. allowed', (value) => {
    expect(() => loadConfig({ ...base, FRAME_ANCESTORS: value })).toThrow(/FRAME_ANCESTORS/);
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

describe('s3KeysConfig (ADR 0008)', () => {
  it('issues keys for the publish bucket when the target is the local SeaweedFS', () => {
    expect(s3KeysConfig(loadConfig(base))).toEqual({ bucket: 'ingest-published', endpoint: null });
    expect(
      s3KeysConfig(
        loadConfig({
          ...base,
          TARGET_S3_ENDPOINT: 'http://localhost:8333',
          TARGET_S3_BUCKET: 'published',
          S3_PUBLIC_URL: 'https://lake-s3.example.com',
        }),
      ),
    ).toEqual({ bucket: 'published', endpoint: 'https://lake-s3.example.com' });
  });

  it('is off when the publish target is another S3 service', () => {
    expect(
      s3KeysConfig(
        loadConfig({ ...base, TARGET_S3_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com' }),
      ),
    ).toBeNull();
  });

  it('rejects a malformed public URL', () => {
    expect(() => loadConfig({ ...base, S3_PUBLIC_URL: 'lake-s3' })).toThrow(/S3_PUBLIC_URL/);
  });
});
