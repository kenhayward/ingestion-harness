import swagger from '@fastify/swagger';
import { BlockSchema, InlineSchema, SectionSchema } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route as `METHOD /path/{param}`, in registration order. */
    registeredRoutes(): string[];
  }
}

export const DOCS_PREFIX = '/docs';

/**
 * The contract's recursive schemas (the decomposed document's tree), by name: a JSON Schema can
 * only express them by reference, so they live under `components.schemas`.
 */
const NAMED = z.registry<{ id: string }>();
NAMED.add(InlineSchema, { id: 'DecomposedInline' });
NAMED.add(BlockSchema, { id: 'DecomposedBlock' });
NAMED.add(SectionSchema, { id: 'DecomposedSection' });

/** The named schemas the routes refer to, collected as their JSON Schemas are made. */
const components: Record<string, unknown> = {};

const refsToComponents = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v).replaceAll('"#/definitions/', '"#/components/schemas/')) as T;

/** JSON Schema for a Zod schema (route `schema` blocks hold Zod; swagger wants JSON Schema). */
function toJsonSchema(schema: unknown): unknown {
  if (!(schema instanceof z.ZodType)) return schema;
  const json = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
    metadata: NAMED,
  }) as Record<string, unknown>;
  delete json.$schema;
  const { definitions, ...rest } = json;
  if (definitions) Object.assign(components, refsToComponents(definitions));
  return refsToComponents(rest);
}

type RouteSchema = Record<string, unknown> & { response?: Record<string, unknown> };

function transform({ schema, url }: { schema: RouteSchema | undefined; url: string }) {
  if (url.startsWith(DOCS_PREFIX)) return { schema: { ...(schema ?? {}), hide: true }, url };
  const out: RouteSchema = { ...(schema ?? {}) };
  for (const key of ['params', 'querystring', 'body', 'headers'] as const) {
    if (out[key] !== undefined) out[key] = toJsonSchema(out[key]);
  }
  if (out.response) {
    out.response = Object.fromEntries(
      Object.entries(out.response).map(([code, s]) => [code, toJsonSchema(s)]),
    );
  }
  return { schema: out, url };
}

const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'CT Studio delivery bridge',
    version: '1',
    description:
      'Producer API of the delivery bridge. Every /v1 request is signed (x-bridge-timestamp, x-bridge-nonce, x-bridge-signature: HMAC-SHA256 of the method, path, timestamp, nonce and body hash).',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Health', description: 'Liveness and readiness, unsigned.' },
    { name: 'Deliveries', description: 'Packages delivered to targets.' },
    { name: 'Catalog', description: 'Sinks and targets the bridge knows.' },
    {
      name: 'Connections',
      description: 'Shared connections, without their secrets (managed on the connections page).',
    },
    {
      name: 'Targets',
      description: 'Targets kept by the producer, their object operations and Test connection.',
    },
  ],
};

/** The bridge's OpenAPI document at /docs/openapi.json; registered before the routes. */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      // `::` is a literal colon (`objects:read`); `:id(regex)` a constrained parameter.
      const path = route.url
        .replace(/(?<!:):([A-Za-z0-9_]+)(\([^)]*\))?/g, '{$1}')
        .replaceAll('::', ':');
      routes.push(`${method} ${path}`);
    }
  });
  app.decorate('registeredRoutes', () => [...routes]);
  await app.register(swagger, { openapi: OPENAPI as never, transform: transform as never });
  app.get(`${DOCS_PREFIX}/openapi.json`, { schema: { hide: true } }, async () => {
    const doc = app.swagger() as { components?: { schemas?: Record<string, unknown> } };
    // Made while swagger transformed the routes, so read after it.
    const schemas = { ...doc.components?.schemas, ...components };
    return { ...doc, components: { ...doc.components, schemas } };
  });
}
