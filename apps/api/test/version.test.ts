import { describe, expect, it } from 'vitest';
import { MemoryAccessRepo } from '../src/access/repo.js';
import { loadConfig, versionFromConfig } from '../src/config.js';
import { testApp } from './helpers.js';

const tagged = { version: '2026.10.17.3', previous: '2026.10.17.2', commit: 'abc1234' };

describe('GET /api/version', () => {
  it('reports the build', async () => {
    const { app } = await testApp({ version: tagged });
    const res = await app.inject('/api/version');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(tagged);
  });

  it('is a dev build when nothing says otherwise', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/version')).json()).toEqual({
      version: 'dev',
      previous: null,
      commit: 'unknown',
    });
  });

  it('needs no session', async () => {
    const { app } = await testApp({ access: new MemoryAccessRepo(), version: tagged });
    const res = await app.inject('/api/version');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(tagged);
  });
});

describe('versionFromConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    S3_ENDPOINT: 'http://s3',
    S3_ACCESS_KEY: 'a',
    S3_SECRET_KEY: 'b',
    BRIDGE_URL: 'http://bridge:3100',
    BRIDGE_CLIENT_KEY: 'k'.repeat(32),
  };

  it('reads the build args the image sets', () => {
    const config = loadConfig({
      ...base,
      APP_VERSION: '2026.10.17.3',
      APP_VERSION_PREVIOUS: '2026.10.17.2',
      APP_COMMIT: 'abc1234',
    });
    expect(versionFromConfig(config)).toEqual(tagged);
  });

  it('defaults to a dev build, an empty previous tag being none', () => {
    expect(versionFromConfig(loadConfig({ ...base, APP_VERSION_PREVIOUS: '' }))).toEqual({
      version: 'dev',
      previous: null,
      commit: 'unknown',
    });
  });
});
