import type { FastifyInstance } from 'fastify';
import {
  DraftResultSchema,
  draftingKey,
  ontologyLibraryKey,
  ontologySuggestionsKey,
  SuggestionRecordSchema,
  SurveyBodySchema,
  type LibraryVersion,
  type OntologySuggestionsView,
  type OntologyVersionView,
  type SuggestCandidate,
  type SuggestionRecord,
} from '@ih/shared';
import { readJsonSafe } from '../routes/workbench.js';

const termCount = (v: OntologyVersionView): number =>
  v.stats ? v.stats.classes + v.stats.properties + v.stats.concepts + v.stats.imported : 0;

/** The newest ready version of every ontology that is not retired, by id. */
export async function ontologyLibrary(app: FastifyInstance): Promise<LibraryVersion[]> {
  const out: LibraryVersion[] = [];
  for (const o of await app.deps.ontologies.list({ retired: false })) {
    let ready = o.latest?.status === 'ready' ? o.latest : null;
    if (!ready && o.latest) {
      const detail = await app.deps.ontologies.get(o.id);
      ready =
        detail?.versions
          .filter((v) => v.status === 'ready')
          .sort((a, b) => b.version - a.version)[0] ?? null;
    }
    if (ready)
      out.push({ id: o.id, version: ready.version, label: o.label, terms: termCount(ready) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The survey suggestions follow: the newest accepted one, else the newest finished, unrejected. */
export async function currentSurvey(
  app: FastifyInstance,
  projectId: string,
): Promise<{ id: string; candidates: SuggestCandidate[] } | null> {
  const [proposals, jobs] = await Promise.all([
    app.deps.workbench.listProposals(projectId),
    app.deps.repo.listDraftJobs(projectId),
  ]);
  const succeeded = new Set(jobs.filter((j) => j.status === 'succeeded').map((j) => j.id));
  const surveys = proposals
    .filter((p) => p.stage === 'survey' && succeeded.has(p.id) && p.decision !== 'rejected')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pick = surveys.find((p) => p.decision === 'accepted') ?? surveys[0];
  if (!pick) return null;
  const raw = await readJsonSafe(app, draftingKey(projectId, pick.id));
  const result = raw == null ? null : DraftResultSchema.safeParse(raw);
  const body = result?.success ? SurveyBodySchema.safeParse(result.data.body) : null;
  if (!body?.success) return null;
  return {
    id: pick.id,
    candidates: body.data.candidates.map(({ name, description, kind }) => ({
      name,
      description,
      kind,
    })),
  };
}

async function readRecord(
  app: FastifyInstance,
  projectId: string,
  jobId: string,
): Promise<SuggestionRecord | null> {
  const raw = await readJsonSafe(app, ontologySuggestionsKey(projectId, jobId));
  const parsed = raw == null ? null : SuggestionRecordSchema.safeParse(raw);
  return parsed?.success ? parsed.data : null;
}

/**
 * The record to show: a finished refresh of the current survey, else the current survey job's own
 * record, else an older refresh (stale `survey`); `library` when the library moved since.
 */
export async function suggestionsView(
  app: FastifyInstance,
  projectId: string,
): Promise<OntologySuggestionsView> {
  const [survey, refresh] = await Promise.all([
    currentSurvey(app, projectId),
    app.deps.repo.latestSuggestJob(projectId),
  ]);
  const refreshed =
    refresh?.status === 'succeeded' ? await readRecord(app, projectId, refresh.id) : null;
  const own = survey ? await readRecord(app, projectId, survey.id) : null;
  const record =
    refreshed && refreshed.surveyProposalId === survey?.id ? refreshed : (own ?? refreshed);
  let stale: OntologySuggestionsView['stale'] = null;
  if (record) {
    if (record.surveyProposalId !== survey?.id) stale = 'survey';
    else {
      const { embeddingModel } = await app.deps.llm.getSettings();
      const key = ontologyLibraryKey(await ontologyLibrary(app), embeddingModel ?? null);
      if (key !== record.libraryKey) stale = 'library';
    }
  }
  const failed =
    refresh && (refresh.status === 'failed' || refresh.status === 'needs_review')
      ? (refresh.error ?? 'the refresh failed')
      : null;
  return {
    record,
    running: refresh?.status === 'queued' || refresh?.status === 'running',
    failed,
    stale,
  };
}
