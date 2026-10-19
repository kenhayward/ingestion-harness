import { z } from 'zod';

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

/** The CT Studio user a delivery acts as. */
export const ActingUserSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().email().nullable(),
});
export type ActingUser = z.infer<typeof ActingUserSchema>;

/** Where a document's publication came from. */
export const ProvenanceSchema = z.strictObject({
  sourceSha256: SHA256,
  sourceFilename: z.string(),
  jobId: z.string(),
  recipeId: z.string(),
  recipeVersion: z.number().int().positive(),
  approver: ActingUserSchema.nullable(),
  extractedAt: z.string().datetime().nullable(),
  publishedAt: z.string().datetime(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** One rendered output; `name` is its path relative to the target (a file sink adds its prefix). */
export const PackageFileSchema = z.strictObject({
  output: z.string().min(1),
  format: z.string(),
  contentType: z.string(),
  name: z.string().min(1),
  content: z.string().base64(),
});
export type PackageFile = z.infer<typeof PackageFileSchema>;

export const DataFieldSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  type: z.string(),
  value: z.unknown(),
  unit: z.string().nullable(),
});

export const DataTableSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  columns: z.array(
    z.strictObject({ id: z.string(), title: z.string().nullable(), type: z.string() }),
  ),
  rows: z.array(z.record(z.string(), z.unknown())),
});

/** The fields and tables in structured form, for data-oriented sinks. */
export const PackageDataSchema = z.strictObject({
  fields: z.array(DataFieldSchema),
  tables: z.array(DataTableSchema),
});

export const PackageRdfSchema = z.strictObject({
  graphName: z.string().url(),
  version: z.number().int().positive(),
  turtle: z.string(),
});

/** Reserved for full decomposition: defined now, not yet filled by CT Studio. */
export const NarrativeBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('paragraph'), text: z.string() }),
  z.strictObject({ type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string()) }),
  z.strictObject({ type: z.literal('table'), tableId: z.string() }),
  z.strictObject({
    type: z.literal('figure'),
    imageId: z.string(),
    caption: z.string().nullable(),
  }),
]);

export const PackageImageSchema = z.strictObject({
  id: z.string(),
  contentType: z.string(),
  content: z.string().base64(),
});

/** One document's publication (or one graph), the same for every target. */
export const PackageSchema = z
  .strictObject({
    kind: z.enum(['document', 'graph']),
    contractVersion: z.literal(1),
    producer: z.strictObject({ name: z.string(), deployment: z.string() }),
    idempotencyKey: SHA256,
    provenance: ProvenanceSchema.nullable(),
    naming: z.record(z.string(), z.string()),
    files: z.array(PackageFileSchema),
    data: PackageDataSchema.nullable(),
    rdf: PackageRdfSchema.nullable(),
    narrative: z.array(NarrativeBlockSchema).nullable(),
    images: z.array(PackageImageSchema).nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'document' && p.provenance === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'a document needs provenance',
      });
    }
    const seen = new Set<string>();
    p.files.forEach((f, i) => {
      if (seen.has(f.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'name'],
          message: 'duplicate file name',
        });
      }
      seen.add(f.name);
    });
  });
export type BridgePackage = z.infer<typeof PackageSchema>;

export const PACKAGE_PARTS = ['files', 'data', 'rdf', 'narrative', 'images'] as const;
export type PackagePart = (typeof PACKAGE_PARTS)[number];

/** The parts this package actually carries. */
export function partsOf(p: BridgePackage): PackagePart[] {
  const parts: PackagePart[] = [];
  if (p.files.length) parts.push('files');
  if (p.data) parts.push('data');
  if (p.rdf) parts.push('rdf');
  if (p.narrative?.length) parts.push('narrative');
  if (p.images?.length) parts.push('images');
  return parts;
}
