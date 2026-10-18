import { describe, expect, it } from 'vitest';
import { outputPath } from '../src/api/client.js';
import { PROJECT_TABS, parseHash } from '../src/router.js';

describe('parseHash', () => {
  it.each([
    ['#/results', { name: 'results' }],
    ['#/results/abc-123', { name: 'result', jobId: 'abc-123' }],
    ['#/templates', { name: 'templates' }],
    // Models, Linked data and Access live in the Administration dialog: no address of their own.
    ['#/models', { name: 'home' }],
    ['#/linked-data', { name: 'home' }],
    ['#/access', { name: 'home' }],
    ['#/ontologies', { name: 'ontologies' }],
    ['#/ontologies/idmp-o', { name: 'ontology', ontologyId: 'idmp-o' }],
    [
      '#/ontologies/afo/3/http%3A%2F%2Fpurl.allotrope.org%2Fontologies%2Fproperty%23AFX_0000690',
      {
        name: 'ontology',
        ontologyId: 'afo',
        version: 3,
        term: 'http://purl.allotrope.org/ontologies/property#AFX_0000690',
      },
    ],
    ['#/review/j1', { name: 'review', jobId: 'j1' }],
    ['#/workbench', { name: 'workbench' }],
    ['#/workbench/letter', { name: 'project', projectId: 'letter', tab: 'overview' }],
    ['#/workbench/letter/overview', { name: 'project', projectId: 'letter', tab: 'overview' }],
    ['#/workbench/letter/samples', { name: 'project', projectId: 'letter', tab: 'samples' }],
    ['#/workbench/letter/brief', { name: 'project', projectId: 'letter', tab: 'brief' }],
    ['#/workbench/letter/survey', { name: 'project', projectId: 'letter', tab: 'survey' }],
    [
      '#/workbench/letter/survey/ontologies',
      { name: 'project', projectId: 'letter', tab: 'survey', view: 'ontologies' },
    ],
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
    ['#/help', { name: 'help' }],
    ['#/help/sections', { name: 'help', topic: 'sections' }],
    ['#/about', { name: 'about' }],
    ['#/about/2026-10-18', { name: 'about', note: '2026-10-18' }],
    ['#/about/2026-10-18-2', { name: 'about', note: '2026-10-18-2' }],
    ['#/about/nonsense', { name: 'home' }],
    ['#/jobs/job-1', { name: 'jobs', jobId: 'job-1' }],
    ['#/jobs/a%2Fb', { name: 'jobs', jobId: 'a/b' }],
    ['#/account/password', { name: 'password' }],
    ['#/account/profile', { name: 'profile', tab: 'details' }],
    ['#/account/profile/password', { name: 'profile', tab: 'password' }],
    [
      '#/account/profile/github?github=linked',
      { name: 'profile', tab: 'details', github: 'linked' },
    ],
    ['#/account/profile/github?github=nonsense', { name: 'profile', tab: 'details' }],
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
