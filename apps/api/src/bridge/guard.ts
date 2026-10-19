import { verifyRequest, type NonceStore } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';

/**
 * Bridge-signed routes (`/api/bridge/handoff/redeem`, `/api/bridge/events`): the bridge signs
 * each request with the shared BRIDGE_CLIENT_KEY over the exact body bytes, so JSON bodies are
 * read raw here and parsed only once the signature checks out; a stale or replayed request is
 * refused. Call inside the plugin that holds those routes only (the parser and the hook are
 * scoped to it). The routes are `config.public`: no session is asked for.
 */
export function guardBridgeSigned(
  app: FastifyInstance,
  opts: { key: string; nonces: NonceStore; maxBodyBytes?: number },
): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: opts.maxBodyBytes ?? 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.addHook('preValidation', async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verdict = verifyRequest(
      opts.key,
      { method: req.method, path: req.url, body: raw, headers: req.headers },
      opts.nonces,
    );
    if (!verdict.ok) {
      req.log.warn({ reason: verdict.reason }, 'a bridge-signed request was refused');
      return reply.code(401).send({ error: 'bridge signature refused' });
    }
    try {
      req.body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      return reply.code(400).send({ error: 'the body is not valid JSON' });
    }
  });
}
