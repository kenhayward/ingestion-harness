import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_LABELS, operatorMayCall, operatorMayOpen } from '../src/roles.js';

describe('roles', () => {
  it('are admin, designer and operator, labelled for people', () => {
    expect(ROLES).toEqual(['admin', 'designer', 'operator']);
    expect(ROLE_LABELS).toEqual({
      admin: 'Administrator',
      designer: 'Designer',
      operator: 'Operator',
    });
  });

  it.each([
    'GET /api/auth/me',
    'PUT /api/auth/password',
    'GET /api/profile',
    'PUT /api/profile/github/repo',
    'GET /api/specs',
    'GET /api/specs/:id',
    'GET /api/models/choices',
    'POST /api/documents',
    'GET /api/jobs',
    'GET /api/jobs/:id',
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
    'DELETE /api/jobs/:id',
    'POST /api/jobs/cleanup',
    'GET /api/queue/summary',
    'GET /api/results',
    'GET /api/results/:jobId',
    'GET /api/results/:jobId/archive',
  ])('operators may call %s', (call) => {
    const [method, route] = call.split(' ') as [string, string];
    expect(operatorMayCall(method, route)).toBe(true);
  });

  it.each([
    'POST /api/jobs/:id/steps/:step/rerun',
    'GET /api/models',
    'GET /api/templates',
    'POST /api/templates/:id/references',
    'GET /api/workbench/projects',
    'GET /api/ontologies',
    'GET /api/ontology-settings',
    'GET /api/linked-data/base',
    'PUT /api/specs/:id/retirement',
    'GET /api/profiles',
  ])('operators may not call %s', (call) => {
    const [method, route] = call.split(' ') as [string, string];
    expect(operatorMayCall(method, route)).toBe(false);
  });

  it.each([
    ['home', true],
    ['jobs', true],
    ['results', true],
    ['result', true],
    ['review', true],
    ['profile', true],
    ['password', true],
    ['templates', false],
    ['template', false],
    ['workbench', false],
    ['project', false],
    ['ontologies', false],
    ['ontology', false],
  ] as const)('operators may open %s: %s', (route, ok) => {
    expect(operatorMayOpen(route)).toBe(ok);
  });
});
