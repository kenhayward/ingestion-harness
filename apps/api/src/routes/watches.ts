import { BrowseResultSchema, type ActingUser, type SinkView } from '@ih/bridge-contract';
import {
  sourceKeyProblem,
  StopBodySchema,
  WatchBrowseBodySchema,
  WatchCreateBodySchema,
  WatchDetailSchema,
  WatchPatchRequestSchema,
  WatchProblemsSchema,
  WatchSourceSchema,
  WatchTestBodySchema,
  WatchTestResultSchema,
  WatchViewSchema,
  watchSourcePath,
  type WatchRunAs,
  type WatchTestResult,
} from '@ih/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BridgeApiError } from '../bridge/client.js';
import { deleteHeld } from '../conversions/held.js';
import { ErrorBody, error, md, noContent, res } from '../openapi/zod.js';
import { SinkCatalog } from '../bridge/sinks.js';
import type { TargetRecord } from '../publish-targets/repo.js';

const TAG = 'Watched folders';
const ADMINS_ONLY = error('`admins only`.');
const NO_SUCH_WATCH = 'no such watch';
const NOT_FOUND = error(`\`${NO_SUCH_WATCH}\`.`);
const STOP_FIRST = 'stop the watch first';
const BRIDGE_DOWN = 'the delivery bridge could not be reached';
/** Without access control everyone is the admin; the bridge still needs an acting user. */
const LOCAL_ADMIN: ActingUser = { id: 'local', name: 'Local admin', email: null };
const IdParams = z.object({ id: z.string().describe('The watch id.') });
const UUID = z.string().uuid();

const CodedError = <C extends string>(description: string, ...codes: [C, ...C[]]) =>
  res(description, ErrorBody.extend({ code: z.enum(codes) }));

const base = (operationId: string, summary: string, description: string) => ({
  tags: [TAG],
  'x-admin': true,
  operationId,
  summary,
  description,
});

/** The sink's watched folders (contract version 4), as `watchedFoldersOf` reads a described sink. */
const watchedFoldersOf = (sink: SinkView) =>
  sink.contractVersion >= 4 ? (sink.capabilities.watchedFolders ?? null) : null;

type SourceField = NonNullable<ReturnType<typeof watchedFoldersOf>>['sourceFields'][number];

/** A target a watch may name: its sink has watched folders and takes decomposed documents. */
interface Watchable {
  target: TargetRecord;
  sink: SinkView;
  fields: SourceField[];
}

/**
 * Watched folders (docs/superpowers/specs/2026-10-29-watched-folders-design.md): an admin points
 * CT Studio at a folder of a sink, and the worker picks the documents in it up and converts them
 * in a batch the watch owns. Every route is admin-only (operators are refused by the allow-list,
 * which does not list them). The worker owns the pickups and the look schedule; these routes
 * read them through the watch view and change the settings and the state.
 */
export async function watchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  });

  const { watches, targets, bridge, store, buckets } = app.deps;
  const sinks = app.deps.sinks ?? new SinkCatalog();

  /** The signed-in admin as the bridge knows them (without access control: the local admin). */
  const adminOf = (req: FastifyRequest): ActingUser =>
    req.auth ? { id: req.auth.userId, name: req.auth.label, email: req.auth.email } : LOCAL_ADMIN;
  /** Who a watch delivers as (null parts without access control). */
  const runAsOf = (req: FastifyRequest): WatchRunAs =>
    req.auth
      ? { id: req.auth.userId, name: req.auth.label, email: req.auth.email }
      : { id: null, name: null, email: null };
  /** Whether another watch (not `except`) has this name, whatever the case. */
  const nameTaken = async (name: string, except?: string) =>
    (await watches.list()).some(
      (w) => w.id !== except && w.name.toLowerCase() === name.trim().toLowerCase(),
    );

  /** The target and its sink's source fields, or the reason it cannot be watched. */
  const watchable = async (
    targetId: string,
  ): Promise<({ ok: true } & Watchable) | { ok: false; code: string; error: string }> => {
    const target = await targets.get(targetId);
    if (!target)
      return { ok: false, code: 'unknown_target', error: `no publishing target ${targetId}` };
    await sinks.refresh(bridge);
    const sink = sinks.get(target.sinkId);
    const folders = sink ? watchedFoldersOf(sink) : null;
    if (!sink || !folders || !sink.capabilities.decomposedDocuments) {
      return {
        ok: false,
        code: 'target_not_watchable',
        error: `${target.label} has no watched folders, or takes no documents`,
      };
    }
    return { ok: true, target, sink, fields: folders.sourceFields };
  };

  /** Why `source` is not a folder of the sink, or null: only declared fields, every required one. */
  const sourceProblem = (w: Watchable, source: Record<string, string>): string | null => {
    const declared = new Set(w.fields.map((f) => f.id));
    const stray = Object.keys(source).find((k) => !declared.has(k));
    if (stray) return `${stray} is not a source field of ${w.sink.name}`;
    const missing = w.fields.find((f) => f.required && !(source[f.id] ?? '').trim());
    if (missing) return `${missing.label} is required`;
    // Each document's source key is the folder path and its file name (the worker's
    // `source_key`): a path that cannot make one is refused here, not file by file.
    const path = watchSourcePath(w.fields, source);
    if (!path) return 'the source fields name no folder';
    const keyProblem = sourceKeyProblem(`${path}/file.pdf`);
    return keyProblem ? `the folder cannot be watched: ${keyProblem}` : null;
  };

  /** Lists the folder's root as `user`: what a watch would read. */
  const listRoot = async (
    w: Watchable,
    source: Record<string, string>,
    user: ActingUser,
  ): Promise<WatchTestResult> => {
    try {
      const files = await bridge.sourceList(w.target.id, {
        source,
        folder: '',
        actingUser: user,
      });
      return { ok: true, files: files.length };
    } catch (err) {
      // A refusal a person can act on is the answer; an outage or an unauthorised call is not.
      if (err instanceof BridgeApiError && err.needsUser && err.error) {
        return { ok: false, problem: err.error.message };
      }
      throw err;
    }
  };

  const refuse = (reply: FastifyReply, failed: { code: string; error: string }) =>
    reply.code(422).send({ error: failed.error, code: failed.code });

  const known = async (id: string) => (UUID.safeParse(id).success ? watches.get(id) : null);

  app.get(
    '/watches',
    {
      schema: {
        ...base(
          'listWatches',
          'List the watched folders',
          md`
            **Admins only.** Every watch by name: its settings, state, health (running, draining,
            stopped, or a problem with its reason), the waiting files at the folder's root, the
            documents under way, and the delivered and failed counts of the last 24 hours and in
            all.
          `,
        ),
        response: {
          200: res('The watches.', z.array(WatchViewSchema)),
          403: ADMINS_ONLY,
        },
      },
    },
    async () => watches.list(),
  );

  app.get(
    '/watches/problems',
    {
      schema: {
        ...base(
          'countWatchProblems',
          'Count the watches with a problem',
          md`
            **Admins only.** How many running or draining watches have a problem (no
            connection, a folder that is gone), for the navigation badge.
          `,
        ),
        response: { 200: res('The count.', WatchProblemsSchema), 403: ADMINS_ONLY },
      },
    },
    async () => ({ count: await watches.problemCount() }),
  );

  app.get(
    '/watches/sources',
    {
      schema: {
        ...base(
          'listWatchSources',
          'List the targets a watch may name',
          md`
            **Admins only.** The publishing targets whose sink has watched folders and takes
            decomposed documents, by label, each with the source fields that make up a folder's
            path (in order), for the watch form.
          `,
        ),
        response: {
          200: res('The targets.', z.array(WatchSourceSchema)),
          403: ADMINS_ONLY,
        },
      },
    },
    async () => {
      const views = (await targets.list()).filter((v) => v.kind === 'sink');
      if (views.length) await sinks.refresh(bridge);
      const offered = views.flatMap((v) => {
        const sink = sinks.get(v.sinkId);
        const folders = sink ? watchedFoldersOf(sink) : null;
        return sink && folders && sink.capabilities.decomposedDocuments
          ? [
              {
                targetId: v.id,
                label: v.label,
                sinkId: v.sinkId,
                instanceId: v.instanceId,
                sourceFields: folders.sourceFields,
              },
            ]
          : [];
      });
      return offered.sort((a, b) => a.label.localeCompare(b.label));
    },
  );

  app.post(
    '/watches/browse',
    {
      schema: {
        ...base(
          'browseWatchSource',
          "Browse a sink's tree for a watched folder",
          md`
            **Admins only.** One level of the target's sink tree for a source field (a space, a
            folder), for the watch form's picker, acting as the signed-in admin (a personal sink
            uses their own connection). Nodes are paged by \`cursor\`.
          `,
        ),
        body: WatchBrowseBodySchema,
        response: {
          200: res('The nodes.', BrowseResultSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          422: CodedError(
            "The target cannot be watched, the field is not one of the sink's source fields, or the bridge's refusal.",
            'unknown_target',
            'target_not_watchable',
            'unknown_field',
            'bridge_refused',
          ),
          502: error(`\`${BRIDGE_DOWN}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = WatchBrowseBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const w = await watchable(body.data.targetId);
      if (!w.ok) return refuse(reply, w);
      if (!w.fields.some((f) => f.id === body.data.field)) {
        return refuse(reply, {
          code: 'unknown_field',
          error: `${body.data.field} is not a source field of ${w.sink.name}`,
        });
      }
      try {
        return await bridge.browse({
          sinkId: w.target.sinkId,
          instanceId: w.target.instanceId,
          connectionId: w.target.connectionId,
          field: body.data.field,
          scope: 'source',
          parentId: body.data.parentId,
          cursor: body.data.cursor,
          actingUser: adminOf(req),
        });
      } catch (err) {
        if (err instanceof BridgeApiError && err.needsUser && err.error) {
          return reply.code(422).send({ error: err.error.message, code: 'bridge_refused' });
        }
        return reply.code(502).send({ error: BRIDGE_DOWN });
      }
    },
  );

  app.post(
    '/watches/test',
    {
      schema: {
        ...base(
          'testWatchSource',
          "Test a watched folder's root",
          md`
            **Admins only.** Lists the folder's root as the signed-in admin, as a watch would,
            without saving anything: \`{ ok: true, files }\` with the number of files there, or
            \`{ ok: false, problem }\` with the bridge's reason (no connection, a folder that is
            gone).
          `,
        ),
        body: WatchTestBodySchema,
        response: {
          200: res('The outcome of the listing.', WatchTestResultSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          422: CodedError(
            'The target cannot be watched, or the source is not a folder of its sink.',
            'unknown_target',
            'target_not_watchable',
            'bad_source',
          ),
          502: error(`\`${BRIDGE_DOWN}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = WatchTestBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const w = await watchable(body.data.targetId);
      if (!w.ok) return refuse(reply, w);
      const problem = sourceProblem(w, body.data.source);
      if (problem) return refuse(reply, { code: 'bad_source', error: problem });
      try {
        return await listRoot(w, body.data.source, adminOf(req));
      } catch {
        return reply.code(502).send({ error: BRIDGE_DOWN });
      }
    },
  );

  app.post(
    '/watches',
    {
      schema: {
        ...base(
          'createWatch',
          'Start watching a folder',
          md`
            **Admins only.** Lists the folder's root first, as the signed-in admin (422
            \`source_test_failed\` with the reason when that fails), then saves the watch and
            starts it: it delivers as that admin until another admin takes it over. Names are
            unique whatever the case (409 \`name_taken\`). Left out: \`force\` off, \`autoApprove\`
            on, \`reasonFiles\` on, \`sleepSeconds\` 30, \`admit\` 10.
          `,
        ),
        body: WatchCreateBodySchema,
        response: {
          201: res('The watch, running.', WatchViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          409: CodedError('A watch has this name.', 'name_taken'),
          422: CodedError(
            'The target cannot be watched, the source is not a folder of its sink, or the folder could not be listed.',
            'unknown_target',
            'target_not_watchable',
            'bad_source',
            'source_test_failed',
          ),
          502: error(`\`${BRIDGE_DOWN}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = WatchCreateBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (await nameTaken(body.data.name)) {
        return reply
          .code(409)
          .send({ error: `a watch named ${body.data.name} exists`, code: 'name_taken' });
      }
      const w = await watchable(body.data.targetId);
      if (!w.ok) return refuse(reply, w);
      const problem = sourceProblem(w, body.data.source);
      if (problem) return refuse(reply, { code: 'bad_source', error: problem });
      let tested: WatchTestResult;
      try {
        tested = await listRoot(w, body.data.source, adminOf(req));
      } catch {
        return reply.code(502).send({ error: BRIDGE_DOWN });
      }
      if (!tested.ok) {
        return refuse(reply, { code: 'source_test_failed', error: tested.problem });
      }
      const runAs = runAsOf(req);
      const made = await watches.create(
        body.data,
        runAs,
        watchSourcePath(w.fields, body.data.source),
        runAs,
      );
      if (!made.ok) {
        return made.reason === 'name_taken'
          ? reply
              .code(409)
              .send({ error: `a watch named ${body.data.name} exists`, code: 'name_taken' })
          : refuse(reply, {
              code: 'unknown_target',
              error: `no publishing target ${body.data.targetId}`,
            });
      }
      return reply.code(201).send((await watches.start(made.watch.id)) ?? made.watch);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/watches/:id',
    {
      schema: {
        ...base(
          'getWatch',
          'Get a watched folder and its events',
          md`
            **Admins only.** The watch and its newest events (up to 100, newest first): what it
            picked up, moved, refused or could not do.
          `,
        ),
        params: IdParams,
        response: { 200: res('The watch.', WatchDetailSchema), 403: ADMINS_ONLY, 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const watch = await known(req.params.id);
      if (!watch) return reply.code(404).send({ error: NO_SUCH_WATCH });
      return { watch, events: await watches.events(watch.id, 100) };
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/watches/:id',
    {
      schema: {
        ...base(
          'updateWatch',
          'Change a watched folder',
          md`
            **Admins only.** Any setting left out is kept. The name, force-load, auto-approve,
            reason files, sleep and \`admit\` change at any time and apply to the next pickups.
            The target, the folder (\`source\`) and who the watch runs as change only while it is
            stopped (409 \`stop the watch first\`); \`runAsMe: true\` makes the signed-in admin
            the one it delivers as. Changing the target or the folder also makes the signed-in
            admin the one it delivers as, whatever \`runAsMe\` says, and lists the new folder's
            root as that admin first, as creating a watch does (422 \`source_test_failed\` with
            the reason, and nothing is saved), so no admin points another's connection at a
            folder they never chose.
          `,
        ),
        params: IdParams,
        body: WatchPatchRequestSchema,
        response: {
          200: res('The watch as now.', WatchViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: CodedError(
            'The watch is not stopped (`running`), or a watch has this name (`name_taken`).',
            'running',
            'name_taken',
          ),
          422: CodedError(
            'The target cannot be watched, the source is not a folder of its sink, or the new folder could not be listed.',
            'unknown_target',
            'target_not_watchable',
            'bad_source',
            'source_test_failed',
          ),
          502: error(`\`${BRIDGE_DOWN}\`.`),
        },
      },
    },
    async (req, reply) => {
      const watch = await known(req.params.id);
      if (!watch) return reply.code(404).send({ error: NO_SUCH_WATCH });
      const body = WatchPatchRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { runAsMe, ...settings } = body.data;
      if (settings.name !== undefined && (await nameTaken(settings.name, watch.id))) {
        return reply.code(409).send({ error: 'a watch has this name', code: 'name_taken' });
      }
      const moves = settings.targetId !== undefined || settings.source !== undefined;
      if ((moves || runAsMe) && watch.state !== 'stopped') {
        return reply.code(409).send({ error: STOP_FIRST, code: 'running' });
      }
      let sourcePath: string | undefined;
      if (moves) {
        const w = await watchable(settings.targetId ?? watch.targetId);
        if (!w.ok) return refuse(reply, w);
        const source = settings.source ?? watch.source;
        const problem = sourceProblem(w, source);
        if (problem) return refuse(reply, { code: 'bad_source', error: problem });
        sourcePath = watchSourcePath(w.fields, source);
        let tested: WatchTestResult;
        try {
          tested = await listRoot(w, source, adminOf(req));
        } catch {
          return reply.code(502).send({ error: BRIDGE_DOWN });
        }
        if (!tested.ok) {
          return refuse(reply, { code: 'source_test_failed', error: tested.problem });
        }
      }
      const done = await watches.update(watch.id, {
        settings,
        ...(runAsMe || moves ? { runAs: runAsOf(req) } : {}),
        ...(sourcePath !== undefined ? { sourcePath } : {}),
      });
      if (done.ok) return done.watch;
      switch (done.reason) {
        case 'missing':
          return reply.code(404).send({ error: NO_SUCH_WATCH });
        case 'name_taken':
          return reply.code(409).send({ error: 'a watch has this name', code: 'name_taken' });
        case 'unknown_target':
          return refuse(reply, { code: 'unknown_target', error: 'no such publishing target' });
        default:
          return reply.code(409).send({ error: STOP_FIRST, code: 'running' });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/watches/:id/stop',
    {
      schema: {
        ...base(
          'stopWatch',
          'Stop a watched folder',
          md`
            **Admins only.** Pickups end at once. \`mode: now\`: the watch is stopped, and its
            documents that have not reached the bridge (queued, converting, waiting for a lane
            or awaiting review) are cancelled: their jobs are cancelled, the documents fail with
            _Cancelled: the watch was stopped_ and count as failed, their held copies are
            deleted. Documents already being delivered finish on their own. Files stay wherever
            they are in the folder. A document whose job is already running only has the job
            cancelled: the worker fails it when it notices, or delivers it if it was past its
            last check, so a document the bridge accepted is never recorded as cancelled. Each
            document failed here is counted as failed in the watch's figures and its file is left
            in \`processing\`, never taken again; the others count when they finish.
            \`mode: drain\` (a running watch): nothing new is admitted,
            the admitted documents run to the end, and the watch shows _Draining_ until the last
            one finishes, then _Stopped_.
          `,
        ),
        params: IdParams,
        body: StopBodySchema,
        response: {
          200: res('The watch as now.', WatchViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('The watch is already stopped, or (drain) is not running.'),
        },
      },
    },
    async (req, reply) => {
      const watch = await known(req.params.id);
      if (!watch) return reply.code(404).send({ error: NO_SUCH_WATCH });
      const body = StopBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const done = await watches.stop(watch.id, body.data.mode);
      if (!done.ok) {
        if (done.reason === 'missing') return reply.code(404).send({ error: NO_SUCH_WATCH });
        return reply.code(409).send({
          error:
            body.data.mode === 'drain' && watch.state === 'draining'
              ? 'the watch is already draining'
              : body.data.mode === 'drain' && watch.state === 'stopped'
                ? 'the watch is stopped'
                : 'the watch is already stopped',
        });
      }
      // The cancel is committed: a held copy that cannot be deleted is logged, not refused.
      for (const c of done.cancelled) {
        try {
          await deleteHeld(store, buckets.runs, { id: c.itemId, batchId: c.batchId });
        } catch (err) {
          req.log.warn({ err, item: c.itemId }, 'a cancelled watched document kept its held files');
        }
      }
      return done.watch;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/watches/:id/start',
    {
      schema: {
        ...base(
          'startWatch',
          'Start a watched folder',
          md`
            **Admins only.** The watch runs again: its problem is cleared and it looks at the
            folder at once. Moves the sink refused (a pickup the worker gave up on after five)
            are tried again, so an admin who cleared the folder stops and starts the watch. Files left in the folder's \`processing\` subfolder by a Stop now are
            not taken again; the root is.
          `,
        ),
        params: IdParams,
        response: {
          200: res('The watch, running.', WatchViewSchema),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const watch = UUID.safeParse(req.params.id).success
        ? await watches.start(req.params.id)
        : null;
      return watch ?? reply.code(404).send({ error: NO_SUCH_WATCH });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/watches/:id',
    {
      schema: {
        ...base(
          'deleteWatch',
          'Remove a watched folder',
          md`
            **Admins only.** Only a stopped watch (409 \`stop the watch first\`). Its batch stays
            on the Conversion page as history; its counters and events go; nothing in the
            folder is touched. The target is free again.
          `,
        ),
        params: IdParams,
        response: {
          204: noContent('Removed.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`stop the watch first`.'),
        },
      },
    },
    async (req, reply) => {
      const result = UUID.safeParse(req.params.id).success
        ? await watches.remove(req.params.id)
        : 'missing';
      if (result === 'missing') return reply.code(404).send({ error: NO_SUCH_WATCH });
      if (result === 'not_stopped') return reply.code(409).send({ error: STOP_FIRST });
      return reply.code(204).send();
    },
  );
}
