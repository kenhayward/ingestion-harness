import { z } from 'zod';

/**
 * User classes (migration 0047). An administrator does everything; a designer (the old `user`)
 * builds document types in the Workbench and the Document types page; an operator only runs
 * documents through: Home, Jobs (with review) and Results.
 */
export const ROLES = ['admin', 'designer', 'operator'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

/** How the UI names each role. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  designer: 'Designer',
  operator: 'Operator',
};

/** The `error` of the 403 an operator gets from any other guarded route. */
export const OPERATOR_REFUSED = 'operators cannot use this';

/**
 * Every guarded route an operator may call (`METHOD /api/route-pattern`, the pattern as Fastify
 * registered it): signing in and their profile, uploads, jobs with review (but not step re-runs),
 * results, conversion batches and what the upload strip and job panel read. Anything else is a 403, so a route added
 * later is closed to operators until listed here.
 */
const OPERATOR_CALLS = new Set([
  'GET /api/auth/me',
  'PUT /api/auth/password',
  'GET /api/profile',
  'PUT /api/profile',
  'GET /api/profile/connections',
  'POST /api/bridge/connections-link',
  'GET /api/profile/github/connect',
  'DELETE /api/profile/github',
  'GET /api/profile/github/repos',
  'PUT /api/profile/github/repo',
  'GET /api/specs',
  'GET /api/specs/:id',
  'GET /api/models/choices',
  'POST /api/documents',
  'POST /api/documents/preflight',
  'GET /api/jobs',
  'GET /api/jobs/page',
  'POST /api/jobs/cleanup',
  'GET /api/jobs/:id',
  'DELETE /api/jobs/:id',
  'GET /api/jobs/:id/events',
  'GET /api/jobs/:id/document',
  'GET /api/jobs/:id/pages/:n',
  'GET /api/jobs/:id/outputs/:outputId',
  'GET /api/jobs/:id/review',
  'GET /api/jobs/:id/steps',
  'GET /api/jobs/:id/shacl-report',
  'POST /api/jobs/:id/edits',
  'POST /api/jobs/:id/approve',
  'POST /api/jobs/:id/reject',
  'POST /api/jobs/:id/retry',
  'POST /api/jobs/:id/cancel',
  'GET /api/queue/summary',
  'GET /api/results',
  'GET /api/results/:jobId',
  'GET /api/results/:jobId/archive',
  // Conversion (decomposition phase 3): every role may convert.
  'GET /api/conversions/targets',
  'GET /api/conversions/batches',
  'POST /api/conversions/batches',
  'GET /api/conversions/batches/:id',
  'DELETE /api/conversions/batches/:id',
  'POST /api/conversions/batches/:id/items',
  'POST /api/conversions/batches/:id/start',
  'GET /api/conversions/items/:id/report',
]);

export const operatorMayCall = (method: string, route: string) =>
  OPERATOR_CALLS.has(`${method} ${route}`);

/** The web routes an operator may open; the rest (Document types, Ontologies, Workbench) are not. */
const OPERATOR_PAGES = new Set([
  'home',
  'jobs',
  'review',
  'results',
  'result',
  'profile',
  'password',
]);

export const operatorMayOpen = (routeName: string) => OPERATOR_PAGES.has(routeName);
