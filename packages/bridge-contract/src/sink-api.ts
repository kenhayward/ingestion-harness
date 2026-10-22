import { z } from 'zod';
import { BridgeErrorSchema } from './errors.js';
import { ActingUserSchema, PACKAGE_PARTS, PackageSchema } from './package.js';

/** One credential a sink asks a connection for. */
export const CredentialFieldSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  secret: z.boolean(),
});

/** One destination setting of a target: fixed, or a pattern resolved per document. */
export const DestinationFieldSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['fixed', 'pattern']),
  required: z.boolean(),
  overridable: z.boolean(),
  browse: z.boolean(),
});
export type DestinationField = z.infer<typeof DestinationFieldSchema>;

export const CapabilitiesSchema = z.strictObject({
  browse: z.boolean(),
  replace: z.boolean(),
  withdraw: z.boolean(),
  readBack: z.boolean(),
  accepts: z.array(z.enum(PACKAGE_PARTS)).min(1),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** What a sink says about itself (`GET /describe`). */
export const SinkDescribeSchema = z.strictObject({
  name: z.string(),
  contractVersion: z.literal(1),
  connectionKind: z.enum(['shared', 'personal']),
  instances: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  credentialFields: z.array(CredentialFieldSchema),
  destinationFields: z.array(DestinationFieldSchema),
  capabilities: CapabilitiesSchema,
});
export type SinkDescribe = z.infer<typeof SinkDescribeSchema>;

/** Resolved destination values (patterns already applied). */
export const DestinationSchema = z.record(z.string(), z.string());
export const CredentialSchema = z.record(z.string(), z.string());

export const ConnectionTestRequestSchema = z.strictObject({
  instanceId: z.string(),
  credential: CredentialSchema,
});
export type ConnectionTestRequest = z.infer<typeof ConnectionTestRequestSchema>;

export const ConnectionTestResultSchema = z.strictObject({
  ok: z.literal(true),
  identity: z.string(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const BrowseRequestSchema = z.strictObject({
  instanceId: z.string(),
  credential: CredentialSchema.nullable(),
  field: z.string(),
  parentId: z.string().nullable(),
  cursor: z.string().nullable(),
});
export type BrowseRequest = z.infer<typeof BrowseRequestSchema>;

export const BrowseNodeSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  hasChildren: z.boolean(),
  selectable: z.boolean(),
});

export const BrowseResultSchema = z.strictObject({
  nodes: z.array(BrowseNodeSchema),
  nextCursor: z.string().nullable(),
});
export type BrowseResult = z.infer<typeof BrowseResultSchema>;

/** What a successful delivery wrote, with links where the sink can give them. */
export const ReceiptSchema = z.strictObject({
  written: z.array(
    z.strictObject({
      kind: z.string(),
      id: z.string(),
      label: z.string().nullable(),
      url: z.string().url().nullable(),
    }),
  ),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const SinkDeliverRequestSchema = z.strictObject({
  instanceId: z.string().nullable(),
  credential: CredentialSchema.nullable(),
  destination: DestinationSchema,
  idempotencyKey: z.string(),
  actingUser: ActingUserSchema.nullable(),
  package: PackageSchema,
});
export type SinkDeliverRequest = z.infer<typeof SinkDeliverRequestSchema>;

export const SinkDeliverResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), receipt: ReceiptSchema }),
  z.strictObject({ status: z.literal('pending'), sinkJobId: z.string() }),
]);
export type SinkDeliverResult = z.infer<typeof SinkDeliverResultSchema>;

export const SinkJobStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('succeeded'), receipt: ReceiptSchema }),
  z.strictObject({ status: z.literal('failed'), error: BridgeErrorSchema }),
]);
export type SinkJobStatus = z.infer<typeof SinkJobStatusSchema>;
