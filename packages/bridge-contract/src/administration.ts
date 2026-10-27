import { z } from 'zod';

/**
 * Version 3: administration of a sink's instances (the places it delivers to, a tenant say) and
 * clients (the tokens its own callers use), through the bridge. A sink declares it in `describe`
 * (`capabilities.administration`); one that doesn't is unchanged, and a producer offers
 * administration only for sinks that declare it (`administrationOf`).
 *
 * Every call is a signed bridge call (`signRequest`, as for every other sink call), a `POST` whose
 * JSON body carries `actingAdmin`: the producer's administrator, for the sink's audit log. The sink
 * trusts the producer's statement that the person is an administrator. Entries from the sink's own
 * configuration (its environment) are listed with `locked: true` and are never renamed, removed or
 * revoked (`locked`). A client's secret is answered once, by `issue`, and never again.
 */

/** The producer's administrator acting, recorded by the sink's audit log. */
export const ActingAdminSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type ActingAdmin = z.infer<typeof ActingAdminSchema>;

/** An instance id: lower-case letters, digits and `-`, path safe. A sink may ask for less. */
export const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A client id, chosen by the sink: path safe. */
export const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One setting of an instance, declared so a producer renders the form. Never a secret. */
export const InstanceFieldSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  label: z.string().min(1),
  required: z.boolean(),
  /** A short hint shown beside the field, or null. */
  hint: z.string().nullable(),
});
export type InstanceField = z.infer<typeof InstanceFieldSchema>;

/** What `describe` declares under `capabilities.administration`. */
export const AdministrationSchema = z
  .strictObject({
    instances: z.boolean(),
    clients: z.boolean(),
    /** The settings an added instance takes (besides its id and label). */
    instanceFields: z.array(InstanceFieldSchema),
  })
  .refine((a) => a.instances || a.clients, {
    message: 'administration offers instances, clients or both',
  });
export type Administration = z.infer<typeof AdministrationSchema>;

const label = z.string().trim().min(1).max(200);
const at = z.string().datetime();

/** An instance as listed. `fields` are the declared settings' values (never a secret). */
export const AdminInstanceSchema = z.strictObject({
  id: z.string().regex(INSTANCE_ID),
  label: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  /** From the sink's own configuration: listed, never renamed or removed. */
  locked: z.boolean(),
  createdAt: at.nullable(),
  createdBy: ActingAdminSchema.nullable(),
});
export type AdminInstance = z.infer<typeof AdminInstanceSchema>;

export const AdminInstanceListSchema = z.strictObject({ instances: z.array(AdminInstanceSchema) });
export type AdminInstanceList = z.infer<typeof AdminInstanceListSchema>;

/** A body that carries only who acts (list, remove, revoke). */
export const AdminRequestSchema = z.strictObject({ actingAdmin: ActingAdminSchema });
export type AdminRequest = z.infer<typeof AdminRequestSchema>;

export const AdminAddInstanceRequestSchema = z.strictObject({
  actingAdmin: ActingAdminSchema,
  id: z.string().regex(INSTANCE_ID),
  label,
  fields: z.record(z.string(), z.string()),
});
export type AdminAddInstanceRequest = z.infer<typeof AdminAddInstanceRequestSchema>;

/** Renaming changes the label only: the id never changes. */
export const AdminRenameInstanceRequestSchema = z.strictObject({
  actingAdmin: ActingAdminSchema,
  label,
});
export type AdminRenameInstanceRequest = z.infer<typeof AdminRenameInstanceRequestSchema>;

/** What `remove` and `revoke` answer when nothing went wrong. */
export const AdminRemovedSchema = z.strictObject({ id: z.string(), removed: z.literal(true) });
export type AdminRemoved = z.infer<typeof AdminRemovedSchema>;

/** The expiries a client may be issued with, in days; `null` = no expiry. */
export const CLIENT_EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const ClientExpirySchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(365),
  z.null(),
]);
export type ClientExpiry = z.infer<typeof ClientExpirySchema>;

/** `read`: the sink's read calls only; `read_write`: everything. */
export const CLIENT_ACCESS = ['read', 'read_write'] as const;
export const ClientAccessSchema = z.enum(CLIENT_ACCESS);
export type ClientAccess = z.infer<typeof ClientAccessSchema>;

/** The instances a client works for: a list, or `all` (also those added later). */
export const ClientInstancesSchema = z.union([
  z.literal('all'),
  z.array(z.string().regex(INSTANCE_ID)).min(1),
]);
export type ClientInstances = z.infer<typeof ClientInstancesSchema>;

/** A client as listed: everything but the secret. */
export const AdminClientSchema = z.strictObject({
  id: z.string().regex(CLIENT_ID),
  name: z.string().min(1),
  /** The secret's first characters, so a person tells clients apart; null for a locked one. */
  prefix: z.string().min(1).max(16).nullable(),
  instances: ClientInstancesSchema,
  access: ClientAccessSchema,
  /** From the sink's own configuration: listed, never revoked. */
  locked: z.boolean(),
  createdAt: at.nullable(),
  createdBy: ActingAdminSchema.nullable(),
  expiresAt: at.nullable(),
  revokedAt: at.nullable(),
  lastUsedAt: at.nullable(),
});
export type AdminClient = z.infer<typeof AdminClientSchema>;

export const AdminClientListSchema = z.strictObject({ clients: z.array(AdminClientSchema) });
export type AdminClientList = z.infer<typeof AdminClientListSchema>;

export const AdminIssueClientRequestSchema = z.strictObject({
  actingAdmin: ActingAdminSchema,
  /** Who or what the client is for. */
  name: label,
  instances: ClientInstancesSchema,
  access: ClientAccessSchema,
  expiresInDays: ClientExpirySchema,
});
export type AdminIssueClientRequest = z.infer<typeof AdminIssueClientRequestSchema>;

/** What `issue` answers: the client, and its secret. The only time the secret is sent. */
export const AdminIssuedClientSchema = z.strictObject({
  client: AdminClientSchema,
  token: z.string().min(16),
});
export type AdminIssuedClient = z.infer<typeof AdminIssuedClientSchema>;

/** Whether a client works now. */
export function clientState(
  client: Pick<AdminClient, 'revokedAt' | 'expiresAt'>,
  now: Date = new Date(),
): 'active' | 'expired' | 'revoked' {
  if (client.revokedAt) return 'revoked';
  if (client.expiresAt && Date.parse(client.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

export const AUDIT_ACTIONS = [
  'instance_added',
  'instance_renamed',
  'instance_removed',
  'client_issued',
  'client_revoked',
] as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** One change, as the sink's audit log recorded it. Never a secret. */
export const AuditEntrySchema = z.strictObject({
  at,
  actor: ActingAdminSchema,
  action: AuditActionSchema,
  /** The instance id, or the client's id. */
  subject: z.string().min(1),
  /** A short human summary, e.g. `Renamed “Old” to “New”`, or null. */
  detail: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AdminAuditRequestSchema = z.strictObject({
  actingAdmin: ActingAdminSchema,
  /** From `nextCursor`, or null for the newest entries. */
  cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(200),
});
export type AdminAuditRequest = z.infer<typeof AdminAuditRequestSchema>;

/** Newest first. */
export const AdminAuditPageSchema = z.strictObject({
  entries: z.array(AuditEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AdminAuditPage = z.infer<typeof AdminAuditPageSchema>;

const seg = encodeURIComponent;

/** The administration paths. */
export const adminPath = {
  listInstances: '/admin/instances:list',
  instances: '/admin/instances',
  renameInstance: (id: string) => `/admin/instances/${seg(id)}:rename`,
  removeInstance: (id: string) => `/admin/instances/${seg(id)}:remove`,
  listClients: '/admin/clients:list',
  clients: '/admin/clients',
  revokeClient: (id: string) => `/admin/clients/${seg(id)}:revoke`,
  audit: '/admin/audit:list',
} as const;

/**
 * Every administration call: its path (`:id` where an id goes), request and answer, and the
 * status of a success. Refusals are contract errors (`BridgeErrorSchema`): `not_configured` (409)
 * while the sink cannot keep administration state, `content_rejected` (422) for a body or field
 * the sink refuses, `name_conflict` (409) for an id taken, `not_found` (404) for an unknown
 * instance or client, `locked` (409) for an entry from the sink's configuration.
 */
export const ADMIN_ROUTES = [
  {
    name: 'listInstances',
    method: 'POST',
    path: adminPath.listInstances,
    request: AdminRequestSchema,
    response: AdminInstanceListSchema,
    status: 200,
  },
  {
    name: 'addInstance',
    method: 'POST',
    path: adminPath.instances,
    request: AdminAddInstanceRequestSchema,
    response: AdminInstanceSchema,
    status: 201,
  },
  {
    name: 'renameInstance',
    method: 'POST',
    path: '/admin/instances/:id:rename',
    request: AdminRenameInstanceRequestSchema,
    response: AdminInstanceSchema,
    status: 200,
  },
  {
    name: 'removeInstance',
    method: 'POST',
    path: '/admin/instances/:id:remove',
    request: AdminRequestSchema,
    response: AdminRemovedSchema,
    status: 200,
  },
  {
    name: 'listClients',
    method: 'POST',
    path: adminPath.listClients,
    request: AdminRequestSchema,
    response: AdminClientListSchema,
    status: 200,
  },
  {
    name: 'issueClient',
    method: 'POST',
    path: adminPath.clients,
    request: AdminIssueClientRequestSchema,
    response: AdminIssuedClientSchema,
    status: 201,
  },
  {
    name: 'revokeClient',
    method: 'POST',
    path: '/admin/clients/:id:revoke',
    request: AdminRequestSchema,
    response: AdminClientSchema,
    status: 200,
  },
  {
    name: 'listAudit',
    method: 'POST',
    path: adminPath.audit,
    request: AdminAuditRequestSchema,
    response: AdminAuditPageSchema,
    status: 200,
  },
] as const;
