import { describe, expect, it } from 'vitest';
import { crossSiteWarning, loadBridgeConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x/y',
  BRIDGE_CLIENT_KEY: 'k'.repeat(32),
  BRIDGE_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  S3_ENDPOINT: 'http://seaweedfs:8333',
  S3_ACCESS_KEY: 'internal-key',
  S3_SECRET_KEY: 'internal-secret',
  BRIDGE_PRODUCER_URL: 'http://api:3000/api',
  BRIDGE_PUBLIC_URL: 'https://ct.example.com/bridge',
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

describe('BRIDGE_APP_ORIGIN', () => {
  it('is unset when blank, and kept as a bare origin', () => {
    expect(loadBridgeConfig({ ...base, BRIDGE_APP_ORIGIN: '' }).BRIDGE_APP_ORIGIN).toBeUndefined();
    expect(
      loadBridgeConfig({ ...base, BRIDGE_APP_ORIGIN: 'https://ctstudio.app' }).BRIDGE_APP_ORIGIN,
    ).toBe('https://ctstudio.app');
    expect(
      loadBridgeConfig({ ...base, BRIDGE_APP_ORIGIN: 'http://localhost:8081' }).BRIDGE_APP_ORIGIN,
    ).toBe('http://localhost:8081');
  });

  it('refuses anything but an http(s) origin', () => {
    for (const bad of ['https://ctstudio.app/x', 'https://ctstudio.app?q=1', 'ftp://x', 'nope']) {
      expect(() => loadBridgeConfig({ ...base, BRIDGE_APP_ORIGIN: bad })).toThrow(
        /BRIDGE_APP_ORIGIN/,
      );
    }
  });

  it("refuses the origin of BRIDGE_PUBLIC_URL: a page on the app's own origin is never framed", () => {
    expect(() =>
      loadBridgeConfig({
        ...base,
        BRIDGE_PUBLIC_URL: 'https://ctstudio.app/bridge',
        BRIDGE_APP_ORIGIN: 'https://ctstudio.app',
      }),
    ).toThrow(
      "BRIDGE_APP_ORIGIN must differ from BRIDGE_PUBLIC_URL's origin: a page on the app's own origin is never framed",
    );
  });
});

describe('crossSiteWarning', () => {
  it('is quiet for a subdomain of the app, the same host, or no framing at all', () => {
    expect(crossSiteWarning('https://ctstudio.app', 'https://connections.ctstudio.app')).toBeNull();
    expect(
      crossSiteWarning('https://ct.example.com', 'https://connections.example.com'),
    ).toBeNull();
    expect(crossSiteWarning('http://localhost:8081', 'http://localhost:8082')).toBeNull();
    expect(crossSiteWarning(undefined, 'https://elsewhere.example.org')).toBeNull();
  });

  it('warns when the page would be a third-party frame, whose cookie browsers block', () => {
    for (const [app, page] of [
      ['https://ctstudio.app', 'https://connections.other.app'],
      ['http://localhost:8081', 'http://127.0.0.1:8082'],
      ['https://ctstudio.app', 'http://connections.ctstudio.app'],
      ['http://192.168.1.10:8081', 'http://192.168.1.11:8082'],
    ] as const) {
      expect(crossSiteWarning(app, page)).toMatch(
        /^BRIDGE_PUBLIC_URL .* is not on the same site as BRIDGE_APP_ORIGIN .*: use a subdomain of the app's domain/,
      );
    }
  });
});
