import { describe, expect, it } from 'vitest';
import { outputPath } from '../src/api/client.js';
import { parseHash } from '../src/router.js';

describe('parseHash', () => {
  it.each([
    ['#/results', { name: 'results' }],
    ['#/results/abc-123', { name: 'result', jobId: 'abc-123' }],
    ['#/templates', { name: 'templates' }],
    ['#/review/j1', { name: 'review', jobId: 'j1' }],
    ['#/workbench', { name: 'workbench' }],
    ['#/workbench/letter', { name: 'project', projectId: 'letter', tab: 'samples' }],
    ['#/workbench/letter/brief', { name: 'project', projectId: 'letter', tab: 'brief' }],
    ['#/workbench/letter/bogus', { name: 'project', projectId: 'letter', tab: 'samples' }],
    ['', { name: 'jobs' }],
  ])('%s', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });
});

describe('outputPath', () => {
  it.each([
    [undefined, '/api/jobs/j/outputs/o'],
    [{ stage: 'published' as const }, '/api/jobs/j/outputs/o?stage=published'],
    [
      { stage: 'published' as const, inline: true },
      '/api/jobs/j/outputs/o?stage=published&inline=1',
    ],
  ])('%o', (opts, url) => {
    expect(outputPath('/api', 'j', 'o', opts)).toBe(url);
  });
});
