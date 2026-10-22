import { z } from 'zod';
import {
  JobSummarySchema,
  StatusGroupSchema,
  statusGroup,
  type JobSummary,
  type StatusGroup,
} from './jobs.js';

/**
 * One page of the Jobs list (`GET /api/jobs/page`), paged on the server by a job's place in
 * the list (newest first, by `createdAt` then `id`), never by a page number, so jobs arriving
 * at the top never shift the page being read. `pageOfJobs` is the rule; PgRepo answers the
 * same in SQL (held in step by `apps/api/test/integration/jobs-list-pg.test.ts`).
 */

/** The most jobs one page holds. */
export const JOB_PAGE_MAX = 100;
export const JOB_PAGE_DEFAULT = 25;

const JobId = z.string().uuid();

export const JobPageQuerySchema = z
  .object({
    size: z.coerce
      .number()
      .int()
      .min(1)
      .max(JOB_PAGE_MAX)
      .default(JOB_PAGE_DEFAULT)
      .describe(`Jobs on the page, 1 to ${JOB_PAGE_MAX}.`),
    group: StatusGroupSchema.optional().describe('Only jobs of this status group.'),
    mine: z.enum(['0', '1']).optional().describe('`1`: only jobs queued by the signed-in user.'),
    q: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        'Words that must each appear in the file name, document type id, status, model ' +
          'override or a model used (ignoring case).',
      ),
    before: JobId.optional().describe('The jobs just older than this job (Older ›).'),
    after: JobId.optional().describe('The jobs just newer than this job (‹ Newer).'),
    from: JobId.optional().describe('This job and the ones older than it (a linked job).'),
  })
  .refine((q) => [q.before, q.after, q.from].filter(Boolean).length <= 1, {
    message: 'give at most one of before, after and from',
  });
export type JobPageQuery = z.infer<typeof JobPageQuerySchema>;

export const JobCountsSchema = z.object({
  all: z.number().int(),
  attention: z.number().int(),
  active: z.number().int(),
  done: z.number().int(),
});
export type JobCounts = z.infer<typeof JobCountsSchema>;

export const JobPageSchema = z.object({
  jobs: z.array(JobSummarySchema),
  /** How many jobs of this view are newer than the first one shown. */
  start: z.number().int(),
  /** The jobs in this view (group, mine and search applied). */
  total: z.number().int(),
  hasNewer: z.boolean(),
  hasOlder: z.boolean(),
  /** Per status group, with mine and search applied but not the group (the chips). */
  counts: JobCountsSchema,
});
export type JobPage = z.infer<typeof JobPageSchema>;

/** Every word of `q` appears in one of the job's searchable fields (ignoring case). */
export function jobMatches(job: JobSummary, q: string | undefined): boolean {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const fields = [job.filename, job.specId, job.status, job.modelOverride, ...job.modelsUsed]
    .filter((f): f is string => !!f)
    .map((f) => f.toLowerCase());
  return words.every((w) => fields.some((f) => f.includes(w)));
}

/** A job's place in the list: newer sorts higher. */
const placeOf = (j: { createdAt: string; id: string }) => `${j.createdAt}|${j.id}`;

/**
 * The page of `jobs` (every job the caller may list: `mine` already applied) that `query`
 * asks for. A cursor job no longer in `jobs` (deleted) pages from the newest.
 */
export function pageOfJobs(jobs: readonly JobSummary[], query: JobPageQuery): JobPage {
  const searched = jobs.filter((j) => jobMatches(j, query.q));
  const counts: JobCounts = { all: searched.length, attention: 0, active: 0, done: 0 };
  for (const j of searched) counts[statusGroup(j.status)]++;
  const view = searched
    .filter((j) => !query.group || statusGroup(j.status) === (query.group as StatusGroup))
    .sort((a, b) => placeOf(b).localeCompare(placeOf(a)));

  const cursorId = query.before ?? query.after ?? query.from;
  const cursor = cursorId ? jobs.find((j) => j.id === cursorId) : undefined;
  let from = 0;
  if (cursor) {
    const at = placeOf(cursor);
    const first = (keep: (place: string) => boolean) => {
      const i = view.findIndex((j) => keep(placeOf(j)));
      return i === -1 ? view.length : i;
    };
    if (query.before) from = first((p) => p < at);
    else if (query.from) from = first((p) => p <= at);
    // after: the `size` jobs just newer than the cursor, a full page where there are enough.
    else from = Math.max(0, first((p) => p <= at) - query.size);
  }
  const page = view.slice(from, from + query.size);
  return {
    jobs: page,
    start: from,
    total: view.length,
    hasNewer: from > 0,
    hasOlder: from + page.length < view.length,
    counts,
  };
}
