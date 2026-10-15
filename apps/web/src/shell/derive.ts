import type { JobStatus, JobSummary } from '@ih/shared';
import type { Route } from '../router.js';

/** Nav sections; child screens belong to their parent (Review → Jobs, Editor → Document types). */
export type Section =
  | 'home'
  | 'jobs'
  | 'results'
  | 'templates'
  | 'ontologies'
  | 'workbench'
  | 'access'
  | 'account'
  | 'models'
  | 'linked-data';

const SECTION: Record<Route['name'], Section> = {
  home: 'home',
  jobs: 'jobs',
  review: 'jobs',
  results: 'results',
  result: 'results',
  templates: 'templates',
  template: 'templates',
  workbench: 'workbench',
  project: 'workbench',
  access: 'access',
  password: 'account',
  // The way back from GitHub: Home with the Profile dialog open.
  profile: 'home',
  models: 'models',
  'linked-data': 'linked-data',
  ontologies: 'ontologies',
  ontology: 'ontologies',
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

/** The in-app product name (docs/brand/BRAND.md); docs use "Content Transformation Studio". */
export const APP_NAME = 'CT Studio';

/** Child screens take their parent page's name, as in the nav. */
const PAGE: Record<Route['name'], string> = {
  home: 'Home',
  jobs: 'Jobs',
  review: 'Review',
  results: 'Results',
  result: 'Results',
  templates: 'Document types',
  template: 'Document types',
  workbench: 'Workbench',
  project: 'Workbench',
  access: 'Access',
  password: 'Change password',
  profile: 'Home',
  models: 'Models',
  'linked-data': 'Linked data',
  ontologies: 'Ontologies',
  ontology: 'Ontologies',
};

/** Browser tab title: "<Page> · CT Studio", or just the name. */
export function pageTitle(page: string | null): string {
  return page === null ? APP_NAME : `${page} · ${APP_NAME}`;
}

export function routeTitle(route: Route): string {
  return pageTitle(PAGE[route.name]);
}
