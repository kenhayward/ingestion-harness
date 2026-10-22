import type { DestinationField } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { resolveDestination } from '../src/deliveries/destination.js';
import { SinkError } from '../src/sinks/port.js';

const fields: DestinationField[] = [
  { id: 'space', label: 'Space', kind: 'fixed', required: true, overridable: false, browse: true },
  { id: 'name', label: 'Name', kind: 'pattern', required: true, overridable: true, browse: false },
  {
    id: 'folder',
    label: 'Folder',
    kind: 'pattern',
    required: false,
    overridable: false,
    browse: false,
  },
];
const naming = { 'source.stem': 'scan', 'field:title': 'Q3', date: '2026-10-22' };
const target = { label: 'Fake target', destination: { space: 'reports', name: '{source.stem}' } };

const resolve = (over: {
  patterns?: Record<string, string>;
  overrides?: Record<string, string>;
  destination?: Record<string, string>;
  naming?: Record<string, string>;
}) =>
  resolveDestination({
    targetId: 'fake-target',
    target: { ...target, ...(over.destination ? { destination: over.destination } : {}) },
    fields,
    patterns: over.patterns ?? {},
    overrides: over.overrides ?? {},
    naming: over.naming ?? naming,
  });

/** The refusal a resolve threw. */
function refusal(run: () => unknown) {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(SinkError);
    return (err as SinkError).error;
  }
  throw new Error('expected a refusal');
}

describe('resolveDestination', () => {
  it("resolves the target's own pattern; the fixed field is kept", () => {
    expect(resolve({})).toEqual({ space: 'reports', name: 'scan' });
  });

  it("a recipe's pattern wins over the target's, and a reviewer's value over both", () => {
    expect(resolve({ patterns: { name: '{field:title} {date}' } })).toEqual({
      space: 'reports',
      name: 'Q3 2026-10-22',
    });
    expect(
      resolve({
        patterns: { name: '{field:title}' },
        overrides: { name: 'Chosen {not a pattern}' },
      }),
    ).toEqual({ space: 'reports', name: 'Chosen {not a pattern}' });
  });

  it('an optional pattern field left empty is left out', () => {
    expect(resolve({ patterns: { folder: '{field:missing}' } })).toEqual({
      space: 'reports',
      name: 'scan',
    });
  });

  it('a required pattern that resolves to nothing is pattern_unresolved', () => {
    expect(refusal(() => resolve({ patterns: { name: '{field:code}' } }))).toEqual({
      class: 'needs_user',
      code: 'pattern_unresolved',
      message: 'Fake target: Name resolves to nothing: the document has no field:code',
      details: { targetId: 'fake-target', field: 'name', variables: ['field:code'] },
    });
    expect(refusal(() => resolve({ destination: { space: 'reports' } }))).toMatchObject({
      code: 'pattern_unresolved',
      details: { field: 'name', variables: [] },
    });
  });

  it('refuses an override of a fixed, undeclared or not overridable field, and an unparsable pattern', () => {
    expect(refusal(() => resolve({ overrides: { space: 'x' } }))).toMatchObject({
      code: 'content_rejected',
      message: "Fake target: Space can't be changed for one document",
    });
    expect(refusal(() => resolve({ overrides: { folder: 'x' } }))).toMatchObject({
      code: 'content_rejected',
      message: "Fake target: Folder can't be changed for one document",
    });
    expect(refusal(() => resolve({ overrides: { colour: 'x' } }))).toMatchObject({
      code: 'content_rejected',
      message: 'Fake target: colour is not a destination field',
    });
    expect(refusal(() => resolve({ patterns: { space: 'x' } }))).toMatchObject({
      code: 'content_rejected',
      message: 'Fake target: Space is not a name pattern',
    });
    expect(refusal(() => resolve({ patterns: { name: '{nope}' } }))).toMatchObject({
      code: 'content_rejected',
      message: 'Fake target: Name: `{nope}`: unknown variable nope at 1',
    });
  });

  it('a target of a sink with no pattern fields is delivered as it is', () => {
    expect(
      resolveDestination({
        targetId: 'lake',
        target: { label: 'Lake', destination: { bucket: 'b', prefix: 'p/' } },
        fields: [
          {
            id: 'bucket',
            label: 'Bucket',
            kind: 'fixed',
            required: true,
            overridable: false,
            browse: false,
          },
          {
            id: 'prefix',
            label: 'Prefix',
            kind: 'fixed',
            required: false,
            overridable: false,
            browse: false,
          },
        ],
        patterns: {},
        overrides: {},
        naming: {},
      }),
    ).toEqual({ bucket: 'b', prefix: 'p/' });
  });
});

describe('resolveDestination, blank names', () => {
  it('a required name that resolves to blanks is unresolved, naming the field', () => {
    expect(refusal(() => resolve({ patterns: { name: '   ' } }))).toMatchObject({
      code: 'pattern_unresolved',
      message: 'Fake target: Name resolves to a blank name',
    });
    expect(resolve({ overrides: { name: '  Chosen  ' } })).toEqual({
      space: 'reports',
      name: 'Chosen',
    });
  });
});
