import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BackupViewSchema,
  QueueControlBodySchema,
  QueueControlViewSchema,
  RestoreStatusSchema,
} from '@ih/shared';
import { BackupBusyError, BUSY, type BackupService } from '../backup/service.js';
import { binary, error, md, res } from '../openapi/zod.js';

const ADMINS_ONLY = error('`admins only`.');
export const NOT_CONFIGURED = 'backups need LLM_SECRETS_KEY: set it in deploy/.env';
const UNAVAILABLE = error(`\`${NOT_CONFIGURED}\`: the key every backup is encrypted with.`);

const BackupStatusSchema = z.object({
  backup: BackupViewSchema.nullable().describe(
    'The running backup, else the newest one (a failed one shows its reason).',
  ),
  restore: RestoreStatusSchema.nullable(),
  queue: QueueControlViewSchema,
});

const IdParams = z.object({ id: z.string().uuid().describe('The backup id.') });

/** Backup and restore (docs/superpowers/specs/2026-10-17-backup-and-restore-design.md). */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
    if (!app.deps.backup) return reply.code(503).send({ error: NOT_CONFIGURED });
  };
  const service = (): BackupService => app.deps.backup!;

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
          size; a failed one with its reason), the restore in progress (none yet), and whether
          the job queue is paused.
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
}
