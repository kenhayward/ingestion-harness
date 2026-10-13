import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { md, res } from '../src/openapi/zod.js';
import { testApp } from './helpers.js';

type Doc = OpenAPIV3_1.Document & { 'x-tagGroups': { name: string; tags: string[] }[] };

async function openapi(): Promise<Doc> {
  const { app } = await testApp();
  const reply = await app.inject('/api/docs/openapi.json');
  expect(reply.statusCode).toBe(200);
  return reply.json<Doc>();
}

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document without deployment details', async () => {
    const doc = await openapi();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: '/' }]);
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeTruthy();
  });

  it('puts every tag in exactly one group', async () => {
    const doc = await openapi();
    const grouped = doc['x-tagGroups'].flatMap((g) => g.tags);
    expect([...grouped].sort()).toEqual((doc.tags ?? []).map((t) => t.name).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('leaves the docs routes out of the document', async () => {
    const doc = await openapi();
    expect(Object.keys(doc.paths ?? {}).filter((p) => p.startsWith('/api/docs'))).toEqual([]);
  });
});

describe('docs browser', () => {
  it('serves the reference page and its script', async () => {
    const { app } = await testApp();
    const page = await app.inject('/api/docs/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect((await app.inject('/api/docs/js/scalar.js')).statusCode).toBe(200);
  });
});

describe('route schemas', () => {
  it('document routes without changing how they validate or serialise', async () => {
    const { app } = await testApp();
    app.post(
      '/api/echo',
      {
        schema: {
          body: z.object({ n: z.number() }),
          response: { 200: res('The echo', z.object({ n: z.number() })) },
        },
      },
      async (req) => ({ body: req.body, extra: true }),
    );
    const reply = await app.inject({ method: 'POST', url: '/api/echo', payload: { n: 'x' } });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ body: { n: 'x' }, extra: true });
  });
});

describe('md', () => {
  it('strips the common indentation and interpolates values in order', () => {
    const a = 'one';
    const b = 2;
    expect(md`
      First ${a}
        indented ${b}

      last`).toBe(['First one', '  indented 2', '', 'last'].join('\n'));
  });
});
