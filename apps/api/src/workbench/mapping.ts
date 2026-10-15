import type { FastifyInstance } from 'fastify';
import {
  mappingStage,
  ontologySelectionChangedAt,
  reviewedDocumentKey,
  vocabularyOf,
  type BriefBody,
  type StageView,
} from '@ih/shared';
import { readJsonSafe, sampleViews, statusOf } from '../routes/workbench.js';

/**
 * The mapping stage (ADR 0011): what the API sends the worker, and the stage's state. The
 * worker shortlists terms itself; the API sends the brief's vocabulary, its guidance, and the
 * values the dev samples' latest finished runs produced, so the model maps real values.
 */

/** Distinct values per output sent to the model. */
export const MAX_OBSERVED_VALUES = 20;

export interface ObservedValue {
  value: string;
  count: number;
  /** The quote the value was read from (a field's evidence); null for table cells. */
  snippet: string | null;
  /** The first sample it was seen in. */
  sample: string;
}

export interface MappingParams {
  versions: { id: string; version: number; localOnly: boolean; label: string }[];
  guidance: string;
  observed: Record<string, ObservedValue[]>;
}

type Doc = {
  fields?: Record<string, { value?: unknown; evidence?: unknown }>;
  tables?: Record<string, Record<string, unknown>[]>;
};

const FINISHED = new Set(['succeeded', 'awaiting_review']);

/** Each ready dev sample's newest finished run's document: the reviewed one when approved. */
async function devDocuments(
  app: FastifyInstance,
  projectId: string,
): Promise<{ sample: string; doc: Doc }[]> {
  const views = (await sampleViews(app, projectId)).filter(
    (s) => s.view.role === 'dev' && s.view.state === 'ready',
  );
  const runs = await app.deps.repo.listProjectRuns(projectId);
  const out: { sample: string; doc: Doc }[] = [];
  for (const s of views) {
    for (const run of runs.filter(
      (r) => r.sha256 === s.record.sha256 && FINISHED.has(r.job.status),
    )) {
      const reviewed = await readJsonSafe(app, reviewedDocumentKey(run.job.id));
      let doc = reviewed && typeof reviewed === 'object' ? (reviewed as Doc) : null;
      if (!doc) {
        const detail = await app.deps.repo.getJob(run.job.id);
        const draft = detail?.outputs.find((o) => o.outputId === 'document' && o.stage === 'draft');
        const body = draft ? await app.deps.store.get(draft.bucket, draft.key) : null;
        doc = body ? (JSON.parse(body.toString('utf8')) as Doc) : null;
      }
      if (doc) {
        out.push({ sample: s.record.filename, doc });
        break;
      }
    }
  }
  return out;
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** The values each output took in the dev documents, most frequent first, at most 20 each. */
export function observedValues(
  docs: { sample: string; doc: Doc }[],
): Record<string, ObservedValue[]> {
  const seen = new Map<string, Map<string, ObservedValue>>();
  const add = (path: string, raw: unknown, snippet: string | null, sample: string) => {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const value = text(item);
      if (!value) continue;
      const values = seen.get(path) ?? new Map<string, ObservedValue>();
      seen.set(path, values);
      const known = values.get(value);
      if (known) known.count += 1;
      else values.set(value, { value, count: 1, snippet, sample });
    }
  };
  for (const { sample, doc } of docs) {
    for (const [id, entry] of Object.entries(doc.fields ?? {})) {
      const quote = text(entry?.evidence);
      add(id, entry?.value, quote || null, sample);
    }
    for (const [table, rows] of Object.entries(doc.tables ?? {})) {
      for (const row of rows ?? []) {
        for (const [column, value] of Object.entries(row ?? {})) {
          add(`${table}.${column}`, value, null, sample);
        }
      }
    }
  }
  return Object.fromEntries(
    [...seen].map(([path, values]) => [
      path,
      [...values.values()]
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, MAX_OBSERVED_VALUES),
    ]),
  );
}

/** The params of a mapping run, or why it cannot run. */
export async function mappingInputs(
  app: FastifyInstance,
  projectId: string,
  brief: BriefBody,
): Promise<{ params: MappingParams } | { error: string }> {
  const picks = vocabularyOf(brief);
  if (!picks.length) return { error: 'pin a vocabulary ontology on the Survey tab first' };
  const versions: MappingParams['versions'] = [];
  for (const pick of picks) {
    const detail = await app.deps.ontologies.get(pick.ontologyId);
    const version = detail?.versions.find((v) => v.version === pick.version);
    if (!detail || !version) {
      return { error: `ontology ${pick.ontologyId} v${pick.version} is not in the library` };
    }
    if (version.status !== 'ready') {
      return { error: `ontology ${pick.ontologyId} v${pick.version} is not ready` };
    }
    versions.push({
      id: pick.ontologyId,
      version: pick.version,
      localOnly: detail.localOnly,
      label: detail.label,
    });
  }
  return {
    params: {
      versions,
      guidance: (brief.ontologyGuidance ?? '').trim(),
      observed: observedValues(await devDocuments(app, projectId)),
    },
  };
}

/** The mapping stage's state (`mappingStage`) from the stored proposals, skips and keeps. */
export async function mappingView(
  app: FastifyInstance,
  projectId: string,
  outputsCompletedAt: string | null,
): Promise<StageView> {
  const { workbench, repo } = app.deps;
  const [jobs, proposals, skips, confirms, briefs] = await Promise.all([
    repo.listDraftJobs(projectId),
    workbench.listProposals(projectId),
    workbench.listSkips(projectId),
    workbench.listConfirms(projectId),
    workbench.listBriefs(projectId),
  ]);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  return mappingStage({
    proposals: proposals
      .filter((p) => p.stage === 'mapping')
      .map((p) => ({
        stage: p.stage,
        createdAt: p.createdAt,
        decidedAt: p.decidedAt,
        status: statusOf(p, jobById.get(p.id) ?? null),
        acceptedChanges: p.acceptedChanges,
      })),
    skips,
    confirms,
    outputsCompletedAt,
    briefChangedAt: ontologySelectionChangedAt(briefs),
  });
}

/** Outputs the definition maps (fields and tables with a mapping), of all its outputs. */
export function mappedOutputs(definition: Record<string, unknown> | null): {
  mapped: number;
  outputs: number;
} {
  const outputs = (definition?.outputs ?? {}) as {
    fields?: { id: string }[];
    tables?: { id: string }[];
  };
  const semantics = (definition?.semantics ?? {}) as {
    fields?: Record<string, unknown>;
    tables?: Record<string, unknown>;
  };
  const ids = [...(outputs.fields ?? []), ...(outputs.tables ?? [])].map((o) => o.id);
  const mapped = ids.filter((id) => semantics.fields?.[id] || semantics.tables?.[id]).length;
  return { mapped, outputs: ids.length };
}
