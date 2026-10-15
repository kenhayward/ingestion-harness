import { describe, expect, it } from 'vitest';
import { outputPath } from '../src/api/client.js';
import { PROJECT_TABS, parseHash } from '../src/router.js';

describe('parseHash', () => {
  it.each([
    ['#/results', { name: 'results' }],
    ['#/results/abc-123', { name: 'result', jobId: 'abc-123' }],
    ['#/templates', { name: 'templates' }],
    ['#/models', { name: 'models' }],
    ['#/linked-data', { name: 'linked-data' }],
    ['#/ontologies', { name: 'ontologies' }],
    ['#/ontologies/idmp-o', { name: 'ontology', ontologyId: 'idmp-o' }],
    ['#/review/j1', { name: 'review', jobId: 'j1' }],
    ['#/workbench', { name: 'workbench' }],
    ['#/workbench/letter', { name: 'project', projectId: 'letter', tab: 'overview' }],
    ['#/workbench/letter/overview', { name: 'project', projectId: 'letter', tab: 'overview' }],
    ['#/workbench/letter/samples', { name: 'project', projectId: 'letter', tab: 'samples' }],
    ['#/workbench/letter/brief', { name: 'project', projectId: 'letter', tab: 'brief' }],
    ['#/workbench/letter/survey', { name: 'project', projectId: 'letter', tab: 'survey' }],
    ['#/workbench/letter/outputs', { name: 'project', projectId: 'letter', tab: 'outputs' }],
    ['#/workbench/letter/steps', { name: 'project', projectId: 'letter', tab: 'steps' }],
    ['#/workbench/letter/sections', { name: 'project', projectId: 'letter', tab: 'sections' }],
    ['#/workbench/letter/references', { name: 'project', projectId: 'letter', tab: 'references' }],
    ['#/workbench/letter/evaluate', { name: 'project', projectId: 'letter', tab: 'evaluate' }],
    ['#/workbench/letter/revise', { name: 'project', projectId: 'letter', tab: 'revise' }],
    ['#/workbench/letter/bogus', { name: 'project', projectId: 'letter', tab: 'overview' }],
    ['', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/jobs', { name: 'jobs' }],
    ['#/account/password', { name: 'password' }],
    ['#/upload', { name: 'home', focusUpload: true }],
    ['#/nowhere', { name: 'home' }],
  ])('%s', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });
});

describe('PROJECT_TABS', () => {
  it('starts with the Overview tab', () => {
    expect(PROJECT_TABS[0]).toBe('overview');
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
