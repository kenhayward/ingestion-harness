import { z } from 'zod';
import { AdministrationSchema, type Administration } from './administration.js';
import { BridgeErrorSchema } from './errors.js';
import { ActingUserSchema, ContractVersion, PACKAGE_PARTS, PackageSchema } from './package.js';

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
  /**
   * Version 2: the sink takes decomposed documents (the `document` part), with equations in these
   * forms. Needs `contractVersion: 2`, `readBack` and `accepts` holding `document` and `images`.
   */
  decomposedDocuments: z
    .strictObject({ equations: z.array(z.enum(['mathml', 'latex', 'image'])).min(1) })
    .optional(),
  /** Version 3: the sink's instances and clients can be administered through the bridge. */
  administration: AdministrationSchema.optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/**
 * The versions a sink may declare: the package versions, and 3 (version 2 plus administration,
 * which changes no package). A version 3 sink is sent version 2 packages (`packageVersionFor`).
 */
export const DescribeContractVersion = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type DescribeContractVersion = z.infer<typeof DescribeContractVersion>;

/** The package version a sink of `version` is sent: packages stop at version 2. */
export function packageVersionFor(version: DescribeContractVersion): ContractVersion {
  return version === 1 ? 1 : 2;
}

/** The most deliveries one instance may take at once. */
export const MAX_LANES = 64;

/**
 * One place a sink delivers to. `lanes` is how many deliveries it takes at once (default 1);
 * it is independent of `contractVersion`.
 */
export const InstanceSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  lanes: z.number().int().min(1).max(MAX_LANES).optional(),
});
export type Instance = z.infer<typeof InstanceSchema>;

/** What a sink says about itself (`GET /describe`). */
export const SinkDescribeSchema = z
  .strictObject({
    name: z.string(),
    contractVersion: DescribeContractVersion,
    connectionKind: z.enum(['shared', 'personal']),
    instances: z.array(InstanceSchema),
    credentialFields: z.array(CredentialFieldSchema),
    destinationFields: z.array(DestinationFieldSchema),
    capabilities: CapabilitiesSchema,
  })
  .superRefine((d, ctx) => {
    const c = d.capabilities;
    const takes = (part: (typeof PACKAGE_PARTS)[number]) => c.accepts.includes(part);
    if (takes('document') && d.contractVersion < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'accepts'],
        message: 'accepting document needs contractVersion 2 or later',
      });
    }
    if (c.administration && d.contractVersion < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'administration'],
        message: 'administration needs contractVersion 3',
      });
    }
    if (!c.decomposedDocuments) return;
    if (d.contractVersion < 2 || !c.readBack || !takes('document') || !takes('images')) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'decomposedDocuments'],
        message:
          'decomposedDocuments needs contractVersion 2, readBack, and accepts document and images',
      });
    }
  });
export type SinkDescribe = z.infer<typeof SinkDescribeSchema>;

/** What a sink lets a producer administer, or null for a sink that doesn't declare it. */
export function administrationOf(
  d: Pick<SinkDescribe, 'contractVersion' | 'capabilities'>,
): Administration | null {
  return d.contractVersion >= 3 ? (d.capabilities.administration ?? null) : null;
}

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

/** One component of a document in the target, at the version the target holds. */
export const ComponentVersionSchema = z.strictObject({
  kind: z.string(),
  id: z.string(),
  version: z.string(),
  element: z.string().nullable(),
});
export type ComponentVersion = z.infer<typeof ComponentVersionSchema>;

/**
 * Version 2: replace the document `persistentId` only if the target still holds every component
 * at its `expected` version; any changed or missing one refuses with `changed_in_target`.
 */
export const ConditionalUpdateSchema = z.strictObject({
  persistentId: z.string().min(1),
  expected: z.array(ComponentVersionSchema).min(1),
});
export type ConditionalUpdate = z.infer<typeof ConditionalUpdateSchema>;

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
  /**
   * Version 2, a delivered document: its persistent id, its components, and the read-back. For a
   * replayed idempotency key this is the receipt the first write under that key produced (the
   * same persistent id, the same component versions), never the document's current state.
   */
  document: z
    .strictObject({
      persistentId: z.string().min(1),
      components: z.array(ComponentVersionSchema),
      readBack: z.strictObject({
        ok: z.boolean(),
        at: z.string().nullable(),
        detail: z.string().nullable(),
      }),
    })
    .optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const SinkDeliverRequestSchema = z.strictObject({
  instanceId: z.string().nullable(),
  credential: CredentialSchema.nullable(),
  destination: DestinationSchema,
  /**
   * The same key means the same write. A sink writes at most once per key; a replayed key
   * (a retry, or a later run that reuses it) changes nothing and gets back the receipt of the
   * first write under that key: the same persistent id and the same component versions, never
   * the current state, which may hold a change made in the target since.
   */
  idempotencyKey: z.string(),
  actingUser: ActingUserSchema.nullable(),
  package: PackageSchema,
  update: ConditionalUpdateSchema.optional(),
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

/** How many deliveries an instance takes at once: its `lanes`, else 1 (also for an unknown one). */
export function lanesOf(d: { instances: readonly Instance[] }, instanceId: string): number {
  return d.instances.find((i) => i.id === instanceId)?.lanes ?? 1;
}
