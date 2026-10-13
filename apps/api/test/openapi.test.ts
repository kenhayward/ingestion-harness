import SwaggerParser from '@apidevtools/swagger-parser';
import type { FastifyReply } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TAGS } from '../src/openapi/document.js';
import { binary, error, md, multipart, res, toJsonSchema } from '../src/openapi/zod.js';
import { accessApp, registeredRoutes, testApp } from './helpers.js';
import { takeViolations } from './openapi-conformance.js';

type Doc = OpenAPIV3_1.Document & { 'x-tagGroups': { name: string; tags: string[] }[] };

/** The document of an app with token access on, so the auth routes are in it. */
async function openapi(): Promise<Doc> {
  const { app } = await accessApp();
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

describe('schema helpers', () => {
  it('forbid extra properties only where the Zod schema is strict', () => {
    const schema = toJsonSchema(
      z.object({ strict: z.object({ a: z.string() }).strict(), plain: z.object({}) }),
    ) as { additionalProperties: unknown; properties: Record<string, object> };
    expect(schema.additionalProperties).not.toBe(false);
    expect(schema.properties.strict).toMatchObject({ additionalProperties: false });
    expect(schema.properties.plain).not.toMatchObject({ additionalProperties: false });
  });

  it('write nullable values the OpenAPI 3.1 way', () => {
    const schema = toJsonSchema(z.enum(['a', 'b']).nullable());
    expect(schema).toEqual({ anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] });
  });

  it('document binary downloads and multipart uploads', async () => {
    const { app } = await testApp();
    app.post(
      '/api/helpers',
      {
        schema: {
          tags: ['Health'],
          consumes: ['multipart/form-data'],
          body: multipart({ name: { type: 'string', description: 'A name.' } }, ['name']),
          response: { 200: binary('A PDF.', 'application/pdf') },
        },
      },
      async () => 'x',
    );
    const doc = (await app.inject('/api/docs/openapi.json')).json<Doc>();
    const op = doc.paths?.['/api/helpers']?.post as OpenAPIV3_1.OperationObject;
    const body = op.requestBody as OpenAPIV3_1.RequestBodyObject;
    expect(body.content['multipart/form-data']?.schema).toMatchObject({
      type: 'object',
      required: ['name', 'file'],
      properties: { file: { type: 'string', format: 'binary' } },
    });
    expect(op.responses?.['200']).toEqual({
      description: 'A PDF.',
      content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
    });
  });
});

describe('route schemas', () => {
  it("leave Fastify's own error bodies as they are", async () => {
    const { app } = await testApp();
    const tooLarge = () => Object.assign(new Error('request file too large'), { statusCode: 413 });
    app.get('/api/plain', async () => {
      throw tooLarge();
    });
    app.get(
      '/api/documented',
      { schema: { tags: ['Health'], response: { 413: error('Too large.') } } },
      async () => {
        throw tooLarge();
      },
    );
    const plain = await app.inject('/api/plain');
    const documented = await app.inject('/api/documented');
    expect(plain.json()).toMatchObject({ statusCode: 413, error: 'Payload Too Large' });
    expect(documented.statusCode).toBe(413);
    expect(documented.body).toBe(plain.body);
  });

  it('document routes without changing how they validate or serialise', async () => {
    const { app } = await testApp();
    app.post(
      '/api/echo',
      {
        schema: {
          tags: ['Health'],
          body: z.object({ n: z.number() }),
          response: { 200: res('The echo', z.object({ n: z.number() })) },
        },
      },
      async (req) => ({ body: req.body, extra: true }),
    );
    const reply = await app.inject({ method: 'POST', url: '/api/echo', payload: { n: 'x' } });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ body: { n: 'x' }, extra: true });
    // The response does not match its docs, which the conformance check reports.
    expect(takeViolations()).toHaveLength(1);
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

/**
 * Routes not documented yet (docs/design/api-docs.md, rollout). This list only shrinks: an
 * entry that is documented, or no longer exists, fails the sweep. The last rollout PR deletes it.
 */
const UNDOCUMENTED = new Set([
  'DELETE /api/access/s3-keys/{id}',
  'DELETE /api/templates/{id}/references/{ref}',
  'DELETE /api/templates/{id}/versions/{version}',
  'DELETE /api/workbench/projects/{id}',
  'DELETE /api/workbench/projects/{id}/feedback/{fid}',
  'DELETE /api/workbench/projects/{id}/samples/{sid}',
  'GET /api/access/s3-keys',
  'GET /api/specs',
  'GET /api/specs/{id}',
  'GET /api/templates',
  'GET /api/templates/{id}/diff',
  'GET /api/templates/{id}/metrics',
  'GET /api/templates/{id}/references',
  'GET /api/templates/{id}/versions/{version}',
  'GET /api/templates/{id}/versions/{version}/export',
  'GET /api/templates/{id}/versions/{version}/regression',
  'GET /api/workbench/projects',
  'GET /api/workbench/projects/{id}',
  'GET /api/workbench/projects/{id}/comparisons/{groupId}',
  'GET /api/workbench/projects/{id}/exports',
  'GET /api/workbench/projects/{id}/exports/{jobId}/bundle',
  'GET /api/workbench/projects/{id}/feedback',
  'GET /api/workbench/projects/{id}/iterations',
  'GET /api/workbench/projects/{id}/iterations/{iid}',
  'GET /api/workbench/projects/{id}/proposals',
  'GET /api/workbench/projects/{id}/publications',
  'GET /api/workbench/projects/{id}/publish-gate',
  'GET /api/workbench/projects/{id}/references',
  'GET /api/workbench/projects/{id}/samples',
  'GET /api/workbench/projects/{id}/samples/{sid}/text',
  'GET /api/workbench/projects/{id}/segmentations/{jobId}',
  'GET /api/workbench/projects/{id}/stages',
  'GET /api/workbench/projects/{id}/test-runs',
  'PATCH /api/workbench/projects/{id}',
  'PATCH /api/workbench/projects/{id}/samples/{sid}',
  'POST /api/access/s3-keys',
  'POST /api/access/s3-keys/keys/{keyId}/revoke',
  'POST /api/access/s3-keys/{id}/rotate',
  'POST /api/templates',
  'POST /api/templates/import',
  'POST /api/templates/{id}/drafts',
  'POST /api/templates/{id}/references',
  'POST /api/templates/{id}/versions/{version}/publish',
  'POST /api/templates/{id}/versions/{version}/regression',
  'POST /api/workbench/projects',
  'POST /api/workbench/projects/import',
  'POST /api/workbench/projects/{id}/evaluations',
  'POST /api/workbench/projects/{id}/evaluations/compare',
  'POST /api/workbench/projects/{id}/export',
  'POST /api/workbench/projects/{id}/feedback',
  'POST /api/workbench/projects/{id}/holdout/reference-runs',
  'POST /api/workbench/projects/{id}/iterations/{iid}/restore',
  'POST /api/workbench/projects/{id}/proposals/{pid}/decision',
  'POST /api/workbench/projects/{id}/publish',
  'POST /api/workbench/projects/{id}/samples',
  'POST /api/workbench/projects/{id}/segmentations',
  'POST /api/workbench/projects/{id}/stages/{stage}',
  'POST /api/workbench/projects/{id}/stages/{stage}/skip',
  'POST /api/workbench/projects/{id}/test-runs',
  'PUT /api/templates/{id}/versions/{version}',
  'PUT /api/workbench/projects/{id}/brief',
  'PUT /api/workbench/projects/{id}/data-policy',
]);

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
type Operation = OpenAPIV3_1.OperationObject & { 'x-admin'?: boolean };

function operations(doc: Doc) {
  return Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const op = item?.[method] as Operation | undefined;
      return op ? [{ key: `${method.toUpperCase()} ${path}`, path, method, op }] : [];
    }),
  );
}

describe('docs sweep', () => {
  it('documents every route not on the undocumented list', async () => {
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const { key, op } of operations(await openapi())) {
      if (UNDOCUMENTED.has(key)) continue;
      const missing = [
        !op.tags?.length && 'tags',
        op.tags?.some((t) => !(t in TAGS)) && 'known tags',
        !(op.summary && op.summary.length <= 60) && 'summary (1-60 chars)',
        !(op.description && op.description.length >= 80) && 'description (80+ chars)',
        !op.operationId && 'operationId',
        !Object.keys(op.responses ?? {}).some((c) => c.startsWith('2')) && '2xx response',
        op.operationId && ids.has(op.operationId) && 'unique operationId',
      ].filter(Boolean);
      if (missing.length) problems.push(`${key}: ${missing.join(', ')}`);
      if (op.operationId) ids.add(op.operationId);
    }
    expect(problems).toEqual([]);
  });

  it('lists only routes that exist and are still undocumented', async () => {
    const { app } = await accessApp();
    const doc = (await app.inject('/api/docs/openapi.json')).json<Doc>();
    const documented = new Set(operations(doc).map(({ key }) => key));
    const undocumented = registeredRoutes(app.printRoutes({ commonPrefix: false }))
      .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method) && !r.path.startsWith('/api/docs'))
      .map((r) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, '{$1}')}`)
      .filter((key) => !documented.has(key));
    expect([...UNDOCUMENTED].sort()).toEqual(undocumented.sort());
  });

  it('leaves routes out of the document until they are documented', async () => {
    const untagged = operations(await openapi()).filter(({ op }) => !op.tags?.length);
    expect(untagged.map(({ key }) => key)).toEqual([]);
  });

  it('marks exactly the admin-only routes with x-admin', async () => {
    const { app, userCookie } = await accessApp();
    const doc = (await app.inject('/api/docs/openapi.json')).json<Doc>();
    const wrong: string[] = [];
    for (const { key, path, method, op } of operations(doc)) {
      // Public routes are never admin-only (and logout would end the user's session).
      const isPublic = op.security?.length === 0;
      if (UNDOCUMENTED.has(key) || !path.startsWith('/api/') || isPublic) continue;
      const reply = await app.inject({
        method: method.toUpperCase() as 'GET',
        url: path.replace(/\{[A-Za-z]+\}/g, '00000000-0000-4000-8000-000000000000'),
        headers: { cookie: userCookie },
      });
      const adminOnly = reply.statusCode === 403 && reply.json().error === 'admins only';
      if (adminOnly !== (op['x-admin'] === true))
        wrong.push(`${key}: x-admin should be ${adminOnly}`);
    }
    expect(wrong).toEqual([]);
  });

  it('matches the committed docs/openapi.json (npm run openapi updates it)', async () => {
    const doc = await openapi();
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot(
      '../../../docs/openapi.json',
    );
  });
});

describe('response conformance', () => {
  async function conformanceApp() {
    const { app } = await testApp();
    app.get(
      '/api/conformance/:mode',
      {
        schema: {
          tags: ['Health'],
          response: { 200: res('A thing', z.object({ id: z.string() })) },
        },
      },
      async (req, reply) => {
        const { mode } = req.params as { mode: string };
        if (mode === 'teapot') return (reply as FastifyReply).code(418).send({ error: 'teapot' });
        return mode === 'bad' ? { nope: 1 } : { id: 'x' };
      },
    );
    return app;
  }

  it('flags an undocumented status code', async () => {
    const app = await conformanceApp();
    await app.inject('/api/conformance/teapot');
    expect(takeViolations()).toEqual(['GET /api/conformance/:mode -> 418: status not documented']);
  });

  it('flags a body that does not match its schema', async () => {
    const app = await conformanceApp();
    await app.inject('/api/conformance/bad');
    expect(takeViolations()).toEqual([
      "GET /api/conformance/:mode -> 200: data must have required property 'id'",
    ]);
  });

  it('accepts a body that matches', async () => {
    const app = await conformanceApp();
    expect((await app.inject('/api/conformance/ok')).statusCode).toBe(200);
    expect(takeViolations()).toEqual([]);
  });
});
