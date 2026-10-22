import type { HandoffUser } from '@ih/bridge-contract';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { MemoryObjectStore } from '../src/s3/store.js';
import { encryptSecret } from '../src/secrets.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { S3Sink } from '../src/sinks/s3.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import type { ProducerClient } from '../src/producer/client.js';
import { connection } from './connections-contract.js';
import { SECRETS, TEST_CONFIG, testBridge } from './helpers.js';
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
const olive: HandoffUser = { id: 'u3', name: 'Olive', email: null, role: 'operator' };
const otto: HandoffUser = { id: 'u4', name: 'Otto', email: null, role: 'operator' };

/** A personal sink with two instances, its password secret. */
const acmeSink = () =>
  new FakeSink({
    name: 'Acme',
    connectionKind: 'personal',
    instances: [
      { id: 'sandbox', label: 'Sandbox' },
      { id: 'prod', label: 'Production' },
    ],
    credentialFields: [
      { id: 'username', label: 'Username', secret: false },
      { id: 'password', label: 'Password', secret: true },
    ],
  });

async function setup(
  store = new MemoryObjectStore(),
  acme: FakeSink | null = null,
  config: Partial<typeof TEST_CONFIG> = {},
) {
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
    config: { ...TEST_CONFIG, ...config },
    targets,
    connections,
    sinks: new MapSinkRegistry(acme ? { s3, acme } : { s3 }),
    producer: new OneShotProducer(
      new Map([
        ['good', admin],
        ['designer', designer],
        ['olive', olive],
        ['otto', otto],
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
  // An empty tab without a form carries no token: an admin's shared tab always has the built-in.
  const token = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)?.[1];
  const csrf =
    token(page.body) ??
    token(
      (
        await app.inject({
          url: '/connections/new?tab=shared',
          cookies: { bridge_session: cookie?.value ?? '' },
        })
      ).body,
    ) ??
    '';
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
    const { cookie } = await login(app);
    const view = (url: string) => app.inject({ url, cookies: { bridge_session: cookie!.value } });
    const shared = await view('/connections?tab=shared');
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toContain('Finance account');
    expect(shared.body).toContain('Default target');
    const finance = await view('/connections/finance');
    expect(finance.body).toContain('https://s3.example.com');
    expect(finance.body).toContain('Secret stored');
    expect((await view('/connections/env-keys')).body).toContain('Keys from TARGET_S3_SECRET_KEY');
    for (const page of [shared, finance]) expect(page.body).not.toContain(SECRET);
  });

  it('refuses non-admins the shared connections', async () => {
    const { app, connections } = await setup();
    const { page, cookie, csrf } = await login(app, 'designer');
    expect(page.body).toContain('Your connections');
    expect(page.body).not.toContain('This deployment');
    expect(page.body).not.toContain('Personal connections arrive later');
    const res = await post(app, '/connections', cookie!.value, newConnection(csrf));
    expect(res.statusCode).toBe(403);
    expect(await connections.get('finance')).toBeNull();
    const edit = await app.inject({
      url: '/connections/internal',
      cookies: { bridge_session: cookie!.value },
    });
    expect(edit.statusCode).toBe(404);
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

const PASSWORD = 'the-personal-password-9';
const personal = (csrf: string, over: Record<string, string> = {}) => ({
  csrf,
  kind: 'personal',
  sinkId: 'acme',
  instanceId: 'sandbox',
  name: 'My sandbox login',
  username: 'alice',
  password: PASSWORD,
  ...over,
});

describe('personal connections on the page', () => {
  async function added(code = 'olive') {
    const sink = acmeSink();
    const { app, connections } = await setup(new MemoryObjectStore(), sink);
    const { cookie, csrf } = await login(app, code);
    const res = await post(app, '/connections', cookie!.value, personal(csrf));
    const [mine] = await connections.list({ kind: 'personal' });
    return { app, connections, sink, cookie: cookie!.value, csrf, res, mine: mine! };
  }

  it('an operator sees their own connections and no shared table', async () => {
    const { app } = await setup(new MemoryObjectStore(), acmeSink());
    const { page } = await login(app, 'olive');
    expect(page.body).toContain('Your connections');
    expect(page.body).toContain('Add a connection to Acme');
    expect(page.body).toContain('<option value="prod">Production</option>');
    expect(page.body).not.toContain('Shared connections');
    expect(page.body).not.toContain('This deployment');
  });

  it('adds one: tested against its instance, owned, an id made up, the password never shown', async () => {
    const { sink, res, mine } = await added();
    expect(res.statusCode).toBe(200);
    expect(sink.tested).toEqual([
      { instanceId: 'sandbox', credential: { username: 'alice', password: PASSWORD } },
    ]);
    expect(mine).toMatchObject({
      kind: 'personal',
      owner: 'u3',
      sinkId: 'acme',
      instanceId: 'sandbox',
      name: 'My sandbox login',
      fields: { username: 'alice' },
      status: 'ok',
      secretSet: true,
    });
    expect(mine.id).toMatch(/^u-[0-9a-f]{16}$/);
    expect(res.body).toContain('My sandbox login: connected as fake:alice.');
    expect(res.body).not.toContain(PASSWORD);
  });

  it('a failing test saves nothing, unless saved untested with the reason', async () => {
    const sink = acmeSink().scriptTest('credential_rejected', 'credential_rejected');
    const { app, connections } = await setup(new MemoryObjectStore(), sink);
    const { cookie, csrf } = await login(app, 'olive');
    const refused = await post(app, '/connections', cookie!.value, personal(csrf));
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain(
      'The test failed: scripted credential_rejected. Nothing was saved.',
    );
    expect(refused.body).not.toContain(PASSWORD);
    expect(await connections.list({ kind: 'personal' })).toEqual([]);
    await post(app, '/connections', cookie!.value, personal(csrf, { saveUntested: 'on' }));
    expect(await connections.list({ kind: 'personal' })).toMatchObject([
      { status: 'untested', statusReason: 'scripted credential_rejected' },
    ]);
  });

  it('refuses a second connection for the same instance, and an unknown instance', async () => {
    const { app, connections, cookie, csrf } = await added();
    const again = await post(app, '/connections', cookie, personal(csrf, { name: 'Again' }));
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('You already have a connection for Sandbox: update that one.');
    const unknown = await post(app, '/connections', cookie, personal(csrf, { instanceId: 'nope' }));
    expect(unknown.statusCode).toBe(422);
    const prod = await post(app, '/connections', cookie, personal(csrf, { instanceId: 'prod' }));
    expect(prod.statusCode).toBe(200);
    expect(await connections.list({ kind: 'personal' })).toHaveLength(2);
  });

  it('update with a blank password keeps it; rename, re-test and delete work for the owner', async () => {
    const { app, connections, sink, cookie, csrf, mine } = await added();
    const updated = await post(app, `/connections/${mine.id}`, cookie, {
      csrf,
      sinkId: 'acme',
      name: 'Renamed',
      username: 'alice2',
      password: '',
    });
    expect(updated.statusCode).toBe(303);
    expect(sink.tested.at(-1)).toEqual({
      instanceId: 'sandbox',
      credential: { username: 'alice2', password: PASSWORD },
    });
    expect(await connections.get(mine.id)).toMatchObject({
      name: 'Renamed',
      fields: { username: 'alice2' },
      owner: 'u3',
      kind: 'personal',
      instanceId: 'sandbox',
    });
    const tested = await post(app, `/connections/${mine.id}/test`, cookie, { csrf });
    expect(tested.body).toContain('Renamed: connected as fake:alice2.');
    await post(app, `/connections/${mine.id}/delete`, cookie, { csrf });
    expect(await connections.get(mine.id)).toBeNull();
  });

  it('nobody else reaches it: another operator and an admin get 404, and it is unchanged', async () => {
    const { app, connections, mine } = await added();
    for (const code of ['otto', 'good']) {
      const { cookie, csrf } = await login(app, code);
      const seen = await app.inject({
        url: `/connections/${mine.id}`,
        cookies: { bridge_session: cookie!.value },
      });
      expect(seen.statusCode).toBe(404);
      for (const path of ['', '/test', '/delete']) {
        const res = await post(app, `/connections/${mine.id}${path}`, cookie!.value, {
          csrf,
          sinkId: 'acme',
          name: 'Taken over',
          username: 'mallory',
          password: 'other',
        });
        expect(res.statusCode).toBe(404);
      }
    }
    expect(await connections.get(mine.id)).toMatchObject({
      name: 'My sandbox login',
      status: 'ok',
    });
  });

  it('an admin sees their own personal connections and the shared table, nobody else’s', async () => {
    const { app } = await added();
    const { page, cookie, csrf } = await login(app, 'good');
    expect(page.body).toContain('Shared connections');
    expect(page.body).not.toContain('My sandbox login');
    await post(app, '/connections', cookie!.value, personal(csrf, { name: 'Ada sandbox' }));
    const again = await app.inject({
      url: '/connections',
      cookies: { bridge_session: cookie!.value },
    });
    expect(again.body).toContain('Ada sandbox');
    expect(again.body).not.toContain('My sandbox login');
  });

  it('with no personal sink, says so and offers no form', async () => {
    const { app } = await setup();
    const { page } = await login(app, 'olive');
    expect(page.body).toContain('No system here uses personal connections yet.');
    expect(page.body).not.toContain('name="kind" value="personal"');
  });

  it("an admin's shared add cannot take a personal id, nor learn that one exists", async () => {
    const { app, connections, mine } = await added();
    const { cookie, csrf } = await login(app, 'good');
    for (const id of [mine.id, 'u-0000000000000000']) {
      const res = await post(app, '/connections', cookie!.value, newConnection(csrf, { id }));
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('Ids starting u- are kept for personal connections.');
    }
    expect(await connections.get(mine.id)).toMatchObject({ kind: 'personal', owner: 'u3' });
  });

  it('a personal POST needs the CSRF token', async () => {
    const { app, connections } = await setup(new MemoryObjectStore(), acmeSink());
    const { cookie } = await login(app, 'olive');
    const res = await post(app, '/connections', cookie!.value, personal('forged'));
    expect(res.statusCode).toBe(403);
    expect(await connections.list({ kind: 'personal' })).toEqual([]);
  });
});

describe('the page in a CT Studio frame', () => {
  const APP = 'https://ctstudio.app';
  const framed = (acme: FakeSink | null = acmeSink()) =>
    setup(new MemoryObjectStore(), acme, { BRIDGE_APP_ORIGIN: APP });
  const csp = (r: LightMyRequestResponse) => r.headers['content-security-policy'];
  /** Follows a 303 with the session cookie. */
  const follow = (app: FastifyInstance, r: LightMyRequestResponse, cookie: string) =>
    app.inject({
      url: `/connections${String(r.headers.location).split('/connections')[1]}`,
      cookies: { bridge_session: cookie },
    });

  it('may be framed by BRIDGE_APP_ORIGIN alone, and by nobody without it', async () => {
    const { app } = await framed();
    const { page } = await login(app);
    expect(csp(page)).toBe(`default-src 'self'; form-action 'self'; frame-ancestors ${APP}`);
    expect(page.body).toContain(`data-app-origin="${APP}"`);
    const plain = await setup();
    const other = await login(plain.app);
    expect(csp(other.page)).toBe("default-src 'self'; form-action 'self'; frame-ancestors 'none'");
    expect(other.page.body).toContain('data-app-origin=""');
  });

  it('serves the script that tells CT Studio, and loads it on every page', async () => {
    const { app } = await framed();
    const js = await app.inject('/connections/page.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.body).toContain('postMessage');
    expect(js.body).toContain('ct-bridge');
    const { page } = await login(app);
    expect(page.body).toContain('<script src="/bridge/connections/page.js" defer></script>');
  });

  it('shows the theme CT Studio asked for, and ignores any other', async () => {
    const { app } = await framed();
    const start = await app.inject('/connections/start?code=good&theme=dark');
    const cookie = start.cookies.find((c) => c.name === 'bridge_session')!.value;
    const page = await follow(app, start, cookie);
    expect(page.body).toContain('<html lang="en" data-theme="dark">');
    const odd = await app.inject('/connections/start?code=designer&theme=blue');
    const oddPage = await follow(
      app,
      odd,
      odd.cookies.find((c) => c.name === 'bridge_session')!.value,
    );
    expect(oddPage.body).toContain('<html lang="en">');
    expect(oddPage.body).not.toContain('blue');
  });

  it('tells CT Studio after every change, and not after a refusal or a plain view', async () => {
    const { app, connections } = await framed();
    const { cookie, csrf, page } = await login(app, 'olive');
    const c = cookie!.value;
    expect(page.body).not.toContain('data-event');
    const refused = await post(app, '/connections', c, personal(csrf, { name: '' }));
    expect(refused.statusCode).toBe(422);
    expect(refused.body).not.toContain('data-event');
    const added = await post(app, '/connections', c, personal(csrf));
    expect(added.body).toContain('data-event="changed"');
    const [mine] = await connections.list({ kind: 'personal' });
    const tested = await post(app, `/connections/${mine!.id}/test`, c, { csrf });
    expect(tested.body).toContain('data-event="changed"');
    const saved = await post(app, `/connections/${mine!.id}`, c, {
      csrf,
      name: 'Renamed',
      username: 'alice',
    });
    expect(saved.statusCode).toBe(303);
    expect((await follow(app, saved, c)).body).toContain('data-event="changed"');
    const deleted = await post(app, `/connections/${mine!.id}/delete`, c, { csrf });
    expect((await follow(app, deleted, c)).body).toContain('data-event="changed"');
  });

  it('tells CT Studio when the session has ended or the link expired', async () => {
    const { app } = await framed();
    const ended = await app.inject('/connections');
    expect(ended.statusCode).toBe(401);
    expect(ended.body).toContain('data-event="ended"');
    const expired = await app.inject('/connections/start?code=nope');
    expect(expired.body).toContain('data-event="ended"');
  });
});

describe('tabs, list and details', () => {
  const get = (app: FastifyInstance, url: string, cookie: string) =>
    app.inject({ url, cookies: { bridge_session: cookie } });
  /** The list's rows: each one's text, in order. */
  const rows = (body: string) =>
    [...body.matchAll(/<li class="item[^"]*">([\s\S]*?)<\/li>/g)].map((m) =>
      m[1]!
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  const finance = () => ({
    ...connection('finance', {
      name: 'Finance account',
      fields: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIAFINANCE' },
      status: 'ok' as const,
    }),
    secretEnc: encryptSecret(SECRET, SECRETS),
  });

  it('an admin has both tabs, the current one marked; others only their own', async () => {
    const { app } = await setup(new MemoryObjectStore(), acmeSink());
    const admin = await login(app, 'good');
    expect(admin.page.body).toContain('href="/bridge/connections?tab=mine" aria-current="page"');
    expect(admin.page.body).toContain('href="/bridge/connections?tab=shared"');
    const shared = await get(app, '/connections?tab=shared', admin.cookie!.value);
    expect(shared.body).toContain('href="/bridge/connections?tab=shared" aria-current="page"');
    const dee = await login(app, 'designer');
    expect(dee.page.body).not.toContain('tab=shared');
    const asked = await get(app, '/connections?tab=shared', dee.cookie!.value);
    expect(asked.statusCode).toBe(200);
    expect(asked.body).toContain('href="/bridge/connections?tab=mine" aria-current="page"');
    expect(asked.body).not.toContain('This deployment');
  });

  it('lists each connection by name and system only', async () => {
    const { app, connections } = await setup(new MemoryObjectStore(), acmeSink());
    await connections.put(finance());
    const { cookie, csrf } = await login(app, 'good');
    await post(app, '/connections', cookie!.value, personal(csrf));
    const mine = await get(app, '/connections?tab=mine', cookie!.value);
    expect(rows(mine.body)).toEqual(['My sandbox login Acme']);
    const shared = await get(app, '/connections?tab=shared', cookie!.value);
    expect(rows(shared.body)).toEqual(['Finance account S3', 'This deployment S3 Built in']);
  });

  it('selects the first connection of a tab, and offers the add form when it has none', async () => {
    const { app, connections } = await setup(new MemoryObjectStore(), acmeSink());
    await connections.put(finance());
    const { cookie } = await login(app, 'good');
    const shared = await get(app, '/connections?tab=shared', cookie!.value);
    expect(shared.body).toMatch(/<li class="item selected">[\s\S]*?Finance account/);
    expect(shared.body).toContain('https://s3.example.com');
    const mine = await get(app, '/connections?tab=mine', cookie!.value);
    expect(mine.body).toContain('Add a connection to Acme');
  });

  it("shows a connection's details, its form and its actions", async () => {
    const { app, connections } = await setup();
    await connections.put(finance());
    const { cookie } = await login(app, 'good');
    const page = await get(app, '/connections/finance', cookie!.value);
    expect(page.body).toMatch(/<li class="item selected">[\s\S]*?Finance account/);
    for (const text of [
      'https://s3.example.com',
      'OK',
      'Never',
      'Secret stored',
      'Test and save',
    ]) {
      expect(page.body).toContain(text);
    }
    expect(page.body).toContain('action="/bridge/connections/finance/test"');
    expect(page.body).toContain('href="/bridge/connections/finance/delete"');
    expect(page.body).not.toContain(SECRET);
  });

  it("shows the built-in connection's details without a form", async () => {
    const { app } = await setup();
    const { cookie } = await login(app, 'good');
    for (const url of ['/connections?tab=shared', '/connections/internal']) {
      const page = await get(app, url, cookie!.value);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('This deployment’s storage');
      expect(page.body).not.toContain('Test and save');
      expect(page.body).not.toContain('/connections/internal/delete');
    }
  });

  it('adds through the chosen system', async () => {
    const { app } = await setup();
    const { cookie } = await login(app, 'good');
    const s3 = await get(app, '/connections/new?tab=shared&sink=s3', cookie!.value);
    expect(s3.body).toContain('Add a shared connection to S3');
    expect(s3.body).toContain('name="sinkId" value="s3"');
    // An unknown system: the choice, or with one system its form.
    const unknown = await get(app, '/connections/new?tab=shared&sink=nope', cookie!.value);
    expect(unknown.body).toContain('Add a shared connection to S3');
    const dee = await login(app, 'designer');
    const notHers = await get(app, '/connections/new?tab=shared&sink=s3', dee.cookie!.value);
    expect(notHers.body).not.toContain('Add a shared connection');
  });

  it('offers a choice of system when there are several', async () => {
    const lake = new FakeSink({
      name: 'Lake',
      connectionKind: 'shared',
      credentialFields: [{ id: 'token', label: 'Token', secret: true }],
    });
    const { app } = await setup(new MemoryObjectStore(), lake);
    const { cookie } = await login(app, 'good');
    const choice = await get(app, '/connections/new?tab=shared', cookie!.value);
    expect(choice.body).toContain('Choose the system it connects to.');
    expect(choice.body).toContain('href="/bridge/connections/new?tab=shared&amp;sink=s3"');
    expect(choice.body).toContain('href="/bridge/connections/new?tab=shared&amp;sink=acme"');
    const form = await get(app, '/connections/new?tab=shared&sink=acme', cookie!.value);
    expect(form.body).toContain('Add a shared connection to Lake');
  });

  it('asks before deleting', async () => {
    const { app, connections } = await setup();
    await connections.put(finance());
    const { cookie, csrf } = await login(app, 'good');
    const ask = await get(app, '/connections/finance/delete', cookie!.value);
    expect(ask.statusCode).toBe(200);
    expect(ask.body).toContain('Delete Finance account?');
    expect(ask.body).toContain('Targets using it stop delivering.');
    expect(ask.body).toContain('action="/bridge/connections/finance/delete"');
    expect(ask.body).toContain('href="/bridge/connections/finance"');
    const done = await post(app, '/connections/finance/delete', cookie!.value, { csrf });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/bridge/connections?tab=shared&changed=1');
    expect(await connections.get('finance')).toBeNull();
  });

  it('shows a notice in the details and goes back to the saved connection', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await login(app, 'good');
    const made = await post(app, '/connections', cookie!.value, newConnection(csrf));
    expect(made.headers.location).toBe('/bridge/connections/finance?changed=1');
    const tested = await post(app, '/connections/finance/test', cookie!.value, { csrf });
    expect(tested.body).toMatch(
      /<section class="details">\s*<p class="notice">Finance account: Connected\./,
    );
  });

  it("keeps another user's connection out of reach of the delete question", async () => {
    const { app, connections } = await setup(new MemoryObjectStore(), acmeSink());
    const olive = await login(app, 'olive');
    await post(app, '/connections', olive.cookie!.value, personal(olive.csrf));
    const [mine] = await connections.list({ kind: 'personal' });
    const otto = await login(app, 'otto');
    expect((await get(app, `/connections/${mine!.id}/delete`, otto.cookie!.value)).statusCode).toBe(
      404,
    );
  });
});
