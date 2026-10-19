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
  opts: { key: string; nonces: NonceStore; maxBodyBytes: number },
): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: opts.maxBodyBytes },
    (_req, body, done) => done(null, body),
  );

  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID, req.id);
  });

  app.addHook('preValidation', async (req, reply) => {
    const path = req.url;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (path.startsWith('/v1/') || path === '/v1') {
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
