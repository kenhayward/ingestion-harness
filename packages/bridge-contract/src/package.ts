import { z } from 'zod';
import { DecomposedDocumentSchema } from './decomposed/model.js';

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The contract versions: 1, and 2 (version 1 plus the `document` part, decomposition provenance,
 * a conditional update and a document receipt). A version 1 package is valid version 2.
 */
export const ContractVersion = z.union([z.literal(1), z.literal(2)]);
export type ContractVersion = z.infer<typeof ContractVersion>;

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
/** The extraction variant of a package's provenance (version 1's only one). */
export type ExtractionProvenance = Provenance;

/** Where a decomposed document came from (version 2): one source, decomposed and published. */
export const DecompositionProvenanceSchema = z.strictObject({
  kind: z.literal('decomposition'),
  sourceSha256: SHA256,
  sourceFilename: z.string(),
  sourceKey: z.string().min(1),
  batchId: z.string().nullable(),
  decomposerVersion: z.number().int().positive(),
  startedBy: ActingUserSchema,
  decomposedAt: z.string().datetime(),
  publishedAt: z.string().datetime(),
});
export type DecompositionProvenance = z.infer<typeof DecompositionProvenanceSchema>;

/** An extraction's provenance (version 1's shape, unchanged) or a decomposition's. */
export const AnyProvenanceSchema = z.union([ProvenanceSchema, DecompositionProvenanceSchema]);
export type AnyProvenance = z.infer<typeof AnyProvenanceSchema>;

/** Whether a package's provenance is a decomposition's. */
export function isDecompositionProvenance(
  p: AnyProvenance | null | undefined,
): p is DecompositionProvenance {
  return p != null && 'kind' in p && p.kind === 'decomposition';
}

/** Whether a package's provenance is an extraction's (the version 1 shape). */
export function isExtractionProvenance(
  p: AnyProvenance | null | undefined,
): p is ExtractionProvenance {
  return p != null && !('kind' in p);
}

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

/** Reserved and unused: a package with a `document` (version 2) carries `narrative: null`. */
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
    contractVersion: ContractVersion,
    producer: z.strictObject({ name: z.string(), deployment: z.string() }),
    idempotencyKey: SHA256,
    provenance: AnyProvenanceSchema.nullable(),
    naming: z.record(z.string(), z.string()),
    files: z.array(PackageFileSchema),
    data: PackageDataSchema.nullable(),
    rdf: PackageRdfSchema.nullable(),
    narrative: z.array(NarrativeBlockSchema).nullable(),
    images: z.array(PackageImageSchema).nullable(),
    /** Version 2: the decomposed document. Its images' bytes travel in `images`. */
    document: DecomposedDocumentSchema.nullable().optional(),
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
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const decomposition = isDecompositionProvenance(p.provenance);
    if (!p.document) {
      if (decomposition) issue(['provenance'], 'decomposition provenance needs a document');
      return;
    }
    if (p.contractVersion !== 2) issue(['document'], 'a document needs contractVersion 2');
    if (p.files.length) issue(['files'], 'a package with a document carries no files');
    if (p.data !== null) issue(['data'], 'a package with a document carries no data');
    if (p.rdf !== null) issue(['rdf'], 'a package with a document carries no rdf');
    if (p.narrative !== null) {
      issue(['narrative'], 'a package with a document carries no narrative');
    }
    if (!decomposition) issue(['provenance'], 'a document needs decomposition provenance');
    const carried = new Set((p.images ?? []).map((i) => i.id));
    const referenced = new Set(p.document.images.map((i) => i.id));
    p.document.images.forEach((img, i) => {
      if (!carried.has(img.id)) {
        issue(['document', 'images', i, 'id'], 'an image of the document is not in images');
      }
    });
    (p.images ?? []).forEach((img, i) => {
      if (!referenced.has(img.id)) issue(['images', i, 'id'], 'an image not in the document');
    });
  });
export type BridgePackage = z.infer<typeof PackageSchema>;

export const PACKAGE_PARTS = ['files', 'data', 'rdf', 'narrative', 'images', 'document'] as const;
export type PackagePart = (typeof PACKAGE_PARTS)[number];

/** The parts this package actually carries. */
export function partsOf(p: BridgePackage): PackagePart[] {
  const parts: PackagePart[] = [];
  if (p.files.length) parts.push('files');
  if (p.data) parts.push('data');
  if (p.rdf) parts.push('rdf');
  if (p.narrative?.length) parts.push('narrative');
  if (p.images?.length) parts.push('images');
  if (p.document) parts.push('document');
  return parts;
}

/**
 * The package layout (an S3 target archiving whole packages): everything under
 * `{prefix}packages/{idempotencyKey}/`. Each file's bytes at `files/<name>`, the `data` part at
 * `data.json`, the graph's Turtle at `graph.ttl`, the decomposed document at `document.json`,
 * images at `images/<id>`, and `package.json` (the package with every byte taken out, pointing at
 * those paths) last, so a reader that finds it finds every part. The same key delivered again overwrites the same objects.
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
  contractVersion: ContractVersion,
  producer: z.strictObject({ name: z.string(), deployment: z.string() }),
  idempotencyKey: SHA256,
  provenance: AnyProvenanceSchema.nullable(),
  naming: z.record(z.string(), z.string()),
  files: z.array(ArchivedFileSchema),
  data: z.strictObject({ path: z.string().min(1) }).nullable(),
  rdf: PackageRdfSchema.omit({ turtle: true })
    .extend({ path: z.string().min(1) })
    .nullable(),
  narrative: z.array(NarrativeBlockSchema).nullable(),
  images: z.array(ArchivedImageSchema).nullable(),
  document: z
    .strictObject({ path: z.string().min(1) })
    .nullable()
    .optional(),
});
export type ArchivedPackage = z.infer<typeof ArchivedPackageSchema>;

const filePath = (f: { name: string }) => `files/${f.name}`;
const imagePath = (i: { id: string }) => `images/${i.id}`;
const DOCUMENT_PATH = 'document.json';

/** The archive's `package.json` for a package. */
export function archivedPackageOf(p: BridgePackage): ArchivedPackage {
  const { document, ...rest } = p;
  return {
    ...rest,
    files: p.files.map(({ content: _content, ...f }) => ({ ...f, path: filePath(f) })),
    data: p.data ? { path: 'data.json' } : null,
    rdf: p.rdf ? { graphName: p.rdf.graphName, version: p.rdf.version, path: 'graph.ttl' } : null,
    images: p.images
      ? p.images.map(({ content: _content, ...i }) => ({ ...i, path: imagePath(i) }))
      : null,
    // A package without the key (every version 1 package) archives without it, as before.
    ...(document !== undefined ? { document: document ? { path: DOCUMENT_PATH } : null } : {}),
  };
}

/**
 * Every key a package-layout target writes for a package, in write order (`package.json` last),
 * with the output id CT Studio records it under: a file's own output id, else `package:data`,
 * `package:graph`, `package:document`, `package:image:<id>` and `package:manifest` (never a
 * recipe's output id).
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
    ...(p.document ? [{ outputId: 'package:document', key: at(DOCUMENT_PATH) }] : []),
    ...(p.images ?? []).map((i) => ({ outputId: `package:image:${i.id}`, key: at(imagePath(i)) })),
    { outputId: 'package:manifest', key: at(ARCHIVE_MANIFEST) },
  ];
}
