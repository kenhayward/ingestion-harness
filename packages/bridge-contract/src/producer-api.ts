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
