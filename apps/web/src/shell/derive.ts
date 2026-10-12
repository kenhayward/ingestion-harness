import type { JobStatus, JobSummary } from '@ih/shared';
import type { Route } from '../router.js';

/** Nav sections; child screens belong to their parent (Review → Jobs, Editor → Document types). */
export type Section = 'jobs' | 'results' | 'templates' | 'access';

const SECTION: Record<Route['name'], Section> = {
  jobs: 'jobs',
  review: 'jobs',
  results: 'results',
  result: 'results',
  templates: 'templates',
  template: 'templates',
  access: 'access',
};

export function sectionOf(route: Route): Section {
  return SECTION[route.name];
}

/** Which bucket a status belongs to: someone must act, still running, or finished. */
export type StatusGroup = 'attention' | 'active' | 'done';

const GROUP: Record<JobStatus, StatusGroup> = {
  queued: 'active',
  running: 'active',
  awaiting_review: 'attention',
  needs_review: 'attention',
  failed: 'attention',
  succeeded: 'done',
  rejected: 'done',
  cancelled: 'done',
};

export function statusGroup(status: JobStatus): StatusGroup {
  return GROUP[status];
}

/** The nav badge: jobs waiting on a person (reviewer or operator). */
export function attentionCount(jobs: readonly JobSummary[]): number {
  return jobs.filter((j) => statusGroup(j.status) === 'attention').length;
}

/** Avatar initials for a token label: first letters of the first two words, or two of one word. */
export function initials(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Client-side search: every whitespace-separated term must appear (any case) in some field. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.filter((f): f is string => !!f).map((f) => f.toLowerCase());
  return terms.every((t) => haystack.some((f) => f.includes(t)));
}
