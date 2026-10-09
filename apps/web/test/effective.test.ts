import { describe, expect, it } from 'vitest';
import { effectiveView } from '../src/review/effective.js';
import { reviewData } from './review-fixture.js';

const edit = (overrides: Record<string, unknown>) => ({
  id: 1,
  at: '2026-10-09T10:00:00Z',
  field: null,
  table: null,
  row: null,
  column: null,
  oldValue: null,
  newValue: null,
  editor: 'kh',
  reason: null,
  ...overrides,
});

describe('effectiveView', () => {
  it('shows draft values with their evidence and pages', () => {
    const view = effectiveView(reviewData());
    expect(view.fields.executed_on).toMatchObject({ value: '2023-02-16', page: 3, edit: null });
    expect(view.tables.results![1]!.cells.value).toMatchObject({ value: 'Complies', edit: null });
  });

  it('overlays the latest edit per field and cell', () => {
    const view = effectiveView(
      reviewData({
        edits: [
          edit({ id: 1, field: 'executed_on', newValue: '17/02/2023' }),
          edit({ id: 2, field: 'executed_on', newValue: '18/02/2023' }),
          edit({ id: 3, table: 'results', row: 2, column: 'value', newValue: '98.5' }),
        ],
      }),
    );
    expect(view.fields.executed_on).toMatchObject({
      value: '18/02/2023',
      evidence: 'Made 16/02/2023',
    });
    expect(view.fields.executed_on!.edit?.id).toBe(2);
    expect(view.tables.results![1]!.cells.value!.value).toBe('98.5');
  });

  it('flags cells with normalisation issues and unmatched check values', () => {
    const view = effectiveView(reviewData());
    const [first, second] = view.tables.results!;
    expect(second!.cells.value!.flags).toEqual(["'Complies' is not a valid decimal"]);
    expect(second!.cells.batch!.flags).toEqual(['batch_check: unmatched']);
    expect(first!.cells.batch!.flags).toEqual([]);
    expect(second!.flagged).toBe(true);
    expect(first!.flagged).toBe(false);
  });

  it('clears an issue flag once the value has been edited', () => {
    const view = effectiveView(
      reviewData({
        edits: [edit({ table: 'results', row: 2, column: 'value', newValue: '98.5' })],
      }),
    );
    expect(view.tables.results![1]!.cells.value!.flags).toEqual([]);
  });

  it('counts what is still flagged', () => {
    expect(effectiveView(reviewData()).flaggedCount).toBe(2);
  });
});
