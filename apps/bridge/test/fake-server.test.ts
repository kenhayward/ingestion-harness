import { signRequest } from '@ih/bridge-contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFakeServer } from '../src/sinks/fake-server.js';
import { KEY } from './helpers.js';
import { decomposedPackage, deliverRequest } from './sink-builders.js';

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function server() {
  const app = await buildFakeServer(KEY);
  open.push(app);
  const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return app.inject({
      method,
      url,
      headers: {
        ...signRequest(KEY, { method, path: url, body: payload }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload }),
    });
  };
  return { app, signed };
}

describe('the fake external sink server', () => {
  it('describes a shared sink with a browsable space and an overridable name pattern', async () => {
    const { signed } = await server();
    const res = await signed('GET', '/describe');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Fake sink',
      connectionKind: 'shared',
      destinationFields: [
        { id: 'space', kind: 'fixed', required: true, browse: true },
        { id: 'name', kind: 'pattern', required: true, overridable: true },
      ],
      capabilities: { replace: true, withdraw: false, accepts: ['files', 'data'] },
    });
  });

  it('refuses unsigned sink routes', async () => {
    const { app } = await server();
    expect((await app.inject('/describe')).statusCode).toBe(401);
  });

  it('lists what it was delivered without bytes, and how many keys it holds', async () => {
    const { app, signed } = await server();
    const req = deliverRequest({ destination: { space: 's', name: 'n' } });
    expect((await signed('POST', '/deliveries', req)).statusCode).toBe(200);
    expect((await signed('POST', '/deliveries', req)).statusCode).toBe(200);
    const res = await app.inject('/_delivered');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toBe(1);
    expect(body.deliveries).toHaveLength(2);
    expect(body.deliveries[0]).toMatchObject({
      idempotencyKey: req.idempotencyKey,
      destination: { space: 's', name: 'n' },
    });
    expect(JSON.stringify(body)).not.toContain(req.package.files[0]!.content);
  });
});

describe('the fake external sink server, names', () => {
  it('refuses a name starting taken- as held by another document', async () => {
    const { signed } = await server();
    const res = await signed(
      'POST',
      '/deliveries',
      deliverRequest({ destination: { space: 's', name: 'taken-x' } }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      class: 'needs_user',
      code: 'name_conflict',
      message: 'another document is named taken-x',
      details: { field: 'name', value: 'taken-x' },
    });
  });
});

describe('the fake external sink server, documents mode', () => {
  it('documents mode serves describe v2 and /_edit', async () => {
    const app = await buildFakeServer(KEY, false, 'documents');
    open.push(app);
    const signed = (method: 'GET' | 'POST', url: string, body?: unknown) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      return app.inject({
        method,
        url,
        headers: {
          ...signRequest(KEY, { method, path: url, body: payload }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { payload }),
      });
    };
    const described = await signed('GET', '/describe');
    expect(described.statusCode).toBe(200);
    expect(described.json()).toMatchObject({
      contractVersion: 2,
      capabilities: { accepts: ['document', 'images'], readBack: true },
    });

    const created = await signed(
      'POST',
      '/deliveries',
      deliverRequest({ package: decomposedPackage, destination: { space: 's' } }),
    );
    expect(created.statusCode).toBe(200);
    const { persistentId, components } = created.json().receipt.document;
    const section = components.find((c: { kind: string }) => c.kind === 'section');

    const edit = (body: unknown) =>
      app.inject({ method: 'POST', url: '/_edit', payload: body as object });
    const edited = await edit({ persistentId, componentId: section.id });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: section.id, version: '2' });
    expect((await edit({ persistentId, componentId: 'nope' })).statusCode).toBe(404);
    expect((await edit({ persistentId: 'doc-404', componentId: section.id })).statusCode).toBe(404);

    const refused = await signed('POST', '/deliveries', {
      ...deliverRequest({ package: decomposedPackage, destination: { space: 's' } }),
      idempotencyKey: 'an update',
      update: { persistentId, expected: components },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'changed_in_target' });
  });

  it('documents mode serves /_delete: an update of a deleted document is not found', async () => {
    const app = await buildFakeServer(KEY, false, 'documents');
    open.push(app);
    const signed = (body: unknown) => {
      const payload = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: '/deliveries',
        headers: {
          ...signRequest(KEY, { method: 'POST', path: '/deliveries', body: payload }),
          'content-type': 'application/json',
        },
        payload,
      });
    };
    const created = await signed(
      deliverRequest({ package: decomposedPackage, destination: { space: 's' } }),
    );
    const { persistentId, components } = created.json().receipt.document;
    const remove = (body: unknown) =>
      app.inject({ method: 'POST', url: '/_delete', payload: body as object });

    expect((await remove({ persistentId })).statusCode).toBe(204);
    expect((await remove({ persistentId })).statusCode).toBe(404);

    const refused = await signed({
      ...deliverRequest({ package: decomposedPackage, destination: { space: 's' } }),
      idempotencyKey: 'an update',
      update: { persistentId, expected: components },
    });
    expect(refused.json()).toMatchObject({ class: 'needs_user', code: 'not_found' });
  });

  it('has no /_edit outside documents mode', async () => {
    const { app } = await server();
    const res = await app.inject({ method: 'POST', url: '/_edit', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
