import { describe, expect, it } from 'vitest';
import { MemoryLinkedDataRepo } from '../src/linked-data/repo.js';
import { accessApp, testApp } from './helpers.js';

const body = (over: object = {}) => ({
  customerName: 'Acme Pharma',
  customerSlug: 'acme',
  baseIri: null,
  ...over,
});

async function setup() {
  const linkedData = new MemoryLinkedDataRepo();
  const ctx = await testApp({ linkedData });
  const put = (payload: object) =>
    ctx.app.inject({ method: 'PUT', url: '/api/linked-data/settings', payload });
  return { ...ctx, linkedData, put };
}

describe('linked data settings', () => {
  it('starts empty: no customer, so no RDF', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/linked-data/settings' });
    expect(res.json()).toMatchObject({ effectiveBase: null, rdfPublished: 0, history: [] });
    expect((await app.inject({ url: '/api/linked-data/base' })).json()).toEqual({
      effectiveBase: null,
    });
  });

  it('falls back to our domain under the customer slug, then uses their own base', async () => {
    const { put, app } = await setup();
    const fallback = await put(body());
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toMatchObject({
      effectiveBase: 'https://id.stocks-hayward.com/acme/',
      settings: { customerName: 'Acme Pharma', customerSlug: 'acme', baseIri: null },
    });
    const own = await put(body({ baseIri: 'https://data.acme.example/ct/' }));
    expect(own.json().effectiveBase).toBe('https://data.acme.example/ct/');
    expect(own.json().history.map((h: { toBase: string }) => h.toBase)).toEqual([
      'https://data.acme.example/ct/',
      'https://id.stocks-hayward.com/acme/',
    ]);
    expect((await app.inject({ url: '/api/linked-data/base' })).json()).toEqual({
      effectiveBase: 'https://data.acme.example/ct/',
    });
  });

  it.each([
    [body({ baseIri: 'http://data.acme.example/' }), 'the base IRI must use https'],
    [body({ baseIri: 'https://localhost/' }), 'the base IRI cannot use a local host name'],
  ])('refuses %j', async (payload, error) => {
    const { put } = await setup();
    const res = await put(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
  });

  it('refuses a malformed body', async () => {
    const { put } = await setup();
    expect((await put(body({ customerSlug: 'Acme Co' }))).statusCode).toBe(400);
  });

  it('needs the new base repeated once RDF was published under the old one', async () => {
    const { put, linkedData } = await setup();
    await put(body());
    linkedData.rdfPublished = 3;
    const refused = await put(body({ baseIri: 'https://data.acme.example/ct/' }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(
      '3 RDF outputs were published under https://id.stocks-hayward.com/acme/: confirm the new base to change it',
    );
    const confirmed = await put(
      body({ baseIri: 'https://data.acme.example/ct/', confirm: 'https://data.acme.example/ct/' }),
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().history[0]).toMatchObject({
      fromBase: 'https://id.stocks-hayward.com/acme/',
      toBase: 'https://data.acme.example/ct/',
      rdfPublished: 3,
    });
    // Renaming the customer without moving the base needs no confirmation.
    expect(
      (await put(body({ customerName: 'Acme', baseIri: 'https://data.acme.example/ct/' })))
        .statusCode,
    ).toBe(200);
  });

  it('is admin-only, except the effective base', async () => {
    const { app, userCookie } = await accessApp();
    const headers = { cookie: userCookie };
    expect((await app.inject({ url: '/api/linked-data/settings', headers })).statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/linked-data/settings',
      headers,
      payload: body(),
    });
    expect(put.statusCode).toBe(403);
    expect((await app.inject({ url: '/api/linked-data/base', headers })).statusCode).toBe(200);
  });
});

describe('published graphs on the Linked data panel (ADR 0011 step 6)', () => {
  it('counts the graphs under the current base and says whether they reach Fuseki', async () => {
    const { app, put, linkedData } = await setup();
    await put(body({ baseIri: 'https://data.acme.example/ct/' }));
    expect((await app.inject({ url: '/api/linked-data/settings' })).json().graphs).toEqual({
      published: 0,
      lastPublishedAt: null,
      endpoint: null,
    });
    linkedData.graphs = [
      { base: 'https://data.acme.example/ct/', at: '2026-10-14T10:00:00.000Z' },
      { base: 'https://data.acme.example/ct/', at: '2026-10-14T11:00:00.000Z' },
      { base: 'https://old.example/', at: '2026-10-13T10:00:00.000Z' },
    ];
    linkedData.endpoint = true;
    expect((await app.inject({ url: '/api/linked-data/settings' })).json().graphs).toEqual({
      published: 2,
      lastPublishedAt: '2026-10-14T11:00:00.000Z',
      endpoint: true,
    });
  });
});

describe('consumer access and withdrawals on the panel (ADR 0011 step 7)', () => {
  it('names the public SPARQL endpoint and its read-only user', async () => {
    const linkedData = new MemoryLinkedDataRepo();
    const ctx = await testApp({ linkedData, rdfPublicUrl: 'https://sparql.acme.example/' });
    const view = (await ctx.app.inject({ url: '/api/linked-data/settings' })).json();
    expect(view.endpoint).toEqual({
      sparql: 'https://sparql.acme.example/ct/sparql',
      get: 'https://sparql.acme.example/ct/get',
      user: 'ct-reader',
    });
    expect(view.withdrawals).toEqual({ queued: 0, running: 0, failed: 0 });
    const none = await setup();
    expect(
      (await none.app.inject({ url: '/api/linked-data/settings' })).json().endpoint,
    ).toBeNull();
  });
});
