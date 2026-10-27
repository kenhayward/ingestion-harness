import {
  AdminAddInstanceRequestSchema,
  AdminAuditPageSchema,
  AdminClientListSchema,
  AdminClientSchema,
  AdminInstanceListSchema,
  AdminInstanceSchema,
  AdminIssueClientRequestSchema,
  AdminIssuedClientSchema,
  AdminRemovedSchema,
  AdminRenameInstanceRequestSchema,
  adminRoute,
  type ActingAdmin,
  type AdminCallName,
} from '@ih/bridge-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BridgeApiError } from '../bridge/client.js';
import { ErrorBody, error, md, res } from '../openapi/zod.js';

const BRIDGE_DOWN = 'the delivery bridge could not be reached';
const NOT_VALID = "the sink's answer is not valid";

/** An administration refusal: the message, and the contract's code when the sink gave one. */
const AdminErrorBody = ErrorBody.extend({
  code: z
    .string()
    .optional()
    .describe(
      "The refusal's code: the sink's own (`locked`, `name_conflict`, `not_found`, `not_configured`, `content_rejected`), or `not_offered`.",
    ),
});
const refusal = (description: string) => res(description, AdminErrorBody);

const SinkParams = z.object({
  sinkId: z.string().describe('The sink id, as the delivery bridge lists it.'),
});
const InstanceParams = SinkParams.extend({
  id: z.string().describe("The instance id (the sink's, never changed by a rename)."),
});
const ClientParams = SinkParams.extend({
  id: z.string().describe('The client id the sink gave it.'),
});

const AddInstanceBody = z.strictObject({
  id: AdminAddInstanceRequestSchema.shape.id.describe(
    'The new instance id: 1-64 of a-z, 0-9 and `-`, starting with a letter or digit.',
  ),
  label: AdminAddInstanceRequestSchema.shape.label.describe('What people see it called.'),
  fields: AdminAddInstanceRequestSchema.shape.fields.describe(
    "The values of the sink's declared instance fields, by field id (never secrets).",
  ),
});
const RenameInstanceBody = z.strictObject({
  label: AdminRenameInstanceRequestSchema.shape.label.describe('The new label.'),
});
const IssueClientBody = z.strictObject({
  name: AdminIssueClientRequestSchema.shape.name.describe('Who or what the client is for.'),
  instances: AdminIssueClientRequestSchema.shape.instances.describe(
    'The instance ids it works for (one at least), or `all` (also those added later).',
  ),
  access: AdminIssueClientRequestSchema.shape.access.describe(
    '`read`: the read calls only; `read_write`: everything.',
  ),
  expiresInDays: AdminIssueClientRequestSchema.shape.expiresInDays.describe(
    'Days until it expires: 7, 30, 90 or 365; null for no expiry.',
  ),
});
const AuditQuery = z.object({
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The `nextCursor` of the page before; none for the newest.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('How many entries, 1-200 (default 50).'),
});

const INSTANCE_CALLS = new Set<AdminCallName>([
  'listInstances',
  'addInstance',
  'renameInstance',
  'removeInstance',
]);

const COMMON = md`
  **Admins only.** Relayed by the delivery bridge, which signs the call with the sink's key, to a
  sink that declares administration (contract version 3); the signed-in admin is sent as
  \`actingAdmin\` for the sink's audit log. 404 for an unknown sink, 409 \`not_offered\` for a sink
  that does not declare it; the sink's own refusals keep their status and \`code\`; 502 when the
  bridge or the sink cannot be reached.
`;

const base = (operationId: string, summary: string, description: string) => ({
  tags: ['Published outputs'],
  'x-admin': true,
  operationId,
  summary,
  description: `${description}\n\n${COMMON}`,
});

const refusals = {
  400: error('Zod issues: the body or query is not what the call takes.'),
  403: error('`admins only`.'),
  404: refusal("`there is no sink …`, or the sink's `not_found`."),
  409: refusal("`not_offered`, or the sink's `locked`, `name_conflict` or `not_configured`."),
  422: refusal("The sink's `content_rejected`, e.g. a required field left out."),
  502: refusal(`\`${BRIDGE_DOWN}\`, or the sink's outage.`),
};

/**
 * Sink administration (contract version 3) for Administration > Published outputs: each route
 * relays one call to a registered sink through the delivery bridge. Registered inside the
 * publishing targets' admin routes, so their admin check applies. Nothing is stored or logged: an
 * issued client's token passes straight back to the browser, once.
 */
export async function sinkAdminRoutes(app: FastifyInstance): Promise<void> {
  const bridge = app.deps.bridge;
  const sinks = app.deps.sinks!;

  const actingAdmin = (req: FastifyRequest): ActingAdmin =>
    req.auth
      ? { id: req.auth.userId, name: req.auth.label }
      : { id: 'unit-test-admin', name: 'admin' };

  /** Relays one call; answers the sink's answer with the call's status, or a refusal. */
  const relay = async (
    req: FastifyRequest,
    reply: FastifyReply,
    sinkId: string,
    call: AdminCallName,
    id: string | null,
    rest: Record<string, unknown>,
  ): Promise<FastifyReply> => {
    const listed = await sinks.refresh(bridge);
    const sink = sinks.get(sinkId);
    if (!sink) {
      return listed
        ? reply.code(404).send({ error: `there is no sink ${sinkId}` })
        : reply.code(502).send({ error: BRIDGE_DOWN });
    }
    const offered = sink.contractVersion >= 3 ? (sink.capabilities.administration ?? null) : null;
    const part = INSTANCE_CALLS.has(call) ? 'instances' : 'clients';
    if (!offered || !offered[part]) {
      const what = offered ? `administration of its ${part}` : 'administration';
      return reply
        .code(409)
        .send({ error: `${sink.name} does not offer ${what}`, code: 'not_offered' });
    }
    try {
      const answer = await bridge.sinkAdmin(sinkId, {
        call,
        id,
        request: { actingAdmin: actingAdmin(req), ...rest } as never,
      });
      return reply.code(adminRoute(call).status).send(answer);
    } catch (err) {
      if (err instanceof BridgeApiError && err.error) {
        const status = err.status >= 400 && err.status < 500 ? err.status : 502;
        return reply.code(status).send({ error: err.error.message, code: err.error.code });
      }
      if (err instanceof z.ZodError) return reply.code(502).send({ error: NOT_VALID });
      return reply.code(502).send({ error: BRIDGE_DOWN });
    }
  };

  const bad = (reply: FastifyReply, e: z.ZodError) => reply.code(400).send({ error: e.issues });

  app.get(
    '/publish-targets/sinks/:sinkId/admin/instances',
    {
      schema: {
        ...base(
          'listSinkInstances',
          "List a sink's instances",
          md`
            The places a sink delivers to, as it lists them: id, label, the declared fields'
            values (never secrets), who added each and when. Entries from the sink's own
            configuration are \`locked\`: never renamed or removed.
          `,
        ),
        params: SinkParams,
        response: { 200: res('The instances.', AdminInstanceListSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = SinkParams.parse(req.params);
      return relay(req, reply, p.sinkId, 'listInstances', null, {});
    },
  );

  app.post(
    '/publish-targets/sinks/:sinkId/admin/instances',
    {
      schema: {
        ...base(
          'addSinkInstance',
          'Add an instance to a sink',
          md`
            Adds an instance with an id, a label and the values of the fields the sink declares
            (\`instanceFields\` of its administration capability). 409 \`name_conflict\` when the id
            is taken.
          `,
        ),
        params: SinkParams,
        body: AddInstanceBody,
        response: { 201: res('The instance added.', AdminInstanceSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = SinkParams.parse(req.params);
      const body = AddInstanceBody.safeParse(req.body ?? {});
      if (!body.success) return bad(reply, body.error);
      return relay(req, reply, p.sinkId, 'addInstance', null, body.data);
    },
  );

  app.post(
    '/publish-targets/sinks/:sinkId/admin/instances/:id/rename',
    {
      schema: {
        ...base(
          'renameSinkInstance',
          "Rename a sink's instance",
          md`
            Changes an instance's label; its id never changes. 409 \`locked\` for an instance from
            the sink's configuration, 404 \`not_found\` for an unknown one.
          `,
        ),
        params: InstanceParams,
        body: RenameInstanceBody,
        response: { 200: res('The instance renamed.', AdminInstanceSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = InstanceParams.parse(req.params);
      const body = RenameInstanceBody.safeParse(req.body ?? {});
      if (!body.success) return bad(reply, body.error);
      return relay(req, reply, p.sinkId, 'renameInstance', p.id, body.data);
    },
  );

  app.post(
    '/publish-targets/sinks/:sinkId/admin/instances/:id/remove',
    {
      schema: {
        ...base(
          'removeSinkInstance',
          "Remove a sink's instance",
          md`
            Removes an instance. One still in use may be removed: its next delivery fails. 409
            \`locked\` for an instance from the sink's configuration, 404 \`not_found\` for an
            unknown one.
          `,
        ),
        params: InstanceParams,
        response: { 200: res('The instance removed.', AdminRemovedSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = InstanceParams.parse(req.params);
      return relay(req, reply, p.sinkId, 'removeInstance', p.id, {});
    },
  );

  app.get(
    '/publish-targets/sinks/:sinkId/admin/clients',
    {
      schema: {
        ...base(
          'listSinkClients',
          "List a sink's clients",
          md`
            The tokens a sink's own callers use, without their secrets: name, the secret's first
            characters (\`prefix\`), instances, access, expiry, revocation and last use. Entries
            from the sink's own configuration are \`locked\`: never revoked.
          `,
        ),
        params: SinkParams,
        response: { 200: res('The clients.', AdminClientListSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = SinkParams.parse(req.params);
      return relay(req, reply, p.sinkId, 'listClients', null, {});
    },
  );

  app.post(
    '/publish-targets/sinks/:sinkId/admin/clients',
    {
      schema: {
        ...base(
          'issueSinkClient',
          'Issue a client token for a sink',
          md`
            Issues a client: a token for the instances named (or \`all\`), read or read-write,
            expiring after 7, 30, 90 or 365 days or never. The answer is the only time the
            \`token\` is sent: CT Studio neither stores nor logs it.
          `,
        ),
        params: SinkParams,
        body: IssueClientBody,
        response: {
          201: res('The client, and its token (shown once).', AdminIssuedClientSchema),
          ...refusals,
        },
      },
    },
    async (req, reply) => {
      const p = SinkParams.parse(req.params);
      const body = IssueClientBody.safeParse(req.body ?? {});
      if (!body.success) return bad(reply, body.error);
      return relay(req, reply, p.sinkId, 'issueClient', null, body.data);
    },
  );

  app.post(
    '/publish-targets/sinks/:sinkId/admin/clients/:id/revoke',
    {
      schema: {
        ...base(
          'revokeSinkClient',
          "Revoke a sink's client",
          md`
            Revokes a client: its token stops working at once. Revoking again answers the client
            as it is. 409 \`locked\` for a client from the sink's configuration, 404 \`not_found\`
            for an unknown one.
          `,
        ),
        params: ClientParams,
        response: { 200: res('The client, revoked.', AdminClientSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = ClientParams.parse(req.params);
      return relay(req, reply, p.sinkId, 'revokeClient', p.id, {});
    },
  );

  app.get(
    '/publish-targets/sinks/:sinkId/admin/audit',
    {
      schema: {
        ...base(
          'listSinkAudit',
          "Read a sink's administration audit log",
          md`
            The changes made to a sink's instances and clients, newest first: when, by which
            administrator, what and to which entry. Never a secret. Paged by \`cursor\`
            (\`nextCursor\` of the page before, null on the last page).
          `,
        ),
        params: SinkParams,
        querystring: AuditQuery,
        response: { 200: res('One page of the log.', AdminAuditPageSchema), ...refusals },
      },
    },
    async (req, reply) => {
      const p = SinkParams.parse(req.params);
      const q = AuditQuery.safeParse(req.query ?? {});
      if (!q.success) return bad(reply, q.error);
      return relay(req, reply, p.sinkId, 'listAudit', null, {
        cursor: q.data.cursor ?? null,
        limit: q.data.limit,
      });
    },
  );
}
