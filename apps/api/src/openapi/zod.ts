import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Where the docs browser and the OpenAPI document are served. */
export const DOCS_PREFIX = '/api/docs';

/** JSON Schema for a Zod schema (route `schema` blocks may hold either). */
export function toJsonSchema(schema: unknown): unknown {
  if (!(schema instanceof z.ZodType)) return schema;
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
}

/** A documented response: swagger uses the schema's description as the response description. */
export const res = <T extends z.ZodTypeAny>(description: string, schema: T): T =>
  schema.describe(description);

/** A documented response without a body (204). */
export const noContent = (description: string) => ({ type: 'null', description }) as const;

/** The error body every route sends: a message, or Zod issues for some validation failures. */
export const ErrorBody = z.object({
  error: z.union([z.string(), z.array(z.object({}).passthrough())]),
});

export const error = (description: string) => res(description, ErrorBody);

/** Markdown in route files: strips the indentation common to every line, then trims. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = strings.reduce((out, s, i) => out + String(values[i - 1]) + s);
  const lines = text.replace(/^\n/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines
    .map((l) => l.slice(indent))
    .join('\n')
    .trim();
}

interface RouteSchema {
  params?: unknown;
  querystring?: unknown;
  body?: unknown;
  headers?: unknown;
  response?: Record<string, unknown>;
  security?: unknown;
  hide?: boolean;
  [key: string]: unknown;
}

const SIGN_IN_REQUIRED = {
  type: 'object',
  description: 'No valid session: sign in with `POST /api/auth/login`.',
  properties: { error: { type: 'string', const: 'sign in required' } },
  required: ['error'],
};

/**
 * `@fastify/swagger` transform: Zod → JSON Schema, plus what every route shares. Public routes
 * (and the health checks outside /api) need no session; the rest gain the 401 the access hook
 * sends. The docs browser's own routes stay out of the document.
 */
export function transform({
  schema,
  url,
  route,
}: {
  schema: RouteSchema | undefined;
  url: string;
  route: { config?: unknown };
}) {
  const out: RouteSchema = { ...(schema ?? {}) };
  if (url.startsWith(DOCS_PREFIX)) return { schema: { ...out, hide: true }, url };
  for (const key of ['params', 'querystring', 'body', 'headers'] as const) {
    if (out[key] !== undefined) out[key] = toJsonSchema(out[key]);
  }
  if (out.response) {
    out.response = Object.fromEntries(
      Object.entries(out.response).map(([code, s]) => [code, toJsonSchema(s)]),
    );
  }
  const isPublic = (route.config as { public?: boolean } | undefined)?.public === true;
  if (isPublic || !url.startsWith('/api/')) {
    out.security = [];
  } else if (out.response && !('401' in out.response)) {
    out.response = { ...out.response, 401: SIGN_IN_REQUIRED };
  }
  return { schema: out, url };
}
