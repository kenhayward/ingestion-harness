import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { OPENAPI } from './document.js';
import { DOCS_PREFIX, transform } from './zod.js';

declare module 'fastify' {
  interface FastifySchema {
    /** Admins only (docs only; the route's own check enforces it). */
    'x-admin'?: boolean;
  }
  interface FastifyContextConfig {
    /** Served without a session (the access hook reads this on the matched route). */
    public?: boolean;
  }
}

/** Scalar in the app's colours (apps/web/src/styles/tokens.css). */
const CSS = `
:root {
  --scalar-font: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  --scalar-font-code: 'IBM Plex Mono', Consolas, ui-monospace, monospace;
}
.light-mode {
  --scalar-background-1: #ffffff; --scalar-background-2: #f3f5f8; --scalar-background-3: #e9edf2;
  --scalar-border-color: #dce2ea; --scalar-color-1: #0f1b2d; --scalar-color-2: #4f5d70;
  --scalar-color-3: #6b7889; --scalar-color-accent: #0a5bb0;
}
.dark-mode {
  --scalar-background-1: #121a25; --scalar-background-2: #0b1119; --scalar-background-3: #1a2431;
  --scalar-border-color: #243041; --scalar-color-1: #e5ebf2; --scalar-color-2: #9dabbd;
  --scalar-color-3: #7d8b9d; --scalar-color-accent: #5ea3ee;
}`;

/**
 * Fastify's own errors (413, 406, …) reach the serializer as Error objects whose fields are not
 * enumerable: give them the body Fastify sends when a route has no schema.
 */
function errorBody(err: Error) {
  const { statusCode, code, error } = err as Error & Record<string, unknown>;
  return { statusCode, code, error, message: err.message };
}

/**
 * The OpenAPI document and the docs browser (docs/design/api-docs.md). Route `schema` blocks are
 * documentation only: handlers validate with Zod themselves, so the compilers pass requests
 * through untouched and serialise responses with JSON.stringify (a schema never drops a field).
 * Registered before the routes, since swagger collects them as they are added.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  app.setValidatorCompiler(() => (value) => ({ value }));
  app.setSerializerCompiler(
    () => (data) => JSON.stringify(data instanceof Error ? errorBody(data) : data),
  );
  await app.register(swagger, { openapi: OPENAPI as never, transform: transform as never });
  await app.register(async (docs) => {
    // Every route the docs browser adds (page, script, document) is public.
    docs.addHook('onRoute', (route) => {
      route.config = { ...route.config, public: true };
    });
    await docs.register(scalar, {
      routePrefix: DOCS_PREFIX,
      logLevel: 'silent',
      configuration: {
        pageTitle: 'Content Transformation Studio API',
        theme: 'none',
        customCss: CSS,
        // Self-contained: no fonts from Scalar's CDN, no telemetry, none of the hosted extras.
        withDefaultFonts: false,
        telemetry: false,
        showDeveloperTools: 'never',
        agent: { disabled: true },
        mcp: { disabled: true },
      },
    });
  });
}
