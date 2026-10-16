import { describe, expect, it } from 'vitest';
import { githubConfig, loadConfig, s3KeysConfig, targetConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/ih',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
};

describe('githubConfig', () => {
  it('is off without an OAuth app', () => {
    expect(
      githubConfig(loadConfig({ ...base, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' })),
    ).toBeNull();
  });

  it('reads the OAuth app and its callback address', () => {
    const cfg = loadConfig({
      ...base,
      GITHUB_CLIENT_ID: 'Iv1.abc',
      GITHUB_CLIENT_SECRET: 'shh',
      GITHUB_REDIRECT_URL: 'https://ct.example/api/profile/github/callback',
    });
    expect(githubConfig(cfg)).toEqual({
      clientId: 'Iv1.abc',
      clientSecret: 'shh',
      redirectUrl: 'https://ct.example/api/profile/github/callback',
    });
    expect(
      githubConfig(loadConfig({ ...base, GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' }))
        ?.redirectUrl,
    ).toBeNull();
  });

  it.each([{ GITHUB_CLIENT_ID: 'a' }, { GITHUB_CLIENT_SECRET: 'b' }])(
    'refuses half an OAuth app: %j',
    (env) => {
      expect(() => loadConfig({ ...base, ...env })).toThrow(
        /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET go together/,
      );
    },
  );
});

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

  it('reads the linked data customer and base', () => {
    const cfg = loadConfig({
      ...base,
      LINKED_DATA_CUSTOMER: 'acme=Acme Pharma',
      LINKED_DATA_BASE_IRI: 'https://data.acme.example/',
    });
    expect(cfg.LINKED_DATA_CUSTOMER).toBe('acme=Acme Pharma');
  });

  it.each([
    [{ LINKED_DATA_CUSTOMER: 'Acme Ltd=Acme' }, /LINKED_DATA_CUSTOMER/],
    [
      { LINKED_DATA_CUSTOMER: 'acme', LINKED_DATA_BASE_IRI: 'https://x.example/ids' },
      /must end with \//,
    ],
    [
      { LINKED_DATA_BASE_IRI: 'https://x.example/' },
      /LINKED_DATA_BASE_IRI needs LINKED_DATA_CUSTOMER/,
    ],
  ])('refuses linked data settings %j', (env, error) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(error);
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
  it('always offers the public URL, whatever the old target endpoint was', () => {
    expect(s3KeysConfig(loadConfig(base))).toEqual({ endpoint: null });
    expect(
      s3KeysConfig(
        loadConfig({
          ...base,
          TARGET_S3_ENDPOINT: 'https://s3.eu-west-2.amazonaws.com',
          S3_PUBLIC_URL: 'https://lake-s3.example.com',
        }),
      ),
    ).toEqual({ endpoint: 'https://lake-s3.example.com' });
  });

  it('rejects a malformed public URL', () => {
    expect(() => loadConfig({ ...base, S3_PUBLIC_URL: 'lake-s3' })).toThrow(/S3_PUBLIC_URL/);
  });
});
