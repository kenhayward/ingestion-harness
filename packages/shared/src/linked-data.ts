import { z } from 'zod';

/**
 * Linked data settings (ADR 0011): the deployment's customer and the base IRI its RDF is minted
 * under. One customer per deployment; the base defaults to our identifier domain.
 */

/** Where IRIs live when the customer has not given their own base. */
export const FALLBACK_BASE_IRI = 'https://id.stocks-hayward.com/';

export const CUSTOMER_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const LinkedDataSettingsSchema = z.object({
  customerName: z.string(),
  customerSlug: z.string().nullable(),
  /** The customer's own base; null: the fallback under FALLBACK_BASE_IRI. */
  baseIri: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type LinkedDataSettings = z.infer<typeof LinkedDataSettingsSchema>;

export const LinkedDataHistoryEntrySchema = z.object({
  fromBase: z.string().nullable(),
  toBase: z.string().nullable(),
  changedBy: z.string().nullable(),
  changedAt: z.string(),
  /** RDF outputs published under `fromBase` when it changed. */
  rdfPublished: z.number().int(),
});
export type LinkedDataHistoryEntry = z.infer<typeof LinkedDataHistoryEntrySchema>;

/** The graphs published to the triple store (ADR 0011 step 6, `published_graphs`). */
export const LinkedDataGraphsSchema = z.object({
  /** Current graphs minted under the current base. */
  published: z.number().int(),
  lastPublishedAt: z.string().nullable(),
  /** Whether the newest publish reached Fuseki (false: S3 only); null before any publish. */
  endpoint: z.boolean().nullable(),
});
export type LinkedDataGraphs = z.infer<typeof LinkedDataGraphsSchema>;

export const LinkedDataViewSchema = z.object({
  settings: LinkedDataSettingsSchema,
  /** Null: RDF is skipped until a customer or base is set. */
  effectiveBase: z.string().nullable(),
  /** RDF outputs published under the current base. */
  rdfPublished: z.number().int(),
  graphs: LinkedDataGraphsSchema,
  /** Newest first. */
  history: z.array(LinkedDataHistoryEntrySchema),
});
export type LinkedDataView = z.infer<typeof LinkedDataViewSchema>;

export const LinkedDataBodySchema = z
  .object({
    customerName: z.string().trim().min(1).max(200),
    customerSlug: z.string().regex(CUSTOMER_SLUG_RE),
    baseIri: z.string().trim().min(1).nullable(),
    /** The new effective base, repeated: needed once RDF was published under the old one. */
    confirm: z.string().optional(),
  })
  .strict();
export type LinkedDataBody = z.infer<typeof LinkedDataBodySchema>;

/** The base IRI RDF is minted under; mirrors `linked_data.effective_base_iri` in the worker. */
export function effectiveBaseIri(s: {
  customerSlug: string | null;
  baseIri: string | null;
}): string | null {
  if (s.baseIri) return s.baseIri;
  return s.customerSlug ? `${FALLBACK_BASE_IRI}${s.customerSlug}/` : null;
}

const LOCAL_SUFFIXES = ['.local', '.test', '.internal', '.localhost'];

/** Characters an IRI cannot carry unescaped (RFC 3987): Turtle refuses them. */
export const IRI_UNSAFE = /[\s<>"{}|\\^`]/;

/** Why a base IRI cannot be used, or null. */
export function baseIriProblem(iri: string): string | null {
  let url: URL;
  try {
    url = new URL(iri);
  } catch {
    return 'the base IRI is not a URL';
  }
  if (url.protocol !== 'https:') return 'the base IRI must use https';
  if (url.username || url.password) return 'the base IRI cannot carry a user name or password';
  if (url.search || url.hash || iri.includes('?') || iri.includes('#')) {
    return 'the base IRI cannot have a query or a fragment';
  }
  const host = url.hostname.toLowerCase();
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) {
    return 'the base IRI must use a host name, not an address';
  }
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'the base IRI cannot use a local host name';
  }
  if (IRI_UNSAFE.test(iri)) return 'the base IRI has characters an IRI cannot carry';
  if (!iri.endsWith('/')) return 'the base IRI must end with /';
  if (url.href !== iri) {
    return 'the base IRI must be written as browsers write it (a lower-case host)';
  }
  if (iri.length > 200) return 'the base IRI must be at most 200 characters';
  return null;
}

const WARNING_WORDS = /^(staging|test|dev|fuseki|sparql|ct-studio|v\d+(\.\d+)*)$/i;

/** Words in a base IRI that tie identifiers to an environment, a product or a version. */
export function baseIriWarnings(iri: string): string[] {
  let url: URL;
  try {
    url = new URL(iri);
  } catch {
    return [];
  }
  const words = [...url.hostname.split('.'), ...url.pathname.split('/')].filter(Boolean);
  return words.filter((w) => WARNING_WORDS.test(w));
}
