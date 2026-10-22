import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RoleSchema } from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';
import {
  SIGN_IN_RETENTION_DAYS,
  type AccessRepo,
  type SignInEvent,
  type User,
  type UserProblem,
} from './repo.js';

const Role = RoleSchema;
const Name = z.string().trim().min(1).max(100).describe('Unique, whatever the case.');
const Email = z
  .string()
  .trim()
  .email()
  .max(254)
  .describe('Unique, whatever the case; stored in lower case.');
const Time = z.string().datetime();

const NewUserBody = z.object({
  name: Name,
  email: Email,
  role: Role.default('designer').describe(
    '`admin` (Administrator), `designer` (Workbench and Document types) or `operator` (Home, Jobs and Results only). Default `designer`.',
  ),
});
const PatchBody = z
  .object({ name: Name, email: Email, role: Role })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
const UserParams = z.object({ id: z.string().describe('The user id.') });
const SignInsQuery = z.object({
  userId: z.string().uuid().optional().describe("Only this user's events."),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('1-200, default 50.'),
});

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable().describe('null for the admin from the API log.'),
  role: Role,
  status: z
    .enum(['admin-from-log', 'active', 'must-change', 'locked', 'disabled'])
    .describe('`locked` = temporarily, until `lockedUntil`.'),
  createdAt: Time,
  createdBy: z.string().nullable(),
  lastSignInAt: Time.nullable(),
  failedSignIns: z.number().int().describe('Consecutive failed sign-ins since the last success.'),
  lastFailedAt: Time.nullable(),
  lockedUntil: Time.nullable(),
  disabledAt: Time.nullable(),
  disabledReason: z.enum(['admin', 'failed-sign-ins']).nullable(),
  disabledBy: z.string().nullable().describe('The admin; null when failed sign-ins disabled it.'),
  oneTimeExpiresAt: Time.nullable().describe('When the one-time password stops working.'),
});
const WithPassword = z.object({
  user: UserSchema,
  password: z.string().describe('The one-time password. Shown only in this response.'),
});
export const SignInEventSchema = z.object({
  id: z.string(),
  at: Time,
  userId: z.string().uuid().nullable().describe('null for an email that matches nobody.'),
  name: z.string().nullable(),
  result: z.enum([
    'ok',
    'wrong-password',
    'unknown-login',
    'locked',
    'disabled',
    'expired-one-time',
    'password-changed',
    'password-change-refused',
  ]),
  failures: z
    .number()
    .int()
    .nullable()
    .describe('The count after a wrong password; for `ok`, the count it cleared.'),
  lockedUntil: Time.nullable(),
  ip: z.string(),
  userAgent: z.string().nullable(),
});

const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND = error('`not found`: no user with this id.');

const PROBLEM: Record<UserProblem, [number, string]> = {
  not_found: [404, 'not found'],
  'admin-from-log': [
    409,
    'the admin from the log cannot be changed: it rotates on every API start',
  ],
  email_taken: [409, 'a user with this email already exists'],
  name_taken: [409, 'a user with this name already exists'],
};

function send<T extends object>(reply: FastifyReply, result: T | UserProblem, code = 200) {
  if (typeof result === 'string') {
    const [status, message] = PROBLEM[result];
    return reply.code(status).send({ error: message });
  }
  return reply.code(code).send(result);
}

/** The user admin routes and the sign-in log (ADR 0013), admins only. */
export function registerUserRoutes(app: FastifyInstance, access: AccessRepo): void {
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'admins only' });
  };
  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const self = (req: FastifyRequest<{ Params: { id: string } }>) =>
    req.params.id === req.auth?.userId;
  const level = (role: string) => (role === 'admin' ? 'warn' : 'info');

  app.get(
    '/api/users',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'listUsers',
        summary: 'List users',
        description: md`
          **Admins only.** Every user: the admin from the API log first, then by name. Never a
          password or a hash.
        `,
        response: { 200: res('The users.', z.array(UserSchema)), 403: ADMINS_ONLY },
      },
    },
    async (): Promise<User[]> => access.listUsers(),
  );

  app.post(
    '/api/users',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'addUser',
        summary: 'Add a user',
        description: md`
          **Admins only.** Adds a user with a generated one-time password, returned in this
          response only: give it to the person, who chooses their own password at first
          sign-in. It works for 7 days.
        `,
        body: NewUserBody,
        response: {
          201: res('The user and their one-time password.', WithPassword),
          400: error('`name (1-100 chars) and a valid email are required`.'),
          403: ADMINS_ONLY,
          409: error('`a user with this email already exists` or `… this name …`.'),
        },
      },
    },
    async (req, reply) => {
      const body = NewUserBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'name (1-100 chars) and a valid email are required' });
      }
      const result = await access.createUser(body.data, by(req));
      if (typeof result !== 'string') {
        req.log[level(body.data.role)](
          { userId: result.user.id, role: body.data.role, by: by(req) },
          'user added',
        );
      }
      return send(reply, result, 201);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/users/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'updateUser',
        summary: 'Edit a user',
        description: md`
          **Admins only.** Changes any of the name, email address and role. A role change
          applies to the user's open sessions at once. You cannot remove your own admin role,
          and the admin from the API log cannot be changed.
        `,
        params: UserParams,
        body: PatchBody,
        response: {
          200: res('The user.', UserSchema),
          400: error('`name (1-100 chars), a valid email or a role is required`.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error(
            'The email or name is taken, `you cannot remove your own admin role`, or the admin from the log.',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = PatchBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: 'name (1-100 chars), a valid email or a role is required' });
      }
      if (self(req) && body.data.role !== undefined && body.data.role !== 'admin') {
        return reply.code(409).send({ error: 'you cannot remove your own admin role' });
      }
      const result = await access.updateUser(req.params.id, body.data);
      if (typeof result !== 'string') {
        req.log[body.data.role === 'admin' ? 'warn' : 'info'](
          { userId: result.id, fields: Object.keys(body.data), by: by(req) },
          'user changed',
        );
      }
      return send(reply, result);
    },
  );

  const toggle = (enabled: boolean) =>
    async function (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
      if (!enabled && self(req)) {
        return reply.code(409).send({ error: 'you cannot disable yourself' });
      }
      const result = await access.setEnabled(req.params.id, enabled, by(req));
      if (typeof result !== 'string') {
        req.log.info(
          { userId: result.id, by: by(req) },
          enabled ? 'user enabled' : 'user disabled',
        );
        // A disabled user's own logins to other systems go with them. A bridge that is down
        // leaves them to the hourly reconcile; the disable stands either way.
        if (!enabled) {
          const userId = result.id;
          void app.deps.bridge
            .deleteUserConnections(userId)
            .then((deleted) => {
              if (deleted) req.log.info({ userId, deleted }, 'personal connections deleted');
            })
            .catch((err: unknown) =>
              req.log.warn({ err, userId }, 'personal connections not deleted: the reconcile will'),
            );
        }
      }
      return send(reply, result);
    };

  app.post<{ Params: { id: string } }>(
    '/api/users/:id/disable',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'disableUser',
        summary: 'Disable a user',
        description: md`
          **Admins only.** The user can no longer sign in, and every session of theirs ends at
          once. Nothing they made is removed, but their personal connections on the delivery
          bridge are deleted (enabling them again does not bring those back). You cannot disable
          yourself.
        `,
        params: UserParams,
        response: {
          200: res('The user.', UserSchema),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('`you cannot disable yourself`, or the admin from the log.'),
        },
      },
    },
    toggle(false),
  );

  app.post<{ Params: { id: string } }>(
    '/api/users/:id/enable',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'enableUser',
        summary: 'Enable or unlock a user',
        description: md`
          **Admins only.** Lets the user sign in again: ends a disable (by an admin or after
          too many failed sign-ins) or a temporary lock, and resets the failure count.
        `,
        params: UserParams,
        response: {
          200: res('The user.', UserSchema),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('The admin from the log.'),
        },
      },
    },
    toggle(true),
  );

  app.post<{ Params: { id: string } }>(
    '/api/users/:id/one-time-password',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'reissuePassword',
        summary: 'Reissue a one-time password',
        description: md`
          **Admins only.** Replaces the user's password with a new one-time password, returned
          in this response only, valid for 7 days. Their current password stops working, every
          session of theirs ends, and the account is enabled and unlocked. You cannot reissue
          your own (change it with \`PUT /api/auth/password\`).
        `,
        params: UserParams,
        response: {
          200: res('The user and their new one-time password.', WithPassword),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('Your own user, or the admin from the log.'),
        },
      },
    },
    async (req, reply) => {
      // Reissuing ends every session of the user: your own would sign you out before you saw it.
      if (self(req)) {
        return reply
          .code(409)
          .send({ error: 'you cannot reissue your own password: change it from the account menu' });
      }
      const result = await access.reissuePassword(req.params.id);
      if (typeof result !== 'string') {
        req.log.info({ userId: result.user.id, by: by(req) }, 'one-time password reissued');
      }
      return send(reply, result);
    },
  );

  app.get(
    '/api/sign-ins',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Users'],
        'x-admin': true,
        operationId: 'listSignIns',
        summary: 'List recent sign-ins',
        description: md`
          **Admins only.** Sign-in attempts and password changes, newest first: when, who
          (null for an email that matches nobody), the result, the client IP and the user
          agent. What someone typed is never stored. Events are kept ${SIGN_IN_RETENTION_DAYS}
          days.
        `,
        querystring: SignInsQuery,
        response: {
          200: res('The events.', z.array(SignInEventSchema)),
          400: error('`limit is 1-200 and userId a user id`.'),
          403: ADMINS_ONLY,
        },
      },
    },
    async (req, reply) => {
      const query = SignInsQuery.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: 'limit is 1-200 and userId a user id' });
      }
      const events: SignInEvent[] = await access.listSignIns(query.data);
      return events;
    },
  );
}
