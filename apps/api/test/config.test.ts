import { describe, expect, it } from 'vitest';
import { fusekiConfig, githubConfig, loadConfig, s3KeysConfig } from '../src/config.js';

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
    ['https://*.dashboard.example.com', 'https://*.dashboard.example.com'],
    [
      ' https://*.dashboard.example.com   https://portal.example.com:8443 ',
      'https://*.dashboard.example.com https://portal.example.com:8443',
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

  // The default publishing target is seeded from these (defaultSeed, shared fixture).
  it('treats empty TARGET_S3_* values (docker-compose defaults) as unset', () => {
    const c = loadConfig({
      ...base,
      TARGET_S3_ENDPOINT: '',
      TARGET_S3_REGION: '',
      TARGET_S3_ACCESS_KEY: '',
      TARGET_S3_SECRET_KEY: '',
      TARGET_S3_BUCKET: '',
      TARGET_S3_PREFIX: '',
    });
    expect(c).toMatchObject({ TARGET_S3_BUCKET: 'ingest-published', TARGET_S3_PREFIX: '' });
    expect(c.TARGET_S3_ENDPOINT).toBeUndefined();
    expect(c.TARGET_S3_REGION).toBeUndefined();
    expect(c.TARGET_S3_ACCESS_KEY).toBeUndefined();
    expect(c.TARGET_S3_SECRET_KEY).toBeUndefined();
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

describe('backup settings', () => {
  it('default to the ingest-backups bucket and no triple store', () => {
    const cfg = loadConfig({ ...base, RDF_ENDPOINT: '', RDF_PASSWORD: '' });
    expect(cfg.S3_BUCKET_BACKUPS).toBe('ingest-backups');
    expect(fusekiConfig(cfg)).toEqual({
      endpoint: '',
      dataset: 'ct',
      user: 'ct-writer',
      password: '',
    });
  });

  it('read the triple store the worker writes to', () => {
    const cfg = loadConfig({
      ...base,
      S3_BUCKET_BACKUPS: 'b',
      RDF_ENDPOINT: 'http://fuseki:3030',
      RDF_DATASET: 'acme',
      RDF_USER: 'ct-writer',
      RDF_PASSWORD: 'pw',
    });
    expect(cfg.S3_BUCKET_BACKUPS).toBe('b');
    expect(fusekiConfig(cfg)).toEqual({
      endpoint: 'http://fuseki:3030',
      dataset: 'acme',
      user: 'ct-writer',
      password: 'pw',
    });
  });
});
