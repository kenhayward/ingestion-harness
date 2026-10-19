import {
  bridgeError,
  BridgeErrorSchema,
  ObjectDeleteRequestSchema,
  ObjectDeleteResultSchema,
  ObjectPutRequestSchema,
  ObjectReadResultSchema,
  ObjectRefSchema,
  RESOURCE_ID,
  TargetPutRequestSchema,
  TargetSettingsTestRequestSchema,
  TargetTestResultSchema,
  TargetViewSchema,
  type TargetTestResult,
} from '@ih/bridge-contract';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hasObjects, SinkError, type SinkPort, type TargetPlace } from '../sinks/port.js';
import type { Target } from '../targets/repo.js';
import { sendSinkError } from './deliveries.js';

const Params = z.strictObject({ id: z.string().regex(RESOURCE_ID) });

const refuse = (code: Parameters<typeof bridgeError>[0], message: string) =>
  new SinkError(bridgeError(code, message));

/** The body as `schema`, or a 400 already sent. */
function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  void reply.code(400).send(
    bridgeError('content_rejected', 'the request is not valid', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    }),
  );
  return null;
}

/** A target's sink and where it writes, with its connection resolved to a credential. */
async function placeOf(
  app: FastifyInstance,
  target: Pick<Target, 'sinkId' | 'connectionId' | 'destination'>,
): Promise<{ sink: SinkPort; place: TargetPlace }> {
  const sink = app.deps.sinks.get(target.sinkId);
  if (!sink) throw refuse('sink_unavailable', `sink ${target.sinkId} is not available`);
  const credential = await app.deps.credentials.resolve(target.connectionId, await sink.describe());
  return { sink, place: { credential, destination: target.destination } };
}

/** Checks a target's settings against its sink and connection; the first problem throws. */
async function checkTarget(
  app: FastifyInstance,
  t: z.infer<typeof TargetPutRequestSchema>,
): Promise<void> {
  const sink = app.deps.sinks.get(t.sinkId);
  if (!sink) throw refuse('content_rejected', `there is no sink ${t.sinkId}`);
  const described = await sink.describe();
  if (t.connectionId !== null) {
    const connection = await app.deps.connections.get(t.connectionId);
    if (!connection) throw refuse('connection_missing', `there is no connection ${t.connectionId}`);
    if (connection.sinkId !== t.sinkId) {
      throw refuse('content_rejected', `connection ${t.connectionId} is not for ${t.sinkId}`);
    }
  }
  const missing = described.destinationFields.find(
    (f) => f.required && f.kind === 'fixed' && !t.destination[f.id],
  );
  if (missing) throw refuse('content_rejected', `${missing.label} is required`);
}

export const targetRoutes: FastifyPluginAsync = async (app) => {
  const tags = ['Targets'];

  /** Runs `fn` against the target named in the URL, answering 404 or the sink's refusal. */
  const withTarget = async (
    id: string,
    reply: FastifyReply,
    fn: (target: Target) => Promise<unknown>,
  ) => {
    const target = await app.deps.targets.get(id);
    if (!target) return reply.code(404).send(bridgeError('not_found', `no target ${id}`));
    try {
      return await fn(target);
    } catch (err) {
      if (err instanceof SinkError) return sendSinkError(reply, err);
      throw err;
    }
  };

  /** The target's sink with object operations, when it has the capability; else a 405. */
  const objectsOf = async (target: Target, capability: 'readBack' | 'withdraw') => {
    const { sink, place } = await placeOf(app, target);
    if (!hasObjects(sink) || !(await sink.describe()).capabilities[capability]) {
      throw new SinkError(
        bridgeError('unsupported_part', `${target.label} has no object ${capability}`),
      );
    }
    return { sink, place };
  };

  const unsupported = (reply: FastifyReply, err: unknown) =>
    err instanceof SinkError && err.error.code === 'unsupported_part'
      ? reply.code(405).send(err.error)
      : null;

  app.put(
    '/v1/targets/:id',
    {
      schema: {
        summary: 'Create or replace a target',
        tags,
        params: Params,
        body: TargetPutRequestSchema,
        response: { 200: TargetViewSchema, 400: BridgeErrorSchema, 422: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const params = parse(Params, req.params, reply);
      const body = params && parse(TargetPutRequestSchema, req.body, reply);
      if (!params || !body) return reply;
      try {
        await checkTarget(app, body);
      } catch (err) {
        if (err instanceof SinkError) return sendSinkError(reply, err);
        throw err;
      }
      const target: Target = { id: params.id, ...body };
      await app.deps.targets.put(target);
      return target;
    },
  );

  app.delete(
    '/v1/targets/:id',
    {
      schema: {
        summary: 'Remove a target',
        description: 'Refused with 409 while any delivery names the target.',
        tags,
        params: Params,
        response: { 204: z.null(), 409: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const params = parse(Params, req.params, reply);
      if (!params) return reply;
      if (await app.deps.deliveries.usesTarget(params.id)) {
        return reply
          .code(409)
          .send(bridgeError('content_rejected', `deliveries name target ${params.id}`));
      }
      await app.deps.targets.remove(params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/targets/:id/objects::read',
    {
      schema: {
        summary: 'Read an object of a target',
        tags,
        params: Params,
        body: ObjectRefSchema,
        response: {
          200: ObjectReadResultSchema,
          404: BridgeErrorSchema,
          405: BridgeErrorSchema,
          422: BridgeErrorSchema,
          503: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const params = parse(Params, req.params, reply);
      const body = params && parse(ObjectRefSchema, req.body, reply);
      if (!params || !body) return reply;
      return withTarget(params.id, reply, async (target) => {
        try {
          const { sink, place } = await objectsOf(target, 'readBack');
          const content = await sink.readObject(place, body.bucket, body.key);
          if (!content) return reply.code(404).send(bridgeError('not_found', 'no such object'));
          return { content: content.toString('base64') };
        } catch (err) {
          return unsupported(reply, err) ?? Promise.reject(err);
        }
      });
    },
  );

  app.post(
    '/v1/targets/:id/objects::put',
    {
      schema: {
        summary: 'Write an object of a target',
        tags,
        params: Params,
        body: ObjectPutRequestSchema,
        response: {
          204: z.null(),
          404: BridgeErrorSchema,
          405: BridgeErrorSchema,
          422: BridgeErrorSchema,
          503: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const params = parse(Params, req.params, reply);
      const body = params && parse(ObjectPutRequestSchema, req.body, reply);
      if (!params || !body) return reply;
      return withTarget(params.id, reply, async (target) => {
        try {
          const { sink, place } = await objectsOf(target, 'withdraw');
          await sink.putObject(
            place,
            body.bucket,
            body.key,
            Buffer.from(body.content, 'base64'),
            body.contentType,
          );
          return reply.code(204).send();
        } catch (err) {
          return unsupported(reply, err) ?? Promise.reject(err);
        }
      });
    },
  );

  app.post(
    '/v1/targets/:id/objects::delete',
    {
      schema: {
        summary: 'Delete objects of a target',
        description: 'A missing object counts as deleted.',
        tags,
        params: Params,
        body: ObjectDeleteRequestSchema,
        response: {
          200: ObjectDeleteResultSchema,
          404: BridgeErrorSchema,
          405: BridgeErrorSchema,
          422: BridgeErrorSchema,
          503: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const params = parse(Params, req.params, reply);
      const body = params && parse(ObjectDeleteRequestSchema, req.body, reply);
      if (!params || !body) return reply;
      return withTarget(params.id, reply, async (target) => {
        try {
          const { sink, place } = await objectsOf(target, 'withdraw');
          for (const o of body.objects) await sink.deleteObject(place, o.bucket, o.key);
          return { deleted: body.objects.length };
        } catch (err) {
          return unsupported(reply, err) ?? Promise.reject(err);
        }
      });
    },
  );

  /** The probe for a target's settings; a connection problem is a failed connect step. */
  const test = async (
    target: Pick<Target, 'sinkId' | 'connectionId' | 'destination'>,
  ): Promise<TargetTestResult> => {
    try {
      const { sink, place } = await placeOf(app, target);
      if (hasObjects(sink)) return await sink.probeTarget(place);
      const identity = await sink.testConnection({
        instanceId: '',
        credential: place.credential ?? {},
      });
      return { ok: true, step: null, message: `Connected as ${identity.identity}` };
    } catch (err) {
      if (err instanceof SinkError) return { ok: false, step: 'connect', message: err.message };
      throw err;
    }
  };

  app.post(
    '/v1/targets/:id([a-z0-9_-]+)::test',
    {
      schema: {
        summary: 'Test a saved target',
        tags,
        params: Params,
        response: { 200: TargetTestResultSchema, 404: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const params = parse(Params, req.params, reply);
      if (!params) return reply;
      return withTarget(params.id, reply, (target) => test(target));
    },
  );

  app.post(
    '/v1/targets::test',
    {
      schema: {
        summary: 'Test target settings before saving them',
        tags,
        body: TargetSettingsTestRequestSchema,
        response: { 200: TargetTestResultSchema, 400: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const body = parse(TargetSettingsTestRequestSchema, req.body, reply);
      if (!body) return reply;
      const connection = await app.deps.connections.get(body.connectionId);
      if (!connection) {
        return {
          ok: false,
          step: 'connect',
          message: `there is no connection ${body.connectionId}`,
        };
      }
      return test({ sinkId: connection.sinkId, ...body });
    },
  );
};
