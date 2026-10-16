import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAINTENANCE_ERROR,
  MaintenanceBodySchema,
  MaintenanceNoticeSchema,
  MaintenanceViewSchema,
  type MaintenanceView,
} from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';

/** The 503 the access hook and sign-in answer people who are not admins while it is on. */
export const maintenanceRefusal = (view: MaintenanceView) => ({
  error: MAINTENANCE_ERROR,
  maintenance: notice(view),
});

const notice = ({ enabled, message, since }: MaintenanceView) => ({ enabled, message, since });

const ADMINS_ONLY = error('`admins only`.');

/** Maintenance mode (migration 0046): Administration > Maintenance and the sign-in page's notice. */
export async function maintenanceRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  };

  app.get(
    '/maintenance',
    {
      config: { public: true },
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'getMaintenanceNotice',
        summary: 'Is CT Studio under maintenance?',
        description: md`
          Whether an admin has taken CT Studio down for maintenance, their message and since
          when. Needs no session: the sign-in page shows it. While it is on, only admins can sign
          in, and every other guarded route answers people who are not admins \`503\`
          \`{ "error": "${MAINTENANCE_ERROR}", "maintenance": { … } }\`.
        `,
        response: { 200: res('The notice.', MaintenanceNoticeSchema) },
      },
    },
    async () => notice(await app.maintenance.current()),
  );

  app.get(
    '/maintenance/settings',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'getMaintenance',
        summary: 'Maintenance mode, with who changed it',
        description: md`
          **Admins only.** The notice (on or off, the message, since when) and which admin changed
          it last, and when: what Administration > Maintenance shows.
        `,
        'x-admin': true,
        response: { 200: res('Maintenance mode.', MaintenanceViewSchema), 403: ADMINS_ONLY },
      },
    },
    async () => app.maintenance.current(),
  );

  app.put(
    '/maintenance',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'setMaintenance',
        summary: 'Switch maintenance mode on or off',
        description: md`
          **Admins only.** On, people who are not admins cannot sign in and every guarded route
          answers them \`503\` with the message (blank: a default one); their sessions are kept,
          so they carry on once it is off. Admins keep working, and the worker keeps running
          queued jobs. The message (at most 1,000 characters, trimmed) is kept when switched off.
        `,
        'x-admin': true,
        body: MaintenanceBodySchema,
        response: {
          200: res('Maintenance mode.', MaintenanceViewSchema),
          400: error('A malformed body.'),
          403: ADMINS_ONLY,
        },
      },
    },
    async (req, reply) => {
      const body = MaintenanceBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const by = req.auth?.label ?? null;
      const view = await app.maintenance.set(body.data, by);
      req.log.warn({ enabled: view.enabled, by }, 'maintenance mode changed');
      return view;
    },
  );
}
