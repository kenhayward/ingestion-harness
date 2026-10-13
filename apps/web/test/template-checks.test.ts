import { describe, expect, it } from 'vitest';
import type { OverviewItem } from '@ih/shared';
import {
  attentionTabs,
  issueSubTab,
  issueText,
  templateChecks,
  type SubTab,
} from '../src/templates/checks.js';

const definition = {
  outputs: { fields: [{ id: 'total' }, { id: 'due_date' }], tables: [] },
  pipeline: [{ type: 'extract', id: 'totals', fields: ['total'], sections: ['totals'] }],
};
const stale = (stage: OverviewItem['stage']): OverviewItem => ({
  stage,
  state: 'stale',
  status: 'Stale — Outputs changed after it was accepted',
  metrics: [],
});
const run = (over: Partial<Parameters<typeof templateChecks>[0]> = {}) =>
  templateChecks({
    projectId: 'invoice',
    definition,
    issues: [],
    serverIssues: [],
    stages: null,
    ...over,
  });

describe('issueSubTab', () => {
  it.each<[string, SubTab]>([
    ['document.sections: Array must contain at least 1 element(s)', 'sections'],
    ['outputs.fields.0.type: Invalid enum value', 'outputs'],
    ['duplicate output id "total"', 'outputs'],
    ['output id "rows" is reserved', 'outputs'],
    ['pipeline: Array must contain at least 1 element(s)', 'pipeline'],
    ['step "totals": unknown section "payment"', 'pipeline'],
    ['check "sum": unknown field or column "x"', 'pipeline'],
    ['duplicate step id "a"', 'pipeline'],
    ['name: String must contain at least 1 character(s)', 'general'],
  ])('%s -> %s', (issue, tab) => expect(issueSubTab(issue)).toBe(tab));
});

describe('templateChecks', () => {
  it('names an output no step fills, linking to Steps and marking Outputs and Pipeline', () => {
    const checks = run({ issues: ['field "due_date" is not filled by any step'] });
    expect(checks).toEqual([
      {
        tone: 'warn',
        text: 'due_date is not filled by any step.',
        link: { label: 'Add it to a step in Steps', hash: '#/workbench/invoice/steps' },
        subTabs: ['outputs', 'pipeline'],
      },
    ]);
    expect([...attentionTabs(checks)].sort()).toEqual(['outputs', 'pipeline']);
  });

  it('says so when everything is valid and filled', () => {
    const full = { ...definition, outputs: { fields: [{ id: 'total' }], tables: [] } };
    expect(run({ definition: full })).toEqual([
      { tone: 'ok', text: 'Sections, outputs and steps are valid.', link: null, subTabs: [] },
    ]);
  });

  it('lists validation issues once, with a link to the sub-tab that fixes them', () => {
    const issue = 'pipeline.0.model: model local/x is not offered';
    const checks = run({
      definition: { ...definition, outputs: { fields: [{ id: 'total' }], tables: [] } },
      issues: [issue],
      serverIssues: [issue, 'name: Required'],
    });
    expect(checks).toEqual([
      {
        tone: 'danger',
        text: issue,
        link: { label: 'Open Pipeline', subTab: 'pipeline' },
        subTabs: ['pipeline'],
      },
      {
        tone: 'danger',
        text: 'name: Required',
        link: { label: 'Open General', subTab: 'general' },
        subTabs: ['general'],
      },
    ]);
  });

  it('adds stale stages after the draft checks, each linking to its tab', () => {
    const full = { ...definition, outputs: { fields: [{ id: 'total' }], tables: [] } };
    const checks = run({
      definition: full,
      stages: [stale('sections'), { ...stale('steps'), state: 'accepted' }, stale('publish')],
    });
    expect(checks.slice(1)).toEqual([
      {
        tone: 'alert',
        text: 'Sections: Stale — Outputs changed after it was accepted',
        link: { label: 'Review in Sections', hash: '#/workbench/invoice/sections' },
        subTabs: [],
      },
      {
        tone: 'alert',
        text: 'Publish: Stale — Outputs changed after it was accepted',
        link: { label: 'Review in Evaluate', hash: '#/workbench/invoice/evaluate' },
        subTabs: [],
      },
    ]);
  });

  it('flags outputs more than one step fills', () => {
    const twice = {
      outputs: { fields: [{ id: 'total' }], tables: [] },
      pipeline: [
        { type: 'extract', id: 'a', fields: ['total'], sections: [] },
        { type: 'extract', id: 'b', fields: ['total'], sections: [] },
      ],
    };
    expect(
      run({ definition: twice, issues: ['field "total" is filled by more than one step'] }),
    ).toEqual([
      {
        tone: 'warn',
        text: 'total is filled by more than one step.',
        link: { label: 'Review in Steps', hash: '#/workbench/invoice/steps' },
        subTabs: ['pipeline'],
      },
    ]);
  });
});

describe('issueText', () => {
  it('words a server issue as the editor does', () => {
    expect(issueText({ path: 'pipeline.0.model', message: 'not offered' })).toBe(
      'pipeline.0.model: not offered',
    );
    expect(issueText({ path: '', message: 'duplicate step id "a"' })).toBe('duplicate step id "a"');
  });
});
