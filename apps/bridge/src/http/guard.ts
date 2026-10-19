import { randomUUID } from 'node:crypto';
import { bridgeError, verifyRequest, type NonceStore } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';

const REQUEST_ID = 'x-request-id';

/** Request ids on every response (the caller's own, when it sends one). */
export function requestIds(): { genReqId: (req: { headers: Record<string, unknown> }) => string } {
  return {
    genReqId: (req) => {
      const given = req.headers[REQUEST_ID];
      return typeof given === 'string' && given.length > 0 && given.length <= 200
        ? given
        : randomUUID();
    },
  };
}

/**
 * Every `/v1/*` request must be signed by a producer holding `key` (HMAC over the exact body
 * bytes, so JSON bodies are read raw and parsed only after the signature checks out). Health and
 * the docs stay unsigned.
 */
export function registerGuard(
  app: FastifyInstance,
  opts: {
    key: string;
    nonces: NonceStore;
    maxBodyBytes: number;
    /** Which paths must be signed (default: everything under /v1). */
    signed?: (path: string) => boolean;
  },
): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: opts.maxBodyBytes },
    (_req, body, done) => done(null, body),
  );

  // A package over the limit is the document's problem, not the bridge's: a contract error the
  // producer sends to review instead of Fastify's own 413 body, which it would retry.
  app.setErrorHandler(async (err: { statusCode?: number }, _req, reply) => {
    if (err.statusCode !== 413) throw err;
    const mb = Math.round(opts.maxBodyBytes / 2 ** 20);
    return reply
      .code(413)
      .send(
        bridgeError('content_rejected', `the package is larger than this bridge takes (${mb} MB)`),
      );
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID, req.id);
  });

  app.addHook('preValidation', async (req, reply) => {
    // Signed over the URL exactly as sent; guarded by the route it matched (the router decodes
    // the path, so `/%761/...` reaches a `/v1/...` route and must be guarded like it).
    const path = req.url;
    const route = req.routeOptions.url ?? path;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mustSign = opts.signed ?? ((p: string) => p.startsWith('/v1/') || p === '/v1');
    if (mustSign(route)) {
      const verdict = verifyRequest(
        opts.key,
        { method: req.method, path, body: raw, headers: req.headers },
        opts.nonces,
      );
      if (!verdict.ok) {
        return reply.code(401).send(
          bridgeError('credential_rejected', 'request signature refused', {
            reason: verdict.reason,
          }),
        );
      }
    }
    if (Buffer.isBuffer(req.body)) {
      try {
        req.body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
      } catch {
        return reply.code(400).send(bridgeError('content_rejected', 'the body is not valid JSON'));
      }
    }
  });
}
