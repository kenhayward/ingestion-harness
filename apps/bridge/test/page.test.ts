import type { HandoffUser } from '@ih/bridge-contract';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { MemoryObjectStore } from '../src/s3/store.js';
import { encryptSecret } from '../src/secrets.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { S3Sink } from '../src/sinks/s3.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import type { ProducerClient } from '../src/producer/client.js';
import { connection } from './connections-contract.js';
import { SECRETS, testBridge } from './helpers.js';
import { s3Failure, ThrowingStore } from './s3-fakes.js';

const SECRET = 'wJalrXUtnFEMI-the-typed-secret';

/** Redeems each code once, for the user it was minted for. */
class OneShotProducer implements ProducerClient {
  constructor(private readonly codes: Map<string, HandoffUser>) {}
  async redeem(code: string): Promise<HandoffUser | null> {
    const user = this.codes.get(code) ?? null;
    this.codes.delete(code);
    return user;
  }
}

const admin: HandoffUser = { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'admin' };
const designer: HandoffUser = { id: 'u2', name: 'Dee', email: null, role: 'designer' };

async function setup(store = new MemoryObjectStore()) {
  const targets = new MemoryTargetRepo();
  const connections = new MemoryConnectionRepo(targets);
  await connections.put(connection('internal', { name: 'This deployment', fields: {} }));
  const s3 = new S3Sink({
    internal: {
      endpoint: 'http://seaweedfs:8333',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    },
    make: () => store,
  });
  const app = await testBridge({
    targets,
    connections,
    sinks: new MapSinkRegistry({ s3 }),
    producer: new OneShotProducer(
      new Map([
        ['good', admin],
        ['designer', designer],
      ]),
    ),
  });
  return { app, connections, targets };
}

/** Starts a session with `code`; answers the cookie and the CSRF token of the list page. */
async function login(app: FastifyInstance, code = 'good') {
  const start = await app.inject(`/connections/start?code=${code}`);
  const cookie = start.cookies.find((c) => c.name === 'bridge_session');
  const page = await app.inject({
    url: '/connections',
    cookies: { bridge_session: cookie?.value ?? '' },
  });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
  return { start, cookie, page, csrf };
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

function post(
  app: FastifyInstance,
  url: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    cookies: { bridge_session: cookie },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(fields),
  });
}

const newConnection = (csrf: string, over: Record<string, string> = {}) => ({
  csrf,
  id: 'finance',
  name: 'Finance account',
  endpoint: 'https://s3.example.com',
  region: 'eu-west-1',
  accessKeyId: 'AKIAFINANCE',
  secretAccessKey: SECRET,
  forcePathStyle: 'false',
  ...over,
});

describe('connections page', () => {
  it('start with a good code sets the session and redirects; a reused code is refused', async () => {
    const { app } = await setup();
    const { start, cookie } = await login(app);
    expect(start.statusCode).toBe(303);
    expect(start.headers.location).toBe('/bridge/connections');
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
      path: '/bridge',
      secure: true,
    });
    expect(cookie?.maxAge).toBe(1800);
    const again = await app.inject('/connections/start?code=good');
    expect(again.statusCode).toBe(401);
    expect(again.body).toContain('This link has expired. Open Connections again from CT Studio.');
    expect(again.cookies).toEqual([]);
  });

  it('refuses the list without a session, or with a tampered one', async () => {
    const { app } = await setup();
    expect((await app.inject('/connections')).statusCode).toBe(401);
    const { cookie } = await login(app);
    const tampered = `${cookie!.value.slice(0, -2)}xx`;
    const res = await app.inject({ url: '/connections', cookies: { bridge_session: tampered } });
    expect(res.statusCode).toBe(401);
  });

  it('lists shared connections for admins, without secrets', async () => {
    const { app, connections } = await setup();
    await connections.put({
      ...connection('finance', {
        name: 'Finance account',
        fields: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIAFINANCE' },
        status: 'ok',
      }),
      secretEnc: encryptSecret(SECRET, SECRETS),
    });
    await connections.put(
      connection('env-keys', {
        name: 'Default target',
        fields: { accessKeyIdEnv: 'TARGET_S3_ACCESS_KEY' },
        secretEnv: 'TARGET_S3_SECRET_KEY',
      }),
    );
    const { page } = await login(app);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Finance account');
    expect(page.body).toContain('https://s3.example.com');
    expect(page.body).toContain('Secret stored');
    expect(page.body).toContain('Keys from TARGET_S3_SECRET_KEY');
    expect(page.body).not.toContain(SECRET);
  });

  it('shows non-admins that personal connections come later, and refuses them shared ones', async () => {
    const { app, connections } = await setup();
    const { page, cookie } = await login(app, 'designer');
    expect(page.body).toContain('Personal connections arrive later');
    expect(page.body).not.toContain('This deployment');
    const res = await post(app, '/connections', cookie!.value, newConnection('anything'));
    expect(res.statusCode).toBe(403);
    expect(await connections.get('finance')).toBeNull();
  });

  it('a POST without a CSRF token is 403', async () => {
    const { app, connections } = await setup();
    const { cookie } = await login(app);
    const missing = await post(app, '/connections', cookie!.value, newConnection(''));
    expect(missing.statusCode).toBe(403);
    const wrong = await post(app, '/connections', cookie!.value, newConnection('forged'));
    expect(wrong.statusCode).toBe(403);
    expect(await connections.get('finance')).toBeNull();
  });

  it('create runs the test and saves a passing connection, encrypted', async () => {
    const { app, connections } = await setup();
    const { cookie, csrf } = await login(app);
    const res = await post(app, '/connections', cookie!.value, newConnection(csrf));
    expect(res.statusCode).toBe(303);
    expect(await connections.get('finance')).toMatchObject({
      kind: 'shared',
      sinkId: 's3',
      name: 'Finance account',
      status: 'ok',
      secretSet: true,
      fields: {
        endpoint: 'https://s3.example.com',
        region: 'eu-west-1',
        accessKeyId: 'AKIAFINANCE',
        forcePathStyle: 'false',
      },
    });
    const stored = await connections.secretOf('finance');
    expect(stored?.secretEnc).toMatch(/^v1:/);
    expect(stored?.secretEnc).not.toContain(SECRET);
  });

  it('create refuses to save a failing connection unless saveUntested', async () => {
    const { app, connections } = await setup(
      new ThrowingStore(() => s3Failure('InvalidAccessKeyId')),
    );
    const { cookie, csrf } = await login(app);
    const res = await post(app, '/connections', cookie!.value, newConnection(csrf));
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('the S3 endpoint refused the keys');
    expect(res.body).not.toContain(SECRET);
    expect(await connections.get('finance')).toBeNull();
    const untested = await post(
      app,
      '/connections',
      cookie!.value,
      newConnection(csrf, { saveUntested: 'on' }),
    );
    expect(untested.statusCode).toBe(303);
    expect(await connections.get('finance')).toMatchObject({ status: 'untested' });
  });

  it('update with a blank secret keeps the stored one', async () => {
    const { app, connections } = await setup();
    const { cookie, csrf } = await login(app);
    await post(app, '/connections', cookie!.value, newConnection(csrf));
    const before = await connections.secretOf('finance');
    const res = await post(
      app,
      '/connections/finance',
      cookie!.value,
      newConnection(csrf, { name: 'Renamed', secretAccessKey: '' }),
    );
    expect(res.statusCode).toBe(303);
    expect(await connections.get('finance')).toMatchObject({ name: 'Renamed', status: 'ok' });
    expect(await connections.secretOf('finance')).toEqual(before);
  });

  it('re-tests a connection, and refuses to delete one a target names', async () => {
    const { app, connections, targets } = await setup();
    const { cookie, csrf } = await login(app);
    await post(app, '/connections', cookie!.value, newConnection(csrf));
    await connections.mark('finance', 'needs_attention', 'old failure');
    const tested = await post(app, '/connections/finance/test', cookie!.value, { csrf });
    expect(tested.statusCode).toBe(200);
    expect(tested.body).toContain('Connected');
    expect((await connections.get('finance'))?.status).toBe('ok');
    await targets.put({
      id: 'finance-lake',
      label: 'Finance lake',
      sinkId: 's3',
      instanceId: null,
      connectionId: 'finance',
      destination: { bucket: 'b' },
    });
    const refused = await post(app, '/connections/finance/delete', cookie!.value, { csrf });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('Finance lake');
    expect(await connections.get('finance')).not.toBeNull();
    await targets.remove('finance-lake');
    const deleted = await post(app, '/connections/finance/delete', cookie!.value, { csrf });
    expect(deleted.statusCode).toBe(303);
    expect(await connections.get('finance')).toBeNull();
  });

  it('never lets the built-in connection be changed or deleted', async () => {
    const { app, connections } = await setup();
    const { cookie, csrf } = await login(app);
    for (const url of ['/connections/internal', '/connections/internal/delete']) {
      expect((await post(app, url, cookie!.value, newConnection(csrf))).statusCode).toBe(403);
    }
    expect(
      (await post(app, '/connections', cookie!.value, newConnection(csrf, { id: 'internal' })))
        .statusCode,
    ).toBe(409);
    expect(await connections.get('internal')).toMatchObject({ fields: {} });
  });

  it('the secret is never in any response body', async () => {
    const { app } = await setup();
    const { cookie, csrf, page } = await login(app);
    const bodies = [page.body];
    bodies.push((await post(app, '/connections', cookie!.value, newConnection(csrf))).body);
    bodies.push(
      (await app.inject({ url: '/connections', cookies: { bridge_session: cookie!.value } })).body,
    );
    bodies.push(
      (
        await app.inject({
          url: '/connections/finance',
          cookies: { bridge_session: cookie!.value },
        })
      ).body,
    );
    bodies.push((await post(app, '/connections/finance/test', cookie!.value, { csrf })).body);
    for (const body of bodies) expect(body).not.toContain(SECRET);
  });

  it('responses carry the CSP and no-store headers', async () => {
    const { app } = await setup();
    const { start, page } = await login(app);
    const refused = await app.inject('/connections/start?code=bad');
    for (const res of [start, page, refused]) {
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'self'; form-action 'self'; frame-ancestors 'none'",
      );
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});
