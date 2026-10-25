import { describe, expect, it } from 'vitest';
import {
  DecomposeParamsSchema,
  ITEM_OUTCOMES,
  decompositionReportKey,
  decompositionSourceKey,
} from '../src/index.js';

const BATCH = '0f6c1c52-3a54-4c7e-9a43-6a1d1f0e2b11';
const ITEM = '9b2e4a7d-5c10-4f2e-8d3a-1e7c5a9b4f20';

describe('item outcomes', () => {
  it('are exactly the twelve', () => {
    expect([...ITEM_OUTCOMES]).toEqual([
      'queued',
      'decomposing',
      'delivering',
      'created',
      'updated',
      'already_loaded',
      'duplicate',
      'in_flight',
      'changed_in_target',
      'read_back_mismatch',
      'unresolved',
      'failed',
    ]);
  });
});

describe('decompose params', () => {
  it('parse a decompose job', () => {
    const params = {
      batchId: BATCH,
      itemId: ITEM,
      targetId: 'default',
      sourceKey: 'policies/leave.docx',
      force: false,
    };
    expect(DecomposeParamsSchema.parse(params)).toEqual(params);
    expect(() => DecomposeParamsSchema.parse({ ...params, extra: 1 })).toThrow();
    expect(() => DecomposeParamsSchema.parse({ ...params, sourceKey: '' })).toThrow();
  });
});

describe('decomposition keys', () => {
  it('name the source and the report (mirrored in worker storage.py)', () => {
    expect(decompositionSourceKey('b1', 'i1', 'docx')).toBe('decompositions/b1/i1.docx');
    expect(decompositionReportKey('b1', 'i1')).toBe('decompositions/b1/i1.report.json');
  });
});
