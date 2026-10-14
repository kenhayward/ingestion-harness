import { describe, expect, it } from 'vitest';
import {
  ProjectViewSchema,
  RetirementSchema,
  SpecSummarySchema,
  retiredMessage,
} from '../src/index.js';

const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };

describe('retirement', () => {
  it('words the refusal every route answers', () => {
    expect(retiredMessage('Supplier invoice')).toBe(
      'Supplier invoice is retired: unretire it to use it again',
    );
  });

  it('parses a retirement, with or without who', () => {
    expect(RetirementSchema.parse(retirement)).toEqual(retirement);
    expect(RetirementSchema.safeParse({ ...retirement, retiredBy: null }).success).toBe(true);
    expect(RetirementSchema.safeParse({ retiredBy: 'ken' }).success).toBe(false);
  });

  it('lists a document type with its retirement only when retired', () => {
    const summary = { id: 'letter', version: 1, title: 'Letter' };
    expect(SpecSummarySchema.parse(summary)).toEqual(summary);
    expect(SpecSummarySchema.parse({ ...summary, retired: retirement }).retired).toEqual(
      retirement,
    );
  });

  it('says whether a listed type is a legacy spec file or a recipe (legacy cards)', () => {
    const summary = { id: 'demo', version: 2, title: 'Demo v2' };
    expect(SpecSummarySchema.parse({ ...summary, kind: 'spec' }).kind).toBe('spec');
    expect(SpecSummarySchema.parse({ ...summary, kind: 'template' }).kind).toBe('template');
    expect(SpecSummarySchema.parse(summary).kind).toBeUndefined();
    expect(SpecSummarySchema.safeParse({ ...summary, kind: 'file' }).success).toBe(false);
  });

  it('requires the retirement on a project view (null when active)', () => {
    const view = {
      project: {
        id: 'letter',
        name: 'Letter',
        createdAt: '2026-10-01T00:00:00.000Z',
        dataPolicy: 'local',
        dataPolicyChangedAt: null,
        dataPolicyChangedBy: null,
        publishThreshold: 0.9,
        thresholdSetBy: null,
        thresholdSetAt: null,
      },
      draft: 1,
      published: null,
      brief: null,
    };
    expect(ProjectViewSchema.safeParse(view).success).toBe(false);
    expect(ProjectViewSchema.safeParse({ ...view, retired: null }).success).toBe(true);
    expect(ProjectViewSchema.safeParse({ ...view, retired: retirement }).success).toBe(true);
  });
});
