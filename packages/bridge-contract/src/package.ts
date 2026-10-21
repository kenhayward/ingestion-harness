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

/**
 * The package layout (an S3 target archiving whole packages): everything under
 * `{prefix}packages/{idempotencyKey}/`. Each file's bytes at `files/<name>`, the `data` part at
 * `data.json`, the graph's Turtle at `graph.ttl`, images at `images/<id>`, and `package.json` (the
 * package with every byte taken out, pointing at those paths) last, so a reader that finds it
 * finds every part. The same key delivered again overwrites the same objects.
 */
export const ARCHIVE_MANIFEST = 'package.json';

const ArchivedFileSchema = PackageFileSchema.omit({ content: true }).extend({
  path: z.string().min(1),
});
const ArchivedImageSchema = PackageImageSchema.omit({ content: true }).extend({
  path: z.string().min(1),
});

/** `package.json` of an archive: the package without its bytes, each part by its path. */
export const ArchivedPackageSchema = z.strictObject({
  kind: z.enum(['document', 'graph']),
  contractVersion: z.literal(1),
  producer: z.strictObject({ name: z.string(), deployment: z.string() }),
  idempotencyKey: SHA256,
  provenance: ProvenanceSchema.nullable(),
  naming: z.record(z.string(), z.string()),
  files: z.array(ArchivedFileSchema),
  data: z.strictObject({ path: z.string().min(1) }).nullable(),
  rdf: PackageRdfSchema.omit({ turtle: true })
    .extend({ path: z.string().min(1) })
    .nullable(),
  narrative: z.array(NarrativeBlockSchema).nullable(),
  images: z.array(ArchivedImageSchema).nullable(),
});
export type ArchivedPackage = z.infer<typeof ArchivedPackageSchema>;

const filePath = (f: { name: string }) => `files/${f.name}`;
const imagePath = (i: { id: string }) => `images/${i.id}`;

/** The archive's `package.json` for a package. */
export function archivedPackageOf(p: BridgePackage): ArchivedPackage {
  return {
    ...p,
    files: p.files.map(({ content: _content, ...f }) => ({ ...f, path: filePath(f) })),
    data: p.data ? { path: 'data.json' } : null,
    rdf: p.rdf ? { graphName: p.rdf.graphName, version: p.rdf.version, path: 'graph.ttl' } : null,
    images: p.images
      ? p.images.map(({ content: _content, ...i }) => ({ ...i, path: imagePath(i) }))
      : null,
  };
}

/**
 * Every key a package-layout target writes for a package, in write order (`package.json` last),
 * with the output id CT Studio records it under: a file's own output id, else `package:data`,
 * `package:graph`, `package:image:<id>` and `package:manifest` (never a recipe's output id).
 */
export function packageArchiveKeys(
  prefix: string,
  p: BridgePackage,
): { outputId: string; key: string }[] {
  const at = (path: string) => `${prefix}packages/${p.idempotencyKey}/${path}`;
  return [
    ...p.files.map((f) => ({ outputId: f.output, key: at(filePath(f)) })),
    ...(p.data ? [{ outputId: 'package:data', key: at('data.json') }] : []),
    ...(p.rdf ? [{ outputId: 'package:graph', key: at('graph.ttl') }] : []),
    ...(p.images ?? []).map((i) => ({ outputId: `package:image:${i.id}`, key: at(imagePath(i)) })),
    { outputId: 'package:manifest', key: at(ARCHIVE_MANIFEST) },
  ];
}
