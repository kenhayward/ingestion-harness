import { describe, expect, it } from 'vitest';
import { loadBridgeConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x/y', BRIDGE_CLIENT_KEY: 'k'.repeat(32) };

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
});
