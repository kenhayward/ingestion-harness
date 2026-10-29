import {
  bridgeError,
  BridgeErrorSchema,
  ProducerSourceListSchema,
  ProducerSourceMoveSchema,
  ProducerSourcePutSchema,
  ProducerSourceReadSchema,
  RESOURCE_ID,
  SourceListAnswerSchema,
  watchedFoldersOf,
  type ActingUser,
  type SinkDescribe,
} from '@ih/bridge-contract';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SinkError, type SourcePort } from '../sinks/port.js';
import type { Target } from '../targets/repo.js';

const Params = z.strictObject({ id: z.string().regex(RESOURCE_ID) });

const refuse = (code: Parameters<typeof bridgeError>[0], message: string) =>
  new SinkError(bridgeError(code, message));

/**
 * The status of a sink's refusal: a missing file or folder is 404, a sink without watched
 * folders 405, an acting user without a connection 409; anything else a person must act on is
 * 422, and the rest (outages, timeouts) 503.
 */
const STATUS: Record<string, number> = {
  not_found: 404,
  target_missing: 404,
  unsupported_part: 405,
  connection_missing: 409,
};

function sendRefusal(reply: FastifyReply, err: SinkError): FastifyReply {
  const status = STATUS[err.error.code] ?? (err.error.class === 'needs_user' ? 422 : 503);
  return reply.code(status).send(err.error);
}

/** Checks the request's `source` against the sink's source fields; the first problem throws. */
function checkSource(source: Record<string, string>, d: SinkDescribe, sinkId: string): void {
  const fields = watchedFoldersOf(d)?.sourceFields ?? [];
  const declared = new Set(fields.map((f) => f.id));
  const undeclared = Object.keys(source).find((k) => !declared.has(k));
  if (undeclared) {
    throw refuse('content_rejected', `${undeclared} is not a source field of ${sinkId}`);
  }
  const missing = fields.find((f) => f.required && !source[f.id]);
  if (missing) throw refuse('content_rejected', `${missing.label} is required`);
}

/**
 * The target's sink with its watched folders, and the credential to call them with: the
 * target's shared connection, or, for a personal sink, the acting user's own connection to the
 * target's instance (never anyone else's).
 */
async function sourcesOf(
  app: FastifyInstance,
  target: Target,
  source: Record<string, string>,
  actingUser: ActingUser | null,
): Promise<{ sources: SourcePort; instanceId: string; credential: Record<string, string> }> {
  const sink = app.deps.sinks.get(target.sinkId);
  if (!sink) throw refuse('sink_unavailable', `sink ${target.sinkId} is not available`);
  const described = await sink.describe();
  if (!watchedFoldersOf(described) || !sink.sources) {
    throw refuse('unsupported_part', `${target.label} has no watched folders`);
  }
  checkSource(source, described, target.sinkId);
  let connectionId = target.connectionId;
  if (described.connectionKind === 'personal') {
    const own = actingUser
      ? await app.deps.connections.findPersonal(actingUser.id, target.sinkId, target.instanceId)
      : null;
    if (!own) {
      throw new SinkError(
        bridgeError(
          'connection_missing',
          actingUser
            ? `${actingUser.name} has no connection for ${target.label}: add one on the connections page`
            : `the watched folders of ${target.label} need a person to act as`,
          { targetId: target.id, ...(actingUser ? { userId: actingUser.id } : {}) },
        ),
      );
    }
    connectionId = own.id;
  }
  const credential = await app.deps.credentials.resolve(connectionId, described);
  return {
    sources: sink.sources,
    instanceId: target.instanceId ?? '',
    credential: credential ?? {},
  };
}

const ERRORS = {
  400: BridgeErrorSchema,
  404: BridgeErrorSchema,
  405: BridgeErrorSchema,
  409: BridgeErrorSchema,
  422: BridgeErrorSchema,
  503: BridgeErrorSchema,
};

const ABOUT =
  "Contract version 4: a watched folder of the target's sink instance, named by `source` (the " +
  "sink's source fields). The bridge adds the instance and the credential: the target's shared " +
  "connection, or for a personal sink the acting user's own (409 `connection_missing` without " +
  'one). A sink that does not declare watched folders is 405 `unsupported_part`; a missing ' +
  "folder is 404 `not_found` with `details.reason: 'folder_missing'`.";

/**
 * The watched folder operations of a target's sink, relayed: list, read, move and put. The
 * producer names the target; the bridge resolves its sink, instance and credential, checks the
 * sink's answer against the contract, and keeps nothing.
 */
export const sourceRoutes: FastifyPluginAsync = async (app) => {
  const tags = ['Targets'];

  /** Parses the params and the body, finds the target, and runs `fn` with its sink's folders. */
  const relay = async <T extends { source: Record<string, string>; actingUser: ActingUser | null }>(
    schema: z.ZodType<T>,
    req: { params: unknown; body: unknown },
    reply: FastifyReply,
    fn: (
      body: T,
      call: { sources: SourcePort; instanceId: string; credential: Record<string, string> },
    ) => Promise<unknown>,
  ) => {
    const params = Params.safeParse(req.params);
    const body = schema.safeParse(req.body);
    if (!params.success || !body.success) {
      const issues = [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ];
      return reply.code(400).send(
        bridgeError('content_rejected', 'the request is not valid', {
          issues: issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        }),
      );
    }
    const target = await app.deps.targets.get(params.data.id);
    if (!target) {
      return reply.code(404).send(bridgeError('target_missing', `no target ${params.data.id}`));
    }
    try {
      const call = await sourcesOf(app, target, body.data.source, body.data.actingUser);
      return await fn(body.data, call);
    } catch (err) {
      if (err instanceof SinkError) return sendRefusal(reply, err);
      throw err;
    }
  };

  app.post(
    '/v1/targets/:id/sources::list',
    {
      schema: {
        summary: 'List a watched folder of a target',
        description: `${ABOUT} Its files only, no subfolders.`,
        tags,
        params: Params,
        body: ProducerSourceListSchema,
        response: { 200: SourceListAnswerSchema, ...ERRORS },
      },
    },
    (req, reply) =>
      relay(ProducerSourceListSchema, req, reply, async (body, { sources, ...to }) => ({
        files: await sources.list({ ...to, ...body }),
      })),
  );

  app.post(
    '/v1/targets/:id/sources::read',
    {
      schema: {
        summary: 'Read a file of a watched folder',
        description:
          `${ABOUT} Answers the file's bytes as \`application/octet-stream\`. A file over ` +
          "`BRIDGE_MAX_SOURCE_MB` is 422 `content_rejected` with `details.reason: 'too_large'`, " +
          'refused as it streams.',
        tags,
        params: Params,
        body: ProducerSourceReadSchema,
        response: {
          200: z.string().describe('The file, as bytes (application/octet-stream).'),
          ...ERRORS,
        },
      },
    },
    (req, reply) =>
      relay(ProducerSourceReadSchema, req, reply, async (body, { sources, ...to }) => {
        const maxBytes = app.deps.config.BRIDGE_MAX_SOURCE_MB * 2 ** 20;
        const bytes = await sources.read({ ...to, ...body }, maxBytes);
        return reply.code(200).header('content-type', 'application/octet-stream').send(bytes);
      }),
  );

  app.post(
    '/v1/targets/:id/sources::move',
    {
      schema: {
        summary: 'Move a file between watched folders',
        description:
          `${ABOUT} Within one watched location, creating the destination folder as needed. ` +
          'Idempotent: a retried move whose source is gone and whose destination is there succeeds.',
        tags,
        params: Params,
        body: ProducerSourceMoveSchema,
        response: { 204: z.null(), ...ERRORS },
      },
    },
    (req, reply) =>
      relay(ProducerSourceMoveSchema, req, reply, async (body, { sources, ...to }) => {
        await sources.move({ ...to, ...body });
        return reply.code(204).send();
      }),
  );

  app.post(
    '/v1/targets/:id/sources::put',
    {
      schema: {
        summary: 'Write a small text file in a watched folder',
        description: `${ABOUT} UTF-8 text of at most 65,536 characters (a reason file).`,
        tags,
        params: Params,
        body: ProducerSourcePutSchema,
        response: { 204: z.null(), ...ERRORS },
      },
    },
    (req, reply) =>
      relay(ProducerSourcePutSchema, req, reply, async (body, { sources, ...to }) => {
        await sources.put({ ...to, ...body });
        return reply.code(204).send();
      }),
  );
};
