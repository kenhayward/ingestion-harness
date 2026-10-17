import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BACKUP_PART_BYTES,
  BackupViewSchema,
  QueueControlBodySchema,
  QueueControlViewSchema,
  RestoreConfirmBodySchema,
  RestoreStartBodySchema,
  RestoreStatusSchema,
  UploadStartBodySchema,
  UploadViewSchema,
} from '@ih/shared';
import { adminOf } from '../access/routes.js';
import { parseMasterKey } from '../backup/crypto.js';
import {
  BackupBusyError,
  BUSY,
  NOT_WAITING,
  RESTORE_CANCELLED,
  RestoreRefusal,
  type BackupService,
} from '../backup/service.js';
import { UploadError, type BackupUploads } from '../backup/uploads.js';
import { binary, error, md, noContent, res } from '../openapi/zod.js';

const ADMINS_ONLY = error('`admins only`.');
export const NOT_CONFIGURED = 'backups need LLM_SECRETS_KEY: set it in deploy/.env';
const UNAVAILABLE = error(`\`${NOT_CONFIGURED}\`: the key every backup is encrypted with.`);

const BackupStatusSchema = z.object({
  backup: BackupViewSchema.nullable().describe(
    'The running backup, else the newest one (a failed one shows its reason).',
  ),
  lastSucceeded: BackupViewSchema.nullable().describe(
    'The newest successful backup, the one that can be downloaded (may be `backup` itself).',
  ),
  restore: RestoreStatusSchema.nullable(),
  queue: QueueControlViewSchema,
});

const IdParams = z.object({ id: z.string().uuid().describe('The backup id.') });
const UploadParams = z.object({ id: z.string().uuid().describe('The upload id.') });
const RestoreParams = z.object({ id: z.string().uuid().describe('The restore id.') });
const TokenHeaders = z.object({
  'x-restore-token': z
    .string()
    .optional()
    .describe("The restore's token, when not signed in as an admin."),
});
/** The 409 for a restore of an upload whose parts were not joined yet. */
const NOT_COMPLETE = 'the upload is not complete';
const PartParams = UploadParams.extend({
  n: z.coerce.number().int().min(0).describe('The part, counting from 0.'),
});

/** A little over one part (64 MiB); the exact size is checked against the part's number. */
const PART_BODY_LIMIT = 65 * 1024 * 1024;

/** Backup and restore (docs/superpowers/specs/2026-10-17-backup-and-restore-design.md). */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
    if (!app.deps.backup) return reply.code(503).send({ error: NOT_CONFIGURED });
  };
  const service = (): BackupService => app.deps.backup!;
  const uploadsOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
    if (!app.deps.backupUploads) return reply.code(503).send({ error: NOT_CONFIGURED });
  };
  const uploads = (): BackupUploads => app.deps.backupUploads!;
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof UploadError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  // A part is raw bytes handed on as a stream, never buffered here (this plugin only).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  app.get(
    '/backup',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'getBackupStatus',
        summary: 'The latest backup, the restore and the job queue',
        description: md`
          **Admins only.** The running backup with its progress, else the newest one (when, who,
          size; a failed one with its reason), the newest successful one (kept after a failed
          backup, and the one to download), the restore holding the lock, else the newest one,
          and whether the job queue is paused.
        `,
        'x-admin': true,
        response: {
          200: res('Backup status.', BackupStatusSchema),
          403: ADMINS_ONLY,
          503: UNAVAILABLE,
        },
      },
    },
    async () => service().status(),
  );

  app.post(
    '/backup/backups',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'startBackup',
        summary: 'Create a backup',
        description: md`
          **Admins only.** Starts an encrypted backup of the whole stack in the background: the
          database, every object of CT Studio's buckets and of internal publishing targets'
          buckets, and the triple store when there is one. Jobs keep running. Poll
          \`GET /api/backup\` for progress. Once it succeeds the previous backup is deleted; a
          failed one leaves the previous one in place. One backup or restore at a time.
        `,
        'x-admin': true,
        response: {
          202: res('The backup, started.', BackupViewSchema),
          403: ADMINS_ONLY,
          409: error(`\`${BUSY}\`.`),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      try {
        const view = service().startBackup(req.auth?.label ?? 'admin');
        req.log.warn({ id: view.id, by: view.createdBy }, 'backup started');
        return reply.code(202).send(view);
      } catch (err) {
        if (err instanceof BackupBusyError) return reply.code(409).send({ error: BUSY });
        throw err;
      }
    },
  );

  app.get(
    '/backup/backups/:id/file',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'downloadBackup',
        summary: 'Download a backup',
        description: md`
          **Admins only.** The finished backup file,
          \`ct-backup-<instance>-<yyyyMMdd-HHmm>.ctbak\` (UTC), streamed from the backups
          bucket. It opens only with this deployment's \`LLM_SECRETS_KEY\`: keep a copy of
          \`deploy/.env\` somewhere other than this server.
        `,
        'x-admin': true,
        params: IdParams,
        response: {
          200: binary('The encrypted backup.', 'application/octet-stream'),
          403: ADMINS_ONLY,
          404: error('`backup not found`: no finished backup has that id.'),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      const file = params.success ? await service().download(params.data.id) : null;
      if (!file) return reply.code(404).send({ error: 'backup not found' });
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(file.size))
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .header('x-content-type-options', 'nosniff')
        .send(file.body);
    },
  );

  app.put(
    '/backup/queue',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'setQueuePaused',
        summary: 'Pause or resume the job queue',
        description: md`
          **Admins only.** Paused, no worker starts a job (running ones finish); who paused it
          and when are recorded. A restore pauses it and leaves it paused. Resuming wakes idle
          workers at once.
        `,
        'x-admin': true,
        body: QueueControlBodySchema,
        response: {
          200: res('The queue.', QueueControlViewSchema),
          400: error('A malformed body.'),
          403: ADMINS_ONLY,
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const body = QueueControlBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const by = req.auth?.label ?? null;
      const view = await service().setQueuePaused(body.data.paused, by);
      req.log.warn({ paused: view.paused, by }, 'job queue paused or resumed');
      return view;
    },
  );

  const NOT_FOUND = error('`upload not found`.');

  app.post(
    '/backup/uploads',
    {
      preHandler: uploadsOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'startBackupUpload',
        summary: 'Start uploading a backup',
        description: md`
          **Admins only.** Starts a resumable upload of a backup file to restore: send the file
          in parts of \`partBytes\` (64 MiB; the last one is what remains) with
          \`PUT /api/backup/uploads/{id}/parts/{n}\`, then \`POST …/complete\`. One upload at a
          time: starting one discards the previous upload, so none starts while a backup or
          restore runs.
        `,
        'x-admin': true,
        body: UploadStartBodySchema,
        response: {
          201: res('The upload.', UploadViewSchema),
          400: error('A malformed body.'),
          403: ADMINS_ONLY,
          409: error(`\`${BUSY}\`.`),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const body = UploadStartBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      // Starting an upload discards the previous one: never the file a restore is reading.
      if (app.deps.backup?.isBusy()) return reply.code(409).send({ error: BUSY });
      const view = await uploads().start(body.data, req.auth?.label ?? 'admin');
      return reply.code(201).send(view);
    },
  );

  app.get(
    '/backup/uploads/:id',
    {
      preHandler: uploadsOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'getBackupUpload',
        summary: 'Which parts of an upload have arrived',
        description: md`
          **Admins only.** Where an upload stands, to resume it after a lost connection: send
          the parts missing from \`received\` (0-based).
        `,
        'x-admin': true,
        params: UploadParams,
        response: {
          200: res('The upload.', UploadViewSchema),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const params = UploadParams.safeParse(req.params);
      const view = params.success ? await uploads().get(params.data.id) : null;
      if (!view) return reply.code(404).send({ error: 'upload not found' });
      return view;
    },
  );

  app.put(
    '/backup/uploads/:id/parts/:n',
    {
      bodyLimit: PART_BODY_LIMIT,
      preHandler: uploadsOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'putBackupUploadPart',
        summary: 'Upload one part',
        description: md`
          **Admins only.** One part of the file as raw \`application/octet-stream\`: exactly
          \`partBytes\` bytes (${BACKUP_PART_BYTES}), except the last part, which is what remains
          of \`size\`. Sending a part again replaces it. Parts may arrive in any order.
        `,
        'x-admin': true,
        consumes: ['application/octet-stream'],
        params: PartParams,
        body: { type: 'string', format: 'binary', description: 'The part.' },
        response: {
          200: res('The upload, with this part received.', UploadViewSchema),
          400: error('`part n must be X bytes`, or no such part.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`the upload is already complete`.'),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const params = PartParams.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.issues });
      const length = Number(req.headers['content-length']);
      const body = req.body as Readable | undefined;
      const hasBody = body !== undefined && typeof body.pipe === 'function';
      try {
        // No body or no length: the size check answers with the length the part must have.
        const stream = hasBody ? body : Readable.from([]);
        return await uploads().part(
          params.data.id,
          params.data.n,
          stream,
          hasBody && Number.isInteger(length) ? length : 0,
        );
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  app.post(
    '/backup/uploads/:id/complete',
    {
      preHandler: uploadsOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'completeBackupUpload',
        summary: 'Finish an upload',
        description: md`
          **Admins only.** Joins the parts into the file \`uploads/<id>.ctbak\` of the backups bucket.
          Every part must have arrived, else the answer names the missing ones. Asking again
          after it succeeded answers the same.
        `,
        'x-admin': true,
        params: UploadParams,
        response: {
          200: res('The stored file.', z.object({ key: z.string() })),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`parts missing: …` (0-based).'),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const params = UploadParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'upload not found' });
      try {
        return await uploads().complete(params.data.id);
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  // A restore ends every session (the restored database has none), so whoever started it
  // follows, confirms or cancels it with its token too: these routes are public at the access
  // hook and decide here, answering 404 to anyone without an admin session or the token.
  const RESTORE_NOT_FOUND = error(
    '`restore not found`: no such restore, or neither an admin session nor its token.',
  );
  const TOKEN_ACCESS = md`
    An admin session, or the restore's token (from \`POST /api/backup/restores\`) in the
    \`X-Restore-Token\` header: a restore ends every session, so the token outlives them. Without
    either, the answer is the same \`404\` as for a restore that does not exist.
  `;
  const restoreAvailable = (reply: FastifyReply) => {
    if (app.deps.backup) return true;
    void reply.code(503).send({ error: NOT_CONFIGURED });
    return false;
  };
  /** Who asks: an admin (their name), or the token from the header. */
  const caller = async (req: FastifyRequest) => {
    const header = req.headers['x-restore-token'];
    return {
      admin: await adminOf(app, req),
      token: typeof header === 'string' && header !== '' ? header : null,
    };
  };
  /** The restore, when the caller may see it. */
  const visible = async (req: FastifyRequest) => {
    const params = RestoreParams.safeParse(req.params);
    if (!params.success) return null;
    const who = await caller(req);
    const status = await service().restoreStatus(params.data.id, {
      admin: who.admin !== null,
      token: who.token,
    });
    return status && { status, admin: who.admin };
  };
  const refuseRestore = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RestoreRefusal) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.post(
    '/backup/restores',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Backup'],
        operationId: 'startRestore',
        summary: 'Check an uploaded backup before restoring it',
        description: md`
          **Admins only.** Starts the check of a completed upload in the background: the whole
          file is decrypted and verified, and nothing changes yet. \`deployment\` (disaster
          recovery, a server move) opens it with this server's \`LLM_SECRETS_KEY\`, then
          \`LLM_SECRETS_KEY_PREVIOUS\`; \`copy\` (production into staging) with \`key\`, the
          \`LLM_SECRETS_KEY\` of the deployment it came from, used for this restore only and never
          stored. A key that does not open the file ends the check as failed with
          \`this key does not open the backup\`.

          The answer carries \`token\`, shown once: keep it to follow the restore
          (\`GET /api/backup/restores/{id}\`) and confirm it once \`phase\` is \`checked\`, since a
          restore signs everyone out. From here until the restore ends or is cancelled, no
          backup, upload or other restore can start.
        `,
        'x-admin': true,
        body: RestoreStartBodySchema,
        response: {
          202: res(
            'The check, started, and the token for this restore.',
            z.object({
              status: RestoreStatusSchema,
              token: z.string().describe('Send it as `X-Restore-Token`; it is not shown again.'),
            }),
          ),
          400: error('A malformed body, or a `key` that is not 32 bytes, base64.'),
          403: ADMINS_ONLY,
          409: error(`\`${BUSY}\`, or \`${NOT_COMPLETE}\`.`),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      const body = RestoreStartBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      let key: Buffer | null = null;
      if (body.data.mode === 'copy') {
        try {
          key = parseMasterKey(body.data.key ?? '');
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      }
      const uploadKey = await app.deps.backupUploads?.completedKey(body.data.uploadId);
      if (!uploadKey) return reply.code(409).send({ error: NOT_COMPLETE });
      try {
        const by = req.auth?.label ?? 'admin';
        const started = service().startRestore({ uploadKey, mode: body.data.mode, key, by });
        req.log.warn({ id: started.status.id, mode: body.data.mode, by }, 'restore check started');
        return reply.code(202).send(started);
      } catch (err) {
        if (err instanceof BackupBusyError) return reply.code(409).send({ error: BUSY });
        throw err;
      }
    },
  );

  app.get(
    '/backup/restores/:id',
    {
      config: { public: true },
      schema: {
        tags: ['Backup'],
        operationId: 'getRestore',
        summary: 'Follow a restore',
        description: md`
          Where a restore stands: \`checking\` (with bytes read in \`done\` of \`of\`),
          \`checked\` (the backup's manifest and, for a copy, \`plan\`: what it drops and keeps),
          \`restoring\` (\`step\`, \`done\` of \`of\` steps), then \`succeeded\` with its \`report\`
          or \`failed\` with \`error\`.

          ${TOKEN_ACCESS}
        `,
        params: RestoreParams,
        headers: TokenHeaders,
        response: {
          200: res('The restore.', RestoreStatusSchema),
          404: RESTORE_NOT_FOUND,
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      if (!restoreAvailable(reply)) return reply;
      const found = await visible(req);
      if (!found) return reply.code(404).send({ error: 'restore not found' });
      return found.status;
    },
  );

  app.post(
    '/backup/restores/:id/confirm',
    {
      config: { public: true },
      schema: {
        tags: ['Backup'],
        operationId: 'confirmRestore',
        summary: 'Confirm a checked restore',
        description: md`
          Runs a restore whose check passed (\`phase\` \`checked\`), in the background, once
          \`instanceName\` is the backup's instance name as the check read it. Everyone but
          admins is held out by maintenance, the job queue is paused, the database, files and
          triple store are replaced, every session ends and the admin token from the log is
          rotated. Follow it with \`GET /api/backup/restores/{id}\`.

          ${TOKEN_ACCESS}
        `,
        params: RestoreParams,
        headers: TokenHeaders,
        body: RestoreConfirmBodySchema,
        response: {
          202: res('The restore, started.', RestoreStatusSchema),
          400: error('`type <instance> to confirm`, or a malformed body.'),
          404: RESTORE_NOT_FOUND,
          409: error(`\`${NOT_WAITING}\`: it is still being checked, or over.`),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      if (!restoreAvailable(reply)) return reply;
      const found = await visible(req);
      if (!found) return reply.code(404).send({ error: 'restore not found' });
      const body = RestoreConfirmBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const by = found.admin?.label ?? found.status.startedBy;
      try {
        const status = await service().confirmRestore(found.status.id, body.data.instanceName, by);
        req.log.warn({ id: status.id, mode: status.mode, by }, 'restore confirmed');
        return reply.code(202).send(status);
      } catch (err) {
        return refuseRestore(reply, err);
      }
    },
  );

  app.delete(
    '/backup/restores/:id',
    {
      config: { public: true },
      schema: {
        tags: ['Backup'],
        operationId: 'cancelRestore',
        summary: 'Cancel a checked restore',
        description: md`
          Gives up a restore whose check passed and that was not confirmed: nothing was
          changed. It is kept as \`failed\` with \`${RESTORE_CANCELLED}\`, and backups, uploads
          and restores can start again. The uploaded file stays, so it can be checked again.

          ${TOKEN_ACCESS}
        `,
        params: RestoreParams,
        headers: TokenHeaders,
        response: {
          204: noContent('Cancelled.'),
          404: RESTORE_NOT_FOUND,
          409: error(`\`${NOT_WAITING}\`: it is still being checked, running, or over.`),
          503: UNAVAILABLE,
        },
      },
    },
    async (req, reply) => {
      if (!restoreAvailable(reply)) return reply;
      const found = await visible(req);
      if (!found) return reply.code(404).send({ error: 'restore not found' });
      try {
        await service().cancelRestore(found.status.id);
        req.log.warn({ id: found.status.id }, 'restore cancelled');
        return reply.code(204).send();
      } catch (err) {
        return refuseRestore(reply, err);
      }
    },
  );
}
