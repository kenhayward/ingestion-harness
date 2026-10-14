import { z } from 'zod';

/** Ontology library (ADR 0011, docs/design/rdf-publishing.md). */

/** Library ids: what briefs and recipes will pin as `{ id, version }`. */
export const ONTOLOGY_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Tags such as `industry:pharma` or `customer:acme`. */
export const TAG_RE = /^[a-z0-9][a-z0-9:._-]{0,62}$/;

export const ONTOLOGY_TERM_KINDS = [
  'class',
  'object_property',
  'datatype_property',
  'annotation_property',
  'concept',
  'scheme',
  'shape',
] as const;
export const OntologyTermKindSchema = z.enum(ONTOLOGY_TERM_KINDS);
export type OntologyTermKind = z.infer<typeof OntologyTermKindSchema>;

/**
 * The browser's tabs. A top concept's parent is its scheme, so concepts and schemes share one
 * tree.
 */
export const TERM_GROUPS = {
  classes: ['class'],
  properties: ['object_property', 'datatype_property', 'annotation_property'],
  concepts: ['scheme', 'concept'],
  shapes: ['shape'],
} as const satisfies Record<string, readonly OntologyTermKind[]>;
export const TermGroupSchema = z.enum(['classes', 'properties', 'concepts', 'shapes']);
export type TermGroup = z.infer<typeof TermGroupSchema>;

/** Upload formats by extension: browsers send unreliable content types for RDF files. */
const FORMATS: Record<string, string> = {
  ttl: 'text/turtle',
  owl: 'application/rdf+xml',
  rdf: 'application/rdf+xml',
  jsonld: 'application/ld+json',
  nt: 'application/n-triples',
  n3: 'text/n3',
};
export const ONTOLOGY_ACCEPT = Object.keys(FORMATS)
  .map((ext) => `.${ext}`)
  .join(',');

export function ontologyFormat(fileName: string): { ext: string; mediaType: string } | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const mediaType = ext === undefined ? undefined : FORMATS[ext];
  return ext !== undefined && mediaType !== undefined ? { ext, mediaType } : null;
}

export const ONTOLOGY_STATUSES = ['queued', 'parsing', 'ready', 'failed'] as const;
export type OntologyStatus = (typeof ONTOLOGY_STATUSES)[number];

export const OntologyStatsSchema = z.object({
  triples: z.number().int(),
  classes: z.number().int(),
  properties: z.number().int(),
  concepts: z.number().int(),
  schemes: z.number().int(),
  shapes: z.number().int(),
});
export type OntologyStats = z.infer<typeof OntologyStatsSchema>;

export const OntologyVersionViewSchema = z.object({
  ontologyId: z.string(),
  version: z.number().int(),
  status: z.enum(ONTOLOGY_STATUSES),
  fileName: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
  ontologyIri: z.string().nullable(),
  versionIri: z.string().nullable(),
  license: z.string().nullable(),
  kinds: z.array(z.enum(['owl', 'skos', 'shacl'])),
  stats: OntologyStatsSchema.nullable(),
  /** `owl:imports` of the file; resolving them against the library is rollout step 2. */
  imports: z.array(z.object({ iri: z.string(), resolution: z.literal('unresolved') })),
  error: z.string().nullable(),
  importedBy: z.string().nullable(),
  importedAt: z.string(),
});
export type OntologyVersionView = z.infer<typeof OntologyVersionViewSchema>;

export const OntologySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  localOnly: z.boolean(),
  retiredAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** The newest version, whatever its status. */
  latest: OntologyVersionViewSchema.nullable(),
  versionCount: z.number().int(),
});
export type OntologySummary = z.infer<typeof OntologySummarySchema>;

export const OntologyDetailSchema = OntologySummarySchema.extend({
  /** Newest first. */
  versions: z.array(OntologyVersionViewSchema),
});
export type OntologyDetail = z.infer<typeof OntologyDetailSchema>;

export const OntologyPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().regex(TAG_RE)).max(20).optional(),
    localOnly: z.boolean().optional(),
    retired: z.boolean().optional(),
  })
  .strict();
export type OntologyPatch = z.infer<typeof OntologyPatchSchema>;

export const OntologyTermSchema = z.object({
  iri: z.string(),
  kind: OntologyTermKindSchema,
  label: z.string(),
  altLabels: z.array(z.string()),
  definition: z.string(),
  /** Superclasses, superproperties, broader concepts; a top concept's scheme. */
  parents: z.array(z.string()),
  /** Property domains; a shape's target classes. */
  domain: z.array(z.string()),
  range: z.array(z.string()),
  scheme: z.string().nullable(),
  deprecated: z.boolean(),
  childCount: z.number().int(),
});
export type OntologyTerm = z.infer<typeof OntologyTermSchema>;

export const TermRefSchema = z.object({
  iri: z.string(),
  kind: OntologyTermKindSchema,
  label: z.string(),
});
export type TermRef = z.infer<typeof TermRefSchema>;

export const TermPageSchema = z.object({
  items: z.array(OntologyTermSchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});
export type TermPage = z.infer<typeof TermPageSchema>;

export const TermDetailSchema = OntologyTermSchema.extend({
  /** Only terms of this version; `parents` keeps every IRI. */
  parentTerms: z.array(TermRefSchema),
  children: z.array(TermRefSchema),
  domainTerms: z.array(TermRefSchema),
  rangeTerms: z.array(TermRefSchema),
  schemeTerm: TermRefSchema.nullable(),
  /** Properties whose domain or range is this class. */
  asDomain: z.array(TermRefSchema),
  asRange: z.array(TermRefSchema),
  /** A scheme's concepts. */
  concepts: z.array(TermRefSchema),
  /** Shapes targeting this class. */
  shapes: z.array(TermRefSchema),
});
export type TermDetail = z.infer<typeof TermDetailSchema>;

export const TermQuerySchema = z.object({
  group: TermGroupSchema.optional(),
  q: z.string().trim().max(200).optional(),
  parent: z.string().max(2000).optional(),
  root: z.enum(['1', 'true']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Job event when a version is indexed; mirrors `ontology.ONTOLOGY_INDEXED` in the worker. */
export const ONTOLOGY_INDEXED_EVENT = 'ontology indexed';
