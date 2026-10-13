import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@ih/shared';
import {
  attentionCount,
  initials,
  matchesQuery,
  pageTitle,
  routeTitle,
  statusGroup,
} from '../src/shell/derive.js';
import { job } from './fake-api.js';

describe('statusGroup', () => {
  it.each<[JobStatus, string]>([
    ['queued', 'active'],
    ['running', 'active'],
    ['awaiting_review', 'attention'],
    ['needs_review', 'attention'],
    ['failed', 'attention'],
    ['succeeded', 'done'],
    ['rejected', 'done'],
    ['cancelled', 'done'],
  ])('%s → %s', (status, group) => expect(statusGroup(status)).toBe(group));
});

describe('attentionCount', () => {
  it('counts awaiting_review, needs_review and failed', () => {
    const jobs = (
      ['awaiting_review', 'needs_review', 'failed', 'running', 'succeeded'] as const
    ).map((status) => job({ status }));
    expect(attentionCount(jobs)).toBe(3);
    expect(attentionCount([])).toBe(0);
  });
});

describe('initials', () => {
  it.each([
    ['admin', 'AD'],
    ['Ken – laptop', 'KL'],
    ['Ops – review station', 'OR'],
    ['  x  ', 'X'],
    ['élodie b', 'ÉB'],
    ['ci-runner-2', 'CR'],
    ['', '?'],
    ['– –', '?'],
  ])('%j → %s', (label, expected) => expect(initials(label)).toBe(expected));
});

describe('matchesQuery', () => {
  it.each<[string, (string | null)[], boolean]>([
    ['', ['anything'], true],
    ['   ', ['anything'], true],
    ['ACME', ['inv-0042-acme.pdf'], true],
    ['acme 0042', ['inv-0042-acme.pdf', 'supplier-invoice'], true],
    ['acme invoice', ['inv-0042-acme.pdf', 'supplier-invoice'], true],
    ['acme globex', ['inv-0042-acme.pdf'], false],
    ['qwen', [null, 'local/qwen3.8-27b-mtp'], true],
    ['x', [null], false],
  ])('%j in %j → %s', (query, fields, expected) =>
    expect(matchesQuery(query, ...fields)).toBe(expected),
  );
});

describe('routeTitle', () => {
  it.each([
    [{ name: 'jobs' }, 'Jobs · CT Studio'],
    [{ name: 'review', jobId: 'j1' }, 'Review · CT Studio'],
    [{ name: 'results' }, 'Results · CT Studio'],
    [{ name: 'result', jobId: 'j1' }, 'Results · CT Studio'],
    [{ name: 'templates' }, 'Document types · CT Studio'],
    [{ name: 'template', templateId: 'invoice', version: 2 }, 'Document types · CT Studio'],
    [{ name: 'workbench' }, 'Workbench · CT Studio'],
    [{ name: 'project', projectId: 'invoice', tab: 'samples' }, 'Workbench · CT Studio'],
    [{ name: 'access' }, 'Access · CT Studio'],
  ] as const)('%o → %s', (route, title) => {
    expect(routeTitle(route)).toBe(title);
  });

  it('is the bare name without a page', () => {
    expect(pageTitle(null)).toBe('CT Studio');
    expect(pageTitle('Sign in')).toBe('Sign in · CT Studio');
  });
});
