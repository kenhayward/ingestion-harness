import { describe, expect, it } from 'vitest';
import type { OverviewItem } from '@ih/shared';
import {
  attentionTabs,
  issueSubTab,
  issueText,
  sameShapeTables,
  sharedRepeatSteps,
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
  it('names an output no step fills, linking to Pipeline and marking Outputs and Pipeline', () => {
    const checks = run({ issues: ['field "due_date" is not filled by any step'] });
    expect(checks).toEqual([
      {
        tone: 'warn',
        text: 'due_date is not filled by any step.',
        link: { label: 'Add it to a step in Pipeline', hash: '#/workbench/invoice/steps' },
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
        link: { label: 'Review in Pipeline', hash: '#/workbench/invoice/steps' },
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

describe('mapping checks (ADR 0011)', () => {
  it.each<[string, SubTab]>([
    ['semantics.fields.sender.property: acme:x is not in the pinned ontologies', 'mapping'],
    ['semantics: rdf delivery needs an ontology mapping', 'mapping'],
    ['delivery: csv is listed twice', 'general'],
  ])('routes %s to %s', (issue, sub) => {
    expect(issueSubTab(issue)).toBe(sub);
  });

  it('shows server warnings as warnings, on the Mapping sub-tab', () => {
    const checks = run({
      definition: { outputs: { fields: [], tables: [] }, pipeline: [] },
      serverWarnings: ['semantics.fields.sender: sender is not mapped'],
    });
    expect(checks).toContainEqual({
      tone: 'warn',
      text: 'semantics.fields.sender: sender is not mapped',
      link: { label: 'Open Mapping', subTab: 'mapping' },
      subTabs: ['mapping'],
    });
    expect(attentionTabs(checks).has('mapping')).toBe(true);
  });
});

describe('shared repeating sections and same-shape tables', () => {
  const sections = (ids: string[]) => ids.map((id) => ({ id, repeat: true }));
  const tableSteps = (n: number, section: string) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'extract',
      id: `s${i}`,
      table: `t${i}`,
      sections: [section],
    }));
  const tables = (n: number, shapes: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      columns: [`a${i % shapes}`, `b${i % shapes}`].map((id) => ({ id })),
    }));

  it('warns once for table steps sharing one repeating section', () => {
    const def = {
      document: { sections: sections(['result_tables']) },
      pipeline: tableSteps(60, 'result_tables'),
    };
    expect(sharedRepeatSteps(def)).toEqual([
      { section: 'result_tables', steps: tableSteps(60, 'x').map((s) => s.id) },
    ]);
    const checks = run({ definition: def });
    const found = checks.filter((c) => c.text.startsWith('60 steps read the repeating section'));
    expect(found).toEqual([
      {
        tone: 'warn',
        text: '60 steps read the repeating section result_tables: each runs once per occurrence, so a step meant for one block reads them all. Give each kind of block its own repeating section.',
        link: { label: 'Open Sections', subTab: 'sections' },
        subTabs: ['sections', 'pipeline'],
      },
    ]);
  });

  it('is quiet for two steps, and for one repeating section each', () => {
    expect(
      sharedRepeatSteps({
        document: { sections: sections(['r']) },
        pipeline: tableSteps(2, 'r'),
      }),
    ).toEqual([]);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(
      sharedRepeatSteps({
        document: { sections: sections(ids) },
        pipeline: ids.map((id) => ({
          type: 'extract',
          id: `s${id}`,
          table: `t${id}`,
          sections: [id],
        })),
      }),
    ).toEqual([]);
  });

  it('ignores non-repeating sections and steps without a table', () => {
    const steps = Array.from({ length: 4 }, (_, i) => ({
      type: 'extract',
      id: `s${i}`,
      fields: ['f'],
      sections: ['r'],
    }));
    expect(sharedRepeatSteps({ document: { sections: sections(['r']) }, pipeline: steps })).toEqual(
      [],
    );
    expect(
      sharedRepeatSteps({
        document: { sections: [{ id: 'r' }] },
        pipeline: tableSteps(4, 'r'),
      }),
    ).toEqual([]);
  });

  it('warns for each group of three or more tables with the same columns', () => {
    const def = { outputs: { fields: [], tables: tables(60, 5) } };
    expect(sameShapeTables(def)).toHaveLength(5);
    const found = run({ definition: def }).filter((c) =>
      c.text.includes('tables have the same columns'),
    );
    expect(found).toHaveLength(5);
    expect(found[0]).toEqual({
      tone: 'warn',
      text: '12 tables have the same columns (a0, b0): one table with columns telling them apart (study, batch) is usually better.',
      link: { label: 'Open Outputs', subTab: 'outputs' },
      subTabs: ['outputs'],
    });
  });

  it('is quiet for two same-shape tables', () => {
    expect(sameShapeTables({ outputs: { tables: tables(2, 1) } })).toEqual([]);
  });
});
