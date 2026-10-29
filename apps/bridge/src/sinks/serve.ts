import {
  bridgeError,
  BrowseRequestSchema,
  ConnectionTestRequestSchema,
  MemoryNonceStore,
  SinkDeliverRequestSchema,
  SOURCE_PATHS,
  SourceListRequestSchema,
  SourceMoveRequestSchema,
  SourcePutRequestSchema,
  SourceReadRequestSchema,
} from '@ih/bridge-contract';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { z } from 'zod';
import { registerGuard } from '../http/guard.js';
import { SinkError, type SinkPort } from './port.js';

/**
 * Serves a SinkPort over the sink contract's HTTP routes, signed with `key`: the reference for
 * what an external sink exposes (and, in tests, a sink to run the conformance suite against).
 */
export async function serveSink(
  sink: SinkPort,
  key: string,
  opts: { unsigned?: readonly string[]; logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const unsigned = new Set(opts.unsigned ?? []);
  registerGuard(app, {
    key,
    nonces: new MemoryNonceStore(),
    maxBodyBytes: 100 * 2 ** 20,
    signed: (path) => !unsigned.has(path),
  });

  const answer = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    try {
      const result = await run();
      if (result === undefined) return reply.code(204).send();
      if (Buffer.isBuffer(result)) {
        return reply.code(200).header('content-type', 'application/octet-stream').send(result);
      }
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof SinkError && err.error.code === 'not_found') {
        return reply.code(404).send(err.error);
      }
      if (err instanceof SinkError) {
        return reply.code(err.error.class === 'needs_user' ? 422 : 503).send(err.error);
      }
      return reply.code(500).send(bridgeError('internal', (err as Error).message));
    }
  };
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new SinkError(bridgeError('content_rejected', 'the request is not valid'));
    }
    return parsed.data;
  };

  app.get('/describe', (_req, reply) => answer(reply, () => sink.describe()));
  app.post('/connections::test', (req, reply) =>
    answer(reply, () => sink.testConnection(parse(ConnectionTestRequestSchema, req.body))),
  );
  app.post('/browse', (req, reply) =>
    answer(reply, () => sink.browse(parse(BrowseRequestSchema, req.body))),
  );
  app.post('/deliveries', (req, reply) =>
    answer(reply, () => sink.deliver(parse(SinkDeliverRequestSchema, req.body))),
  );
  app.get('/deliveries/:sinkJobId', (req, reply) =>
    answer(reply, () => sink.deliveryStatus((req.params as { sinkJobId: string }).sinkJobId)),
  );

  // Contract version 4: the watched folders, for a sink that has them. A Fastify route escapes
  // the colon of each path.
  const sources = sink.sources;
  if (sources) {
    const route = (path: string) => path.replace(':', '::');
    app.post(route(SOURCE_PATHS.list), (req, reply) =>
      answer(reply, async () => ({
        files: await sources.list(parse(SourceListRequestSchema, req.body)),
      })),
    );
    app.post(route(SOURCE_PATHS.read), (req, reply) =>
      answer(reply, () => sources.read(parse(SourceReadRequestSchema, req.body), Infinity)),
    );
    app.post(route(SOURCE_PATHS.move), (req, reply) =>
      answer(reply, async () => {
        await sources.move(parse(SourceMoveRequestSchema, req.body));
      }),
    );
    app.post(route(SOURCE_PATHS.put), (req, reply) =>
      answer(reply, async () => {
        await sources.put(parse(SourcePutRequestSchema, req.body));
      }),
    );
  }
  return app;
}
