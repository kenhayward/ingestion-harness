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

const MEDIA_EXTENSIONS: Record<string, string> = {
  'text/turtle': 'ttl',
  'application/rdf+xml': 'rdf',
  'application/ld+json': 'jsonld',
  'application/n-triples': 'nt',
  'text/n3': 'n3',
};

/**
 * The extension a version's file is stored under: its name's, else its content type's, else
 * `ttl`. Mirrors `ontology.source_extension` in the worker (shared fixture ontology-url.json).
 */
export function ontologySourceExtension(fileName: string, mediaType: string): string {
  return ontologyFormat(fileName)?.ext ?? MEDIA_EXTENSIONS[mediaType] ?? 'ttl';
}

export const ONTOLOGY_STATUSES = ['queued', 'parsing', 'ready', 'failed'] as const;

/**
 * upload: a file; url: fetched by the worker (rollout step 2); import: pulled in by owl:imports;
 * files: a folder or zip merged into one version (`sourceFiles`).
 */
export const ONTOLOGY_SOURCE_KINDS = ['upload', 'url', 'import', 'files'] as const;

/** Ontology files one folder or zip import may carry. */
export const ONTOLOGY_MAX_FILES = 300;

/**
 * Library ids for a folder imported as one ontology per file: the prefix and the file's stem as a
 * slug, within ONTOLOGY_ID_RE, `-2`, `-3`… on collisions. The web previews them; the API decides.
 */
export function fileOntologyIds(paths: readonly string[], prefix: string): string[] {
  const used = new Set<string>();
  return paths.map((path) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    const stem = name.replace(/\.[^.]*$/, '');
    const slug =
      stem
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'ontology';
    let base = `${prefix}${slug}`;
    if (base.length < 2) base = `${base}-ontology`;
    base = base.slice(0, 63).replace(/-+$/, '');
    let id = base;
    for (let n = 2; used.has(id); n++) {
      const suffix = `-${n}`;
      id = `${base.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
    }
    used.add(id);
    return id;
  });
}

export const OntologyImportSchema = z.object({
  iri: z.string(),
  /**
   * library: an existing ready version; fetched: imported now into the library; included: one
   * of the files of this (folder) version declares it.
   */
  resolution: z.enum(['unresolved', 'library', 'fetched', 'included']),
  ontologyId: z.string().nullable(),
  version: z.number().int().nullable(),
  /** Why an import is unresolved. */
  reason: z.string().nullable(),
});
export type OntologyImport = z.infer<typeof OntologyImportSchema>;
export type OntologyStatus = (typeof ONTOLOGY_STATUSES)[number];

export const OntologyStatsSchema = z.object({
  triples: z.number().int(),
  classes: z.number().int(),
  properties: z.number().int(),
  concepts: z.number().int(),
  schemes: z.number().int(),
  shapes: z.number().int(),
  /** Terms indexed from the version's imports (not counted above). */
  imported: z.number().int(),
});
export type OntologyStats = z.infer<typeof OntologyStatsSchema>;

export const OntologyVersionViewSchema = z.object({
  ontologyId: z.string(),
  version: z.number().int(),
  status: z.enum(ONTOLOGY_STATUSES),
  fileName: z.string(),
  mediaType: z.string(),
  /** Null for a URL version until the worker has fetched it. */
  sha256: z.string().nullable(),
  bytes: z.number().int().nullable(),
  sourceKind: z.enum(ONTOLOGY_SOURCE_KINDS),
  sourceUrl: z.string().nullable(),
  /** A `files` version's files (paths as uploaded); null otherwise. */
  sourceFiles: z
    .array(z.object({ fileName: z.string(), sha256: z.string(), bytes: z.number().int() }))
    .nullable(),
  ontologyIri: z.string().nullable(),
  versionIri: z.string().nullable(),
  license: z.string().nullable(),
  kinds: z.array(z.enum(['owl', 'skos', 'shacl'])),
  stats: OntologyStatsSchema.nullable(),
  /** The file's `owl:imports` and how each was resolved. */
  imports: z.array(OntologyImportSchema),
  error: z.string().nullable(),
  importedBy: z.string().nullable(),
  importedAt: z.string(),
});
export type OntologyVersionView = z.infer<typeof OntologyVersionViewSchema>;

/** `POST /api/ontologies/batch`: the versions queued, and the files left out (duplicates). */
export const OntologyBatchResultSchema = z.object({
  versions: z.array(OntologyVersionViewSchema),
  skipped: z.array(z.object({ fileName: z.string(), ontologyId: z.string(), reason: z.string() })),
});
export type OntologyBatchResult = z.infer<typeof OntologyBatchResultSchema>;

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
  /** "<ontologyId>@<version>" for a term indexed from an import; null for the version's own. */
  definedIn: z.string().nullable(),
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

/** A host on the allowlist: exact, or `.example.org` for the domain and its subdomains. */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith('.') ? h === e.slice(1) || h.endsWith(e) : h === e;
  });
}

/** Why a URL cannot be imported, or null. Mirrors `ontology_fetch` in the worker. */
export function ontologyUrlProblem(url: string, hosts: readonly string[]): string | null {
  if (!hosts.some((h) => h.trim())) return 'URL imports are off: set ONTOLOGY_FETCH_ALLOW';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return 'only https URLs can be imported';
  return hostAllowed(parsed.hostname, hosts)
    ? null
    : `${parsed.hostname} is not on ONTOLOGY_FETCH_ALLOW`;
}

/** The file name a fetched ontology is stored under: the URL's last path segment, else its host. */
export function ontologyFileNameFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : u.hostname;
}

/** What the import dialog needs to know about URL imports (GET /api/ontology-settings). */
export const OntologySettingsSchema = z.object({
  fetchHosts: z.array(z.string()),
  maxBytes: z.number().int(),
});
export type OntologySettings = z.infer<typeof OntologySettingsSchema>;

export const OntologyFromUrlBodySchema = z
  .object({
    id: z.string().regex(ONTOLOGY_ID_RE),
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().regex(TAG_RE)).max(20).optional(),
    localOnly: z.boolean().optional(),
    url: z.string().min(1).max(2000),
  })
  .strict();
export type OntologyFromUrlBody = z.infer<typeof OntologyFromUrlBodySchema>;

export const GRAPH_EDGE_KINDS = [
  'subClassOf',
  'subPropertyOf',
  'broader',
  'inScheme',
  'domain',
  'range',
  'targets',
] as const;
export const GraphNodeSchema = z.object({
  iri: z.string(),
  label: z.string(),
  /** external: an IRI the version names but does not define. */
  kind: z.union([OntologyTermKindSchema, z.literal('external')]),
  focus: z.boolean(),
});
export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum(GRAPH_EDGE_KINDS),
});
export const NeighbourhoodSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type Neighbourhood = z.infer<typeof NeighbourhoodSchema>;
export const NeighbourhoodQuerySchema = z.object({
  iri: z.string().min(1).max(2000),
  depth: z.coerce.number().int().min(1).max(2).default(1),
});
/** Nodes in one neighbourhood at most; past it `truncated` is true. */
export const NEIGHBOURHOOD_LIMIT = 150;
