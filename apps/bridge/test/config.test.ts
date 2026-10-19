import { describe, expect, it } from 'vitest';
import { loadBridgeConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x/y',
  BRIDGE_CLIENT_KEY: 'k'.repeat(32),
  BRIDGE_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  S3_ENDPOINT: 'http://seaweedfs:8333',
  S3_ACCESS_KEY: 'internal-key',
  S3_SECRET_KEY: 'internal-secret',
};

describe('bridge config', () => {
  it('lists every config problem at once', () => {
    expect(() => loadBridgeConfig({ DATABASE_URL: 'nope', BRIDGE_CLIENT_KEY: 'short' })).toThrow(
      /Invalid bridge configuration:[\s\S]*DATABASE_URL[\s\S]*BRIDGE_CLIENT_KEY/,
    );
  });

  it('applies defaults and treats blanks as unset', () => {
    const c = loadBridgeConfig({ ...base, BRIDGE_EVENTS_URL: '' });
    expect(c).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 3100,
      BRIDGE_MAX_PACKAGE_MB: 50,
      BRIDGE_MAX_ATTEMPTS: 8,
      BRIDGE_LEASE_SECONDS: 300,
      BRIDGE_PACKAGE_RETENTION_DAYS: 30,
    });
    expect(c.BRIDGE_EVENTS_URL).toBeUndefined();
  });

  it('reads numbers from strings', () => {
    expect(loadBridgeConfig({ ...base, PORT: '4000', BRIDGE_MAX_ATTEMPTS: '3' })).toMatchObject({
      PORT: 4000,
      BRIDGE_MAX_ATTEMPTS: 3,
    });
  });

  it('needs BRIDGE_SECRETS_KEY as 32 bytes of base64, and parses the previous one', () => {
    const noKey: Record<string, string> = { ...base };
    delete noKey.BRIDGE_SECRETS_KEY;
    expect(() => loadBridgeConfig(noKey)).toThrow(/BRIDGE_SECRETS_KEY/);
    expect(() => loadBridgeConfig({ ...base, BRIDGE_SECRETS_KEY: 'short' })).toThrow(
      /BRIDGE_SECRETS_KEY/,
    );
    const previous = Buffer.alloc(32, 9).toString('base64');
    const c = loadBridgeConfig({ ...base, BRIDGE_SECRETS_KEY_PREVIOUS: previous });
    expect(c.secrets.current).toEqual(Buffer.alloc(32, 7));
    expect(c.secrets.previous).toEqual(Buffer.alloc(32, 9));
    expect(
      loadBridgeConfig({ ...base, BRIDGE_SECRETS_KEY_PREVIOUS: '' }).secrets.previous,
    ).toBeNull();
  });
});
