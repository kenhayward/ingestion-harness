import { z } from 'zod';
import { BridgeErrorSchema } from './errors.js';
import { ActingUserSchema, PackageSchema } from './package.js';
import { CapabilitiesSchema, DestinationSchema, ReceiptSchema } from './sink-api.js';

export const DELIVERY_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'skipped',
  'needs_user',
  'failed',
] as const;
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** `POST /v1/deliveries`: one package to one or more targets, as one user. */
export const CreateDeliveriesRequestSchema = z.strictObject({
  targets: z.array(z.string().min(1)).min(1),
  actingUser: ActingUserSchema.nullable(),
  /** Per target id, per destination field id: the reviewer's overrides. */
  overrides: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  package: PackageSchema,
});
export type CreateDeliveriesRequest = z.infer<typeof CreateDeliveriesRequestSchema>;

export const CreateDeliveriesResultSchema = z.strictObject({
  packageId: z.string().uuid(),
  deliveries: z.array(z.strictObject({ targetId: z.string(), deliveryId: z.string().uuid() })),
});
export type CreateDeliveriesResult = z.infer<typeof CreateDeliveriesResultSchema>;

export const DeliveryViewSchema = z.strictObject({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  targetId: z.string(),
  status: DeliveryStatusSchema,
  attempts: z.number().int(),
  error: BridgeErrorSchema.nullable(),
  receipt: ReceiptSchema.nullable(),
  skippedFor: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeliveryView = z.infer<typeof DeliveryViewSchema>;

/** What the bridge posts to the producer on every status change of a delivery. */
export const BridgeEventSchema = z.strictObject({
  eventId: z.string().uuid(),
  deliveryId: z.string().uuid(),
  sequence: z.number().int().positive(),
  status: DeliveryStatusSchema,
  error: BridgeErrorSchema.nullable(),
  receipt: ReceiptSchema.nullable(),
  at: z.string().datetime(),
});
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export const SinkViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  status: z.enum(['available', 'unavailable']),
  contractVersion: z.number().int(),
  capabilities: CapabilitiesSchema,
  connectionKind: z.enum(['shared', 'personal']),
});
export type SinkView = z.infer<typeof SinkViewSchema>;

export const TargetViewSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  sinkId: z.string(),
  instanceId: z.string().nullable(),
  /** The connection a shared sink delivers with (null: none yet). */
  connectionId: z.string().nullable(),
  destination: DestinationSchema,
});
export type TargetView = z.infer<typeof TargetViewSchema>;

/**
 * Test connection for a target: the first step that failed, or ok. The same shape as CT Studio's
 * `TargetTestResultSchema` (@ih/shared); the fixture target-test-result.json keeps them equal.
 */
export const TargetTestResultSchema = z.strictObject({
  ok: z.boolean(),
  step: z.enum(['connect', 'write', 'read', 'delete']).nullable(),
  message: z.string(),
});
export type TargetTestResult = z.infer<typeof TargetTestResultSchema>;

/** Target ids: what CT Studio's target ids already are. */
export const RESOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Connection ids: room for `target-<target id>`, the ids the move from CT Studio makes. */
export const CONNECTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `PUT /v1/targets/{id}`: creates or replaces a target. */
export const TargetPutRequestSchema = z.strictObject({
  label: z.string().min(1),
  sinkId: z.string().min(1),
  instanceId: z.string().nullable(),
  connectionId: z.string().regex(CONNECTION_ID).nullable(),
  destination: DestinationSchema,
});
export type TargetPutRequest = z.infer<typeof TargetPutRequestSchema>;

/** `POST /v1/targets:test`: Test connection for settings not saved yet. */
export const TargetSettingsTestRequestSchema = z.strictObject({
  connectionId: z.string().regex(CONNECTION_ID),
  destination: DestinationSchema,
});
export type TargetSettingsTestRequest = z.infer<typeof TargetSettingsTestRequestSchema>;

export const ObjectRefSchema = z.strictObject({
  bucket: z.string().min(1),
  key: z.string().min(1),
});
export type ObjectRef = z.infer<typeof ObjectRefSchema>;

/** `POST /v1/targets/{id}/objects:read` answers the object's bytes, base64. */
export const ObjectReadResultSchema = z.strictObject({ content: z.string().base64() });

export const ObjectPutRequestSchema = ObjectRefSchema.extend({
  contentType: z.string().min(1),
  content: z.string().base64(),
});
export type ObjectPutRequest = z.infer<typeof ObjectPutRequestSchema>;

export const ObjectDeleteRequestSchema = z.strictObject({
  objects: z.array(ObjectRefSchema).min(1),
});
export const ObjectDeleteResultSchema = z.strictObject({ deleted: z.number().int() });

/** The bridge redeems a one-time code (`POST {producer}/bridge/handoff/redeem`) for this user. */
export const HandoffRedeemRequestSchema = z.strictObject({ code: z.string().min(1) });
export const HandoffUserSchema = ActingUserSchema.extend({
  role: z.enum(['admin', 'designer', 'operator']),
});
export type HandoffUser = z.infer<typeof HandoffUserSchema>;

/**
 * `PUT /v1/connections/{id}`: a shared connection written by the producer. Used once, to move
 * the keys CT Studio held for its targets onto the bridge; admins manage connections on the
 * bridge's connections page. Either the secret (encrypted by the bridge on arrival) or the name
 * of an allowlisted variable of the bridge's environment holding it.
 */
export const ConnectionPutRequestSchema = z.strictObject({
  name: z.string().min(1),
  sinkId: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  secret: z.string().min(1).nullable(),
  secretEnv: z.string().min(1).nullable(),
});
export type ConnectionPutRequest = z.infer<typeof ConnectionPutRequestSchema>;

/** A connection as the producer sees it: never a secret, never a credential field. */
export const ConnectionSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  sinkId: z.string(),
  status: z.enum(['ok', 'needs_attention', 'untested']),
  statusReason: z.string().nullable(),
});
export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;
