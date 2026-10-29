import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { testBridge } from './helpers.js';

async function document() {
  const app = await testBridge();
  const res = await app.inject('/docs/openapi.json');
  expect(res.statusCode).toBe(200);
  return {
    app,
    doc: res.json() as { openapi: string; paths: Record<string, Record<string, unknown>> },
  };
}

describe('bridge OpenAPI document', () => {
  it('is valid OpenAPI 3.1', async () => {
    const { doc } = await document();
    expect(doc.openapi).toBe('3.1.0');
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeTruthy();
  });

  it('documents every route but the docs', async () => {
    const { app, doc } = await document();
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    const registered = app
      .registeredRoutes()
      // The connections page is HTML for browsers, not part of the API.
      .filter(
        (r) =>
          !r.startsWith('GET /docs') && !r.startsWith('HEAD ') && !/^\w+ \/connections/.test(r),
      );
    expect(registered.sort()).toEqual(documented.sort());
  });

  it('documents a source read as binary bytes, not JSON', async () => {
    const { doc } = await document();
    const op = doc.paths['/v1/targets/{id}/sources:read']?.post as {
      responses: Record<string, { content?: Record<string, unknown> }>;
    };
    expect(Object.keys(op.responses['200']?.content ?? {})).toEqual(['application/octet-stream']);
    expect(op.responses['200']?.content?.['application/octet-stream']).toMatchObject({
      schema: { type: 'string', format: 'binary' },
    });
  });

  it('matches the committed openapi.json (npm run openapi -w @ih/bridge)', async () => {
    const { doc } = await document();
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot('../openapi.json');
  });
});
