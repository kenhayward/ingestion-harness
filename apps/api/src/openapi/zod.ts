import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { OPERATOR_REFUSED, operatorMayCall } from '@ih/shared';

/** Where the docs browser and the OpenAPI document are served. */
export const DOCS_PREFIX = '/api/docs';

/** JSON Schema for a Zod schema (route `schema` blocks may hold either). */
export function toJsonSchema(schema: unknown): unknown {
  if (!(schema instanceof z.ZodType)) return schema;
  // Extra properties are refused only by .strict() schemas: handlers strip them otherwise, and
  // responses are never trimmed to their schema.
  // OpenAPI 3.1 schemas are JSON Schema: nullable is `null` in a union, not `nullable: true`.
  const json: Record<string, unknown> = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    removeAdditionalStrategy: 'strict',
  });
  delete json.$schema;
  return json;
}

/** A documented response: swagger uses the schema's description as the response description. */
export const res = <T extends z.ZodTypeAny>(description: string, schema: T): T =>
  schema.describe(description);

/** A documented response without a body (204). */
export const noContent = (description: string) => ({ type: 'null', description }) as const;

/** A documented redirect (302): a browser navigation's answer, with no body. */
export const redirect = (description: string) => ({ type: 'null', description }) as const;

/** A documented download: the body is a file of one of these content types. */
export const binary = (description: string, ...contentTypes: string[]) => ({
  description,
  content: Object.fromEntries(
    contentTypes.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
  ),
});

/**
 * A `multipart/form-data` body (use with `consumes: ['multipart/form-data']`): text fields, then
 * the `file` part. Uploads read fields as they stream in, so fields must come before the file.
 */
export function multipart(
  fields: Record<string, { type: 'string'; description: string; enum?: string[] }>,
  required: string[],
  fileDescription = 'The PDF. Send it last.',
) {
  return {
    type: 'object',
    properties: {
      ...fields,
      file: { type: 'string', format: 'binary', description: fileDescription },
    },
    required: [...required, 'file'],
  };
}

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

const CROSS_SITE_REFUSED = {
  type: 'object',
  description: "Sent from another site's page (`Sec-Fetch-Site: cross-site`): refused.",
  properties: { error: { type: 'string', const: 'cross-site request refused' } },
  required: ['error'],
};

const CHANGE_PASSWORD_FIRST = {
  type: 'object',
  description: 'A one-time password session: change the password first (`PUT /api/auth/password`).',
  properties: { error: { type: 'string', const: 'change your one-time password first' } },
  required: ['error'],
};

const OPERATORS_REFUSED = {
  type: 'object',
  description:
    'An operator (Home, Jobs and Results only): this route is for designers and administrators.',
  properties: { error: { type: 'string', const: OPERATOR_REFUSED } },
  required: ['error'],
};

const UNDER_MAINTENANCE = {
  type: 'object',
  description:
    'Maintenance mode is on (`GET /api/maintenance`): only admins can use the API until it is off.',
  properties: {
    error: { type: 'string', const: 'CT Studio is under maintenance' },
    maintenance: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        message: { type: 'string' },
        since: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['enabled', 'message', 'since'],
    },
  },
  required: ['error', 'maintenance'],
};

/** What a session opened with a one-time password may still call (ADR 0013). */
const WHILE_CHANGING = ['GET /api/auth/me', 'PUT /api/auth/password'];

/** A route's own 403, or also the access hook's refusals. */
function with403(existing: unknown, ...hook: { description: string }[]) {
  const all = existing === undefined ? hook : [existing, ...hook];
  if (all.length === 1) return all[0];
  return {
    description: all.map((s) => (s as { description?: string }).description ?? '').join(' Or: '),
    anyOf: all,
  };
}

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * `@fastify/swagger` transform: Zod → JSON Schema, plus what every route shares. Public routes
 * (and the health checks outside /api) need no session; the rest gain the 401 the access hook
 * sends, its 403s for a one-time password session and for operators, and its 503 during
 * maintenance. Every /api route that changes something
 * gains its cross-site 403.
 */
export function transform({
  schema,
  url,
  route,
}: {
  schema: RouteSchema | undefined;
  url: string;
  route: { config?: unknown; method?: string | string[] };
}) {
  const out: RouteSchema = { ...(schema ?? {}) };
  // The docs browser's own routes, and routes not documented yet (no tags), stay out.
  if (url.startsWith(DOCS_PREFIX) || !schema?.tags) return { schema: { ...out, hide: true }, url };
  for (const key of ['params', 'querystring', 'body', 'headers'] as const) {
    if (out[key] !== undefined) out[key] = toJsonSchema(out[key]);
  }
  if (out.response) {
    out.response = Object.fromEntries(
      Object.entries(out.response).map(([code, s]) => [code, toJsonSchema(s)]),
    );
  }
  const isPublic = (route.config as { public?: boolean } | undefined)?.public === true;
  const guarded = !isPublic && url.startsWith('/api/');
  if (!guarded) {
    out.security = [];
  } else if (out.response && !('401' in out.response)) {
    out.response = { ...out.response, 401: SIGN_IN_REQUIRED };
  }
  const methods = [route.method ?? []].flat();
  const hook403 = [
    ...(guarded && !methods.some((m) => WHILE_CHANGING.includes(`${m} ${url}`))
      ? [CHANGE_PASSWORD_FIRST]
      : []),
    ...(guarded && !methods.some((m) => operatorMayCall(m, url)) ? [OPERATORS_REFUSED] : []),
    ...(url.startsWith('/api/') && methods.some((m) => UNSAFE_METHODS.includes(m))
      ? [CROSS_SITE_REFUSED]
      : []),
  ];
  if (out.response && hook403.length) {
    out.response = { ...out.response, 403: with403(out.response['403'], ...hook403) };
  }
  if (out.response && guarded) {
    out.response = { ...out.response, 503: with403(out.response['503'], UNDER_MAINTENANCE) };
  }
  return { schema: out, url };
}
