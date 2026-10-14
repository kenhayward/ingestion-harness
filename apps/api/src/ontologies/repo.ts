import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  TERM_GROUPS,
  type OntologyDetail,
  type OntologyImport,
  type OntologyStats,
  type OntologyPatch,
  type OntologySummary,
  type OntologyTerm,
  type OntologyTermKind,
  type OntologyVersionView,
  type TermDetail,
  type TermGroup,
  type TermPage,
  type TermRef,
} from '@ih/shared';

/** The ontology library (ADR 0011, migration 0032): versions, their import jobs and terms. */

/** Like other Workbench jobs: ontology imports never delay production documents. */
export const ONTOLOGY_PRIORITY = -10;

/** Neighbour lists in a term detail are capped; the tree pages the rest. */
export const DETAIL_LIMIT = 200;

export interface NewOntologyVersion {
  ontologyId: string;
  /** Required when the ontology is new; ignored when it exists. */
  meta: { label: string; description: string; tags: string[]; localOnly: boolean } | null;
  fileName: string;
  /** '' for a URL version: the worker learns it from the response. */
  mediaType: string;
  /** An uploaded file already in the runs bucket, or a URL the worker fetches. */
  source:
    | { kind: 'upload'; sourceKey: string; sha256: string; bytes: number }
    | { kind: 'url'; url: string };
  by: string | null;
}

export type CreateVersionResult =
  | { ok: true; version: OntologyVersionView; jobId: string }
  | { ok: false; reason: 'needs-label' }
  | { ok: false; reason: 'duplicate'; version: number };

export interface TermQuery {
  group?: TermGroup;
  q?: string;
  parent?: string;
  root?: boolean;
  offset: number;
  limit: number;
}

export type DeleteVersionResult =
  | { result: 'deleted'; sha256: string | null; fileName: string; mediaType: string }
  | { result: 'missing' }
  | { result: 'busy' };

export interface OntologyRepo {
  list(opts: { retired: boolean }): Promise<OntologySummary[]>;
  get(id: string): Promise<OntologyDetail | null>;
  /** The version row and its `ontology` job, in one transaction. */
  createVersion(input: NewOntologyVersion): Promise<CreateVersionResult>;
  update(id: string, patch: OntologyPatch): Promise<OntologySummary | null>;
  /** 'busy' while queued or parsing; deleting the last version deletes the ontology. */
  deleteVersion(id: string, version: number): Promise<DeleteVersionResult>;
  terms(id: string, version: number, query: TermQuery): Promise<TermPage | null>;
  term(id: string, version: number, iri: string): Promise<TermDetail | null>;
  /**
   * The kinds each IRI has in any of `versions` (their imports included: they are indexed with
   * the version), for checking a recipe's mapping in one query; IRIs found nowhere are absent.
   */
  termKinds(
    versions: { id: string; version: number }[],
    iris: string[],
  ): Promise<Record<string, OntologyTermKind[]>>;
  /**
   * Rows whose IRI is in `iris`, or whose parents, domains, ranges or scheme name one of
   * them, by label, at most `limit` (the graph view's hops); null for an unknown version.
   */
  neighbours(
    id: string,
    version: number,
    iris: string[],
    limit: number,
  ): Promise<OntologyTerm[] | null>;
}

/** What a version whose import job ended without finishing it reads as. */
export const STOPPED_IMPORT = 'the import stopped before it finished';

/** Job statuses in which an import may still finish its version. */
const ACTIVE_JOB = ['queued', 'running'];

/** The `ontology` job's params, read by the worker's OntologyJobParams. */
const jobParams = (input: NewOntologyVersion, version: number) => ({
  ontologyId: input.ontologyId,
  version,
  ...(input.source.kind === 'upload'
    ? { sourceKey: input.source.sourceKey }
    : { sourceUrl: input.source.url }),
  fileName: input.fileName,
  mediaType: input.mediaType,
});

/** The bytes a version starts with: none for a URL version until it is fetched. */
const sourceFields = (input: NewOntologyVersion) =>
  input.source.kind === 'upload'
    ? {
        sha256: input.source.sha256,
        bytes: input.source.bytes,
        sourceKind: 'upload' as const,
        sourceUrl: null,
      }
    : { sha256: null, bytes: null, sourceKind: 'url' as const, sourceUrl: input.source.url };

const KIND_ORDER: readonly OntologyTermKind[] = [
  'class',
  'object_property',
  'datatype_property',
  'annotation_property',
  'scheme',
  'concept',
  'shape',
];
const PROPERTY_KINDS: readonly string[] = TERM_GROUPS.properties;

const ref = (t: OntologyTerm): TermRef => ({ iri: t.iri, kind: t.kind, label: t.label });

const byLabel = (a: OntologyTerm, b: OntologyTerm) =>
  a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.iri.localeCompare(b.iri);

/** Builds a term's detail from the rows of its version that can be its neighbours. */
export function termDetail(all: readonly OntologyTerm[], iri: string): TermDetail | null {
  const own = all
    .filter((t) => t.iri === iri)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0];
  if (!own) return null;
  const byIri = new Map<string, OntologyTerm>();
  for (const t of all) if (!byIri.has(t.iri)) byIri.set(t.iri, t);
  const refs = (iris: readonly string[]) =>
    iris.flatMap((i) => {
      const t = byIri.get(i);
      return t ? [ref(t)] : [];
    });
  const pick = (keep: (t: OntologyTerm) => boolean) =>
    all.filter(keep).sort(byLabel).slice(0, DETAIL_LIMIT).map(ref);
  const isProperty = (t: OntologyTerm) => PROPERTY_KINDS.includes(t.kind);
  return {
    ...own,
    parentTerms: refs(own.parents),
    children: pick((t) => t.parents.includes(iri) && t.iri !== iri),
    domainTerms: refs(own.domain),
    rangeTerms: refs(own.range),
    schemeTerm: own.scheme ? (refs([own.scheme])[0] ?? null) : null,
    asDomain: pick((t) => isProperty(t) && t.domain.includes(iri)),
    asRange: pick((t) => isProperty(t) && t.range.includes(iri)),
    concepts: own.kind === 'scheme' ? pick((t) => t.kind === 'concept' && t.scheme === iri) : [],
    shapes: pick((t) => t.kind === 'shape' && t.domain.includes(iri)),
  };
}

/** Search ranking shared by the memory repo: exact label, label prefix, then the rest. */
function rank(q: string, t: OntologyTerm): number {
  const label = t.label.toLowerCase();
  return label === q ? 0 : label.startsWith(q) ? 1 : 2;
}

function matches(q: string, t: OntologyTerm): boolean {
  return [t.label, t.iri, ...t.altLabels].some((s) => s.toLowerCase().includes(q));
}

export type SeedTerm = Partial<OntologyTerm> & {
  iri: string;
  kind: OntologyTermKind;
  root?: boolean;
};
type StoredTerm = OntologyTerm & { root: boolean };

function publicTerm(t: StoredTerm): OntologyTerm {
  const { root, ...rest } = t;
  void root;
  return rest;
}

interface MemoryOntology extends Omit<OntologySummary, 'latest' | 'versionCount'> {
  /** Newest first. */
  versions: OntologyVersionView[];
}

export class MemoryOntologyRepo implements OntologyRepo {
  private readonly ontologies = new Map<string, MemoryOntology>();
  private readonly termsByVersion = new Map<string, StoredTerm[]>();
  /** The `ontology` jobs created, for assertions; tests move them on with `finishJob`. */
  readonly jobs: {
    id: string;
    params: Record<string, unknown>;
    createdBy: string | null;
    status: string;
    error: string | null;
  }[] = [];
  private readonly versionJobs = new Map<string, string>();

  /**
   * A version still queued or parsing whose job is no longer active never will finish (the
   * worker crashed or could not reach it): it reads as failed, so it can be deleted.
   */
  private effective(v: OntologyVersionView): OntologyVersionView {
    if (v.status !== 'queued' && v.status !== 'parsing') return v;
    const job = this.jobs.find(
      (j) => j.id === this.versionJobs.get(`${v.ontologyId}:${v.version}`),
    );
    if (job && ACTIVE_JOB.includes(job.status)) return v;
    return { ...v, status: 'failed', error: v.error ?? job?.error ?? STOPPED_IMPORT };
  }

  private summary(o: MemoryOntology): OntologySummary {
    const { versions, ...rest } = o;
    const latest = versions[0];
    return {
      ...rest,
      latest: latest ? this.effective(latest) : null,
      versionCount: versions.length,
    };
  }

  private version(id: string, version: number): OntologyVersionView | null {
    return this.ontologies.get(id)?.versions.find((v) => v.version === version) ?? null;
  }

  async list(opts: { retired: boolean }): Promise<OntologySummary[]> {
    return [...this.ontologies.values()]
      .filter((o) => opts.retired || o.retiredAt === null)
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
      .map((o) => this.summary(o));
  }

  async get(id: string): Promise<OntologyDetail | null> {
    const o = this.ontologies.get(id);
    return o ? { ...this.summary(o), versions: o.versions.map((v) => this.effective(v)) } : null;
  }

  async createVersion(input: NewOntologyVersion): Promise<CreateVersionResult> {
    let o = this.ontologies.get(input.ontologyId);
    if (!o) {
      if (!input.meta) return { ok: false, reason: 'needs-label' };
      o = {
        id: input.ontologyId,
        ...input.meta,
        retiredAt: null,
        createdBy: input.by,
        createdAt: new Date().toISOString(),
        versions: [],
      };
      this.ontologies.set(o.id, o);
    }
    const fields = sourceFields(input);
    const same = fields.sha256 && o.versions.find((v) => v.sha256 === fields.sha256);
    if (same) return { ok: false, reason: 'duplicate', version: same.version };
    const number = (o.versions[0]?.version ?? 0) + 1;
    const version: OntologyVersionView = {
      ontologyId: o.id,
      version: number,
      status: 'queued',
      fileName: input.fileName,
      mediaType: input.mediaType,
      ...fields,
      ontologyIri: null,
      versionIri: null,
      license: null,
      kinds: [],
      stats: null,
      imports: [],
      error: null,
      importedBy: input.by,
      importedAt: new Date().toISOString(),
    };
    o.versions.unshift(version);
    const jobId = randomUUID();
    this.jobs.push({
      id: jobId,
      params: jobParams(input, number),
      createdBy: input.by,
      status: 'queued',
      error: null,
    });
    this.versionJobs.set(`${o.id}:${number}`, jobId);
    return { ok: true, version, jobId };
  }

  async update(id: string, patch: OntologyPatch): Promise<OntologySummary | null> {
    const o = this.ontologies.get(id);
    if (!o) return null;
    if (patch.label !== undefined) o.label = patch.label;
    if (patch.description !== undefined) o.description = patch.description;
    if (patch.tags !== undefined) o.tags = patch.tags;
    if (patch.localOnly !== undefined) o.localOnly = patch.localOnly;
    if (patch.retired !== undefined) {
      o.retiredAt = patch.retired ? (o.retiredAt ?? new Date().toISOString()) : null;
    }
    return this.summary(o);
  }

  async deleteVersion(id: string, version: number): Promise<DeleteVersionResult> {
    const o = this.ontologies.get(id);
    const v = o?.versions.find((x) => x.version === version);
    if (!o || !v) return { result: 'missing' };
    const status = this.effective(v).status;
    if (status === 'queued' || status === 'parsing') return { result: 'busy' };
    o.versions = o.versions.filter((x) => x !== v);
    this.termsByVersion.delete(`${id}:${version}`);
    if (o.versions.length === 0) this.ontologies.delete(id);
    return { result: 'deleted', sha256: v.sha256, fileName: v.fileName, mediaType: v.mediaType };
  }

  async terms(id: string, version: number, query: TermQuery): Promise<TermPage | null> {
    if (!this.version(id, version)) return null;
    const kinds: readonly string[] | null = query.group ? TERM_GROUPS[query.group] : null;
    const q = query.q?.trim().toLowerCase() ?? '';
    const hits = (this.termsByVersion.get(`${id}:${version}`) ?? [])
      .filter((t) => !kinds || kinds.includes(t.kind))
      .filter((t) => !query.parent || t.parents.includes(query.parent))
      .filter((t) => !query.root || t.root)
      .filter((t) => !q || matches(q, t))
      .sort((a, b) => (q ? rank(q, a) - rank(q, b) : 0) || byLabel(a, b));
    return {
      items: hits.slice(query.offset, query.offset + query.limit).map(publicTerm),
      total: hits.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  async term(id: string, version: number, iri: string): Promise<TermDetail | null> {
    if (!this.version(id, version)) return null;
    return termDetail((this.termsByVersion.get(`${id}:${version}`) ?? []).map(publicTerm), iri);
  }

  async termKinds(
    versions: { id: string; version: number }[],
    iris: string[],
  ): Promise<Record<string, OntologyTermKind[]>> {
    const wanted = new Set(iris);
    const out: Record<string, OntologyTermKind[]> = {};
    for (const v of versions) {
      for (const t of this.termsByVersion.get(`${v.id}:${v.version}`) ?? []) {
        if (wanted.has(t.iri) && !(out[t.iri] ??= []).includes(t.kind)) out[t.iri]!.push(t.kind);
      }
    }
    return out;
  }

  async neighbours(
    id: string,
    version: number,
    iris: string[],
    limit: number,
  ): Promise<OntologyTerm[] | null> {
    if (!this.version(id, version)) return null;
    const wanted = new Set(iris);
    return (
      (this.termsByVersion.get(`${id}:${version}`) ?? [])
        .filter(
          (t) =>
            wanted.has(t.iri) ||
            [...t.parents, ...t.domain, ...t.range].some((x) => wanted.has(x)) ||
            (t.scheme !== null && wanted.has(t.scheme)),
        )
        // The rows asked for first: a hub's own row must survive the limit.
        .sort((a, b) => Number(wanted.has(b.iri)) - Number(wanted.has(a.iri)) || byLabel(a, b))
        .slice(0, limit)
        .map(publicTerm)
    );
  }

  /** Test seeder: the worker indexed the version. */
  markReady(id: string, version: number, extra: Partial<OntologyVersionView> = {}): void {
    Object.assign(this.version(id, version)!, { status: 'ready', kinds: ['owl'], ...extra });
  }

  /** Test seeder: the queue moved an import job on (claimed, failed, reaped…). */
  finishJob(jobId: string, status: string, error: string | null): void {
    Object.assign(
      this.jobs.find((j) => j.id === jobId)!,
      { status, error },
    );
  }

  /** Test seeder: the worker could not read the file. */
  markFailed(id: string, version: number, error: string): void {
    Object.assign(this.version(id, version)!, { status: 'failed', error });
  }

  /** Test seeder: the terms the worker would have indexed. */
  seedTerms(id: string, version: number, terms: SeedTerm[]): void {
    this.termsByVersion.set(
      `${id}:${version}`,
      terms.map((t) => ({
        label: t.iri,
        altLabels: [],
        definition: '',
        parents: [],
        domain: [],
        range: [],
        scheme: null,
        deprecated: false,
        childCount: 0,
        definedIn: null,
        root: false,
        ...t,
      })),
    );
  }
}

const RAW_VERSION_COLS = `ontology_id, version, status, file_name, media_type, sha256, bytes,
  source_kind, source_url, ontology_iri, version_iri, license, kinds, stats, imports, error,
  imported_by, imported_at`;

/** Unfinished while queued or parsing with no active job: then it reads as failed. */
const STOPPED = `(v.status IN ('queued', 'parsing') AND NOT EXISTS (
  SELECT 1 FROM jobs j WHERE j.id = v.job_id AND j.status IN ('queued', 'running')))`;

/** A version as read (alias `v`): the effective status of the memory repo's `effective`. */
const VERSION_COLS = `v.ontology_id, v.version,
  CASE WHEN ${STOPPED} THEN 'failed' ELSE v.status END AS status,
  v.file_name, v.media_type, v.sha256, v.bytes, v.source_kind, v.source_url,
  v.ontology_iri, v.version_iri, v.license,
  v.kinds, v.stats, v.imports,
  CASE WHEN ${STOPPED} THEN coalesce(v.error,
    (SELECT j.error FROM jobs j WHERE j.id = v.job_id), '${STOPPED_IMPORT}')
  ELSE v.error END AS error,
  v.imported_by, v.imported_at`;

interface VersionRow {
  ontology_id: string;
  version: number;
  status: OntologyVersionView['status'];
  file_name: string;
  media_type: string;
  sha256: string | null;
  bytes: string | number | null;
  source_kind: OntologyVersionView['sourceKind'];
  source_url: string | null;
  ontology_iri: string | null;
  version_iri: string | null;
  license: string | null;
  kinds: OntologyVersionView['kinds'];
  /** Rows from before migration 0033 lack `imported`. */
  stats: (Omit<OntologyStats, 'imported'> & { imported?: number }) | null;
  /** Rows from before migration 0033 carry only `iri` and `resolution`. */
  imports: (Pick<OntologyImport, 'iri' | 'resolution'> & Partial<OntologyImport>)[];
  error: string | null;
  imported_by: string | null;
  imported_at: Date | string;
}

const iso = (v: Date | string) => new Date(v).toISOString();

function toVersion(r: VersionRow): OntologyVersionView {
  return {
    ontologyId: r.ontology_id,
    version: r.version,
    status: r.status,
    fileName: r.file_name,
    mediaType: r.media_type,
    sha256: r.sha256,
    bytes: r.bytes === null ? null : Number(r.bytes),
    sourceKind: r.source_kind,
    sourceUrl: r.source_url,
    ontologyIri: r.ontology_iri,
    versionIri: r.version_iri,
    license: r.license,
    kinds: r.kinds,
    stats: r.stats ? { ...r.stats, imported: r.stats.imported ?? 0 } : null,
    imports: r.imports.map((e) => ({
      iri: e.iri,
      resolution: e.resolution,
      ontologyId: e.ontologyId ?? null,
      version: e.version ?? null,
      reason: e.reason ?? null,
    })),
    error: r.error,
    importedBy: r.imported_by,
    importedAt: iso(r.imported_at),
  };
}

interface OntologyRow {
  id: string;
  label: string;
  description: string;
  tags: string[];
  local_only: boolean;
  retired_at: Date | null;
  created_by: string | null;
  created_at: Date;
  version_count: number;
  latest: VersionRow | null;
}

const SUMMARY_SELECT = `
  SELECT o.*,
    (SELECT count(*)::int FROM ontology_versions v WHERE v.ontology_id = o.id) AS version_count,
    (SELECT row_to_json(x) FROM (SELECT ${VERSION_COLS} FROM ontology_versions v
       WHERE v.ontology_id = o.id ORDER BY v.version DESC LIMIT 1) x) AS latest
  FROM ontologies o`;

function toSummary(r: OntologyRow): OntologySummary {
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    tags: r.tags,
    localOnly: r.local_only,
    retiredAt: r.retired_at ? iso(r.retired_at) : null,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    latest: r.latest ? toVersion(r.latest) : null,
    versionCount: r.version_count,
  };
}

const TERM_COLS = `iri, kind, label, alt_labels, definition, parents, domains, ranges, scheme,
  deprecated, child_count, defined_in`;

interface TermRow {
  iri: string;
  kind: OntologyTermKind;
  label: string;
  alt_labels: string[];
  definition: string;
  parents: string[];
  domains: string[];
  ranges: string[];
  scheme: string | null;
  deprecated: boolean;
  child_count: number;
  defined_in: string | null;
}

const toTerm = (r: TermRow): OntologyTerm => ({
  iri: r.iri,
  kind: r.kind,
  label: r.label,
  altLabels: r.alt_labels,
  definition: r.definition,
  parents: r.parents,
  domain: r.domains,
  range: r.ranges,
  scheme: r.scheme,
  deprecated: r.deprecated,
  childCount: r.child_count,
  definedIn: r.defined_in,
});

/** `%`, `_` and `\` in a search are literal. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PgOntologyRepo implements OntologyRepo {
  constructor(private readonly pool: pg.Pool) {}

  async list(opts: { retired: boolean }): Promise<OntologySummary[]> {
    const { rows } = await this.pool.query<OntologyRow>(
      `${SUMMARY_SELECT} WHERE $1 OR o.retired_at IS NULL ORDER BY lower(o.label), o.id`,
      [opts.retired],
    );
    return rows.map(toSummary);
  }

  private async summary(id: string): Promise<OntologySummary | null> {
    const { rows } = await this.pool.query<OntologyRow>(`${SUMMARY_SELECT} WHERE o.id = $1`, [id]);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async get(id: string): Promise<OntologyDetail | null> {
    const summary = await this.summary(id);
    if (!summary) return null;
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_COLS} FROM ontology_versions v WHERE v.ontology_id = $1
        ORDER BY v.version DESC`,
      [id],
    );
    return { ...summary, versions: rows.map(toVersion) };
  }

  async createVersion(input: NewOntologyVersion): Promise<CreateVersionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One import per ontology at a time, so versions are numbered in order.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ontology:' || $1))`, [
        input.ontologyId,
      ]);
      const exists = await client.query('SELECT 1 FROM ontologies WHERE id = $1', [
        input.ontologyId,
      ]);
      if (!exists.rowCount) {
        if (!input.meta) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'needs-label' };
        }
        await client.query(
          `INSERT INTO ontologies (id, label, description, tags, local_only, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.ontologyId,
            input.meta.label,
            input.meta.description,
            input.meta.tags,
            input.meta.localOnly,
            input.by,
          ],
        );
      }
      const fields = sourceFields(input);
      const same = fields.sha256
        ? await client.query<{ version: number }>(
            'SELECT version FROM ontology_versions WHERE ontology_id = $1 AND sha256 = $2',
            [input.ontologyId, fields.sha256],
          )
        : { rows: [] };
      if (same.rows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'duplicate', version: same.rows[0].version };
      }
      const next = (
        await client.query<{ next: number }>(
          `SELECT coalesce(max(version), 0) + 1 AS next FROM ontology_versions
            WHERE ontology_id = $1`,
          [input.ontologyId],
        )
      ).rows[0]!.next;
      const job = await client.query<{ id: string }>(
        `INSERT INTO jobs (task, test, priority, max_attempts, params, created_by)
         VALUES ('ontology', false, $1, 3, $2, $3) RETURNING id`,
        [ONTOLOGY_PRIORITY, JSON.stringify(jobParams(input, next)), input.by],
      );
      const jobId = job.rows[0]!.id;
      const { rows } = await client.query<VersionRow>(
        `INSERT INTO ontology_versions
           (ontology_id, version, file_name, media_type, sha256, bytes, source_kind,
            source_url, job_id, imported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${RAW_VERSION_COLS}`,
        [
          input.ontologyId,
          next,
          input.fileName,
          input.mediaType,
          fields.sha256,
          fields.bytes,
          fields.sourceKind,
          fields.sourceUrl,
          jobId,
          input.by,
        ],
      );
      await client.query('COMMIT');
      return { ok: true, version: toVersion(rows[0]!), jobId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(id: string, patch: OntologyPatch): Promise<OntologySummary | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, value: unknown) => {
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.label !== undefined) set('label', patch.label);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.tags !== undefined) set('tags', patch.tags);
    if (patch.localOnly !== undefined) set('local_only', patch.localOnly);
    if (patch.retired !== undefined) {
      sets.push(patch.retired ? 'retired_at = coalesce(retired_at, now())' : 'retired_at = NULL');
    }
    if (sets.length > 0) {
      values.push(id);
      const { rowCount } = await this.pool.query(
        `UPDATE ontologies SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values,
      );
      if (!rowCount) return null;
    }
    return this.summary(id);
  }

  async deleteVersion(id: string, version: number): Promise<DeleteVersionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        status: string;
        sha256: string;
        file_name: string;
        media_type: string;
        job_id: string | null;
      }>(
        `SELECT CASE WHEN ${STOPPED} THEN 'failed' ELSE v.status END AS status,
                v.sha256, v.file_name, v.media_type, v.job_id
           FROM ontology_versions v WHERE v.ontology_id = $1 AND v.version = $2
            FOR UPDATE OF v`,
        [id, version],
      );
      const row = rows[0];
      if (!row || row.status === 'queued' || row.status === 'parsing') {
        await client.query('ROLLBACK');
        return { result: row ? 'busy' : 'missing' };
      }
      await client.query('DELETE FROM ontology_versions WHERE ontology_id = $1 AND version = $2', [
        id,
        version,
      ]);
      if (row.job_id) await client.query('DELETE FROM jobs WHERE id = $1', [row.job_id]);
      await client.query(
        `DELETE FROM ontologies WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM ontology_versions WHERE ontology_id = $1)`,
        [id],
      );
      await client.query('COMMIT');
      return {
        result: 'deleted',
        sha256: row.sha256,
        fileName: row.file_name,
        mediaType: row.media_type,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async hasVersion(id: string, version: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM ontology_versions WHERE ontology_id = $1 AND version = $2',
      [id, version],
    );
    return !!rowCount;
  }

  async terms(id: string, version: number, query: TermQuery): Promise<TermPage | null> {
    if (!(await this.hasVersion(id, version))) return null;
    const values: unknown[] = [id, version];
    const param = (v: unknown) => {
      values.push(v);
      return `$${values.length}`;
    };
    const where = ['t.ontology_id = $1', 't.version = $2'];
    if (query.group) where.push(`t.kind = ANY(${param([...TERM_GROUPS[query.group]])}::text[])`);
    if (query.parent) where.push(`t.parents @> ARRAY[${param(query.parent)}]::text[]`);
    if (query.root) where.push('t.root');
    const q = query.q?.trim().toLowerCase();
    if (q) {
      const anywhere = param(`%${escapeLike(q)}%`);
      where.push(`(lower(t.label) LIKE ${anywhere} OR lower(t.iri) LIKE ${anywhere}
        OR EXISTS (SELECT 1 FROM unnest(t.alt_labels) a WHERE lower(a) LIKE ${anywhere}))`);
    }
    const filter = where.join(' AND ');
    // Counted before the ordering parameters exist: Postgres cannot type an unused parameter.
    const counted = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ontology_terms t WHERE ${filter}`,
      values,
    );
    let order = 'lower(t.label), t.iri';
    if (q) {
      const exact = param(q);
      const prefix = param(`${escapeLike(q)}%`);
      order = `(lower(t.label) = ${exact}::text) DESC, (lower(t.label) LIKE ${prefix}::text) DESC,
        similarity(lower(t.label), ${exact}::text) DESC, lower(t.label), t.iri`;
    }
    const limit = param(query.limit);
    const offset = param(query.offset);
    const { rows } = await this.pool.query<TermRow>(
      `SELECT ${TERM_COLS} FROM ontology_terms t WHERE ${filter}
        ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      values,
    );
    return {
      items: rows.map(toTerm),
      total: counted.rows[0]!.n,
      offset: query.offset,
      limit: query.limit,
    };
  }

  async termKinds(
    versions: { id: string; version: number }[],
    iris: string[],
  ): Promise<Record<string, OntologyTermKind[]>> {
    if (!versions.length || !iris.length) return {};
    const { rows } = await this.pool.query<{ iri: string; kinds: OntologyTermKind[] }>(
      `SELECT t.iri, array_agg(DISTINCT t.kind ORDER BY t.kind) AS kinds
         FROM ontology_terms t
         JOIN unnest($1::text[], $2::int[]) AS p(id, v) ON t.ontology_id = p.id AND t.version = p.v
        WHERE t.iri = ANY($3::text[])
        GROUP BY t.iri`,
      [versions.map((v) => v.id), versions.map((v) => v.version), iris],
    );
    return Object.fromEntries(rows.map((r) => [r.iri, r.kinds]));
  }

  async neighbours(
    id: string,
    version: number,
    iris: string[],
    limit: number,
  ): Promise<OntologyTerm[] | null> {
    if (!(await this.hasVersion(id, version))) return null;
    const { rows } = await this.pool.query<TermRow>(
      `SELECT ${TERM_COLS} FROM ontology_terms
        WHERE ontology_id = $1 AND version = $2
          AND (iri = ANY($3::text[]) OR parents && $3::text[] OR domains && $3::text[]
               OR ranges && $3::text[] OR scheme = ANY($3::text[]))
        ORDER BY iri = ANY($3::text[]) DESC, lower(label), iri LIMIT $4`,
      [id, version, iris, limit],
    );
    return rows.map(toTerm);
  }

  async term(id: string, version: number, iri: string): Promise<TermDetail | null> {
    if (!(await this.hasVersion(id, version))) return null;
    const own = (
      await this.pool.query<TermRow>(
        `SELECT ${TERM_COLS} FROM ontology_terms
          WHERE ontology_id = $1 AND version = $2 AND iri = $3`,
        [id, version, iri],
      )
    ).rows
      .map(toTerm)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0];
    if (!own) return null;
    // Every neighbour list is its own bounded query: a hub (a scheme of 50,000 concepts) is
    // described with at most DETAIL_LIMIT rows per list.
    const named = [...new Set([...own.parents, ...own.domain, ...own.range, own.scheme ?? ''])];
    const refRows = (
      await this.pool.query<{ iri: string; kind: OntologyTermKind; label: string }>(
        `SELECT DISTINCT ON (iri) iri, kind, label FROM ontology_terms
          WHERE ontology_id = $1 AND version = $2 AND iri = ANY($3::text[])
          ORDER BY iri, array_position($4::text[], kind)`,
        [id, version, named.filter(Boolean), KIND_ORDER],
      )
    ).rows;
    const byIri = new Map(refRows.map((r) => [r.iri, r]));
    const refs = (iris: readonly string[]): TermRef[] =>
      iris.flatMap((i) => {
        const r = byIri.get(i);
        return r ? [{ iri: r.iri, kind: r.kind, label: r.label }] : [];
      });
    const list = async (where: string, extra: unknown[] = []): Promise<TermRef[]> =>
      (
        await this.pool.query<{ iri: string; kind: OntologyTermKind; label: string }>(
          `SELECT iri, kind, label FROM ontology_terms
            WHERE ontology_id = $1 AND version = $2 AND ${where}
            ORDER BY lower(label), iri LIMIT ${DETAIL_LIMIT}`,
          [id, version, iri, ...extra],
        )
      ).rows.map((r) => ({ iri: r.iri, kind: r.kind, label: r.label }));
    const properties = [...PROPERTY_KINDS];
    const [children, asDomain, asRange, concepts, shapes] = await Promise.all([
      list('parents @> ARRAY[$3] AND iri <> $3'),
      list('kind = ANY($4::text[]) AND domains @> ARRAY[$3]', [properties]),
      list('kind = ANY($4::text[]) AND ranges @> ARRAY[$3]', [properties]),
      own.kind === 'scheme' ? list(`kind = 'concept' AND scheme = $3`) : Promise.resolve([]),
      list(`kind = 'shape' AND domains @> ARRAY[$3]`),
    ]);
    return {
      ...own,
      parentTerms: refs(own.parents),
      children,
      domainTerms: refs(own.domain),
      rangeTerms: refs(own.range),
      schemeTerm: own.scheme ? (refs([own.scheme])[0] ?? null) : null,
      asDomain,
      asRange,
      concepts,
      shapes,
    };
  }
}
