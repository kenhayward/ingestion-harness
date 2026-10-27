import { describe, expect, it } from 'vitest';
import {
  DecomposeParamsSchema,
  ITEM_OUTCOMES,
  ItemOutcomeSchema,
  RejectDecisionSchema,
  ReviewDecisionSchema,
  decompositionHeldImageKey,
  decompositionHeldManifestKey,
  decompositionHeldPageKey,
  decompositionReportKey,
  decompositionSourceKey,
  hasControlCharacter,
  sourceKeyProblem,
} from '../src/index.js';

const BATCH = '0f6c1c52-3a54-4c7e-9a43-6a1d1f0e2b11';
const ITEM = '9b2e4a7d-5c10-4f2e-8d3a-1e7c5a9b4f20';

describe('item outcomes', () => {
  it('are exactly the fourteen', () => {
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
      'awaiting_review',
      'rejected',
    ]);
  });

  it('take the review outcomes', () => {
    expect(ItemOutcomeSchema.parse('awaiting_review')).toBe('awaiting_review');
    expect(ItemOutcomeSchema.parse('rejected')).toBe('rejected');
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

  it('may say the held document is approved', () => {
    const params = {
      batchId: BATCH,
      itemId: ITEM,
      targetId: 'default',
      sourceKey: 'policies/leave.pdf',
      force: false,
      approved: true,
    };
    expect(DecomposeParamsSchema.parse(params)).toEqual(params);
  });
});

describe('review decisions', () => {
  it('approve with an optional note', () => {
    expect(ReviewDecisionSchema.parse({})).toEqual({});
    expect(ReviewDecisionSchema.parse({ note: 'ok' })).toEqual({ note: 'ok' });
  });

  it('reject with a note', () => {
    expect(RejectDecisionSchema.parse({ note: 'scanned twice' })).toEqual({ note: 'scanned twice' });
    expect(() => RejectDecisionSchema.parse({})).toThrow();
    expect(() => RejectDecisionSchema.parse({ note: '' })).toThrow();
  });
});

describe('decomposition keys', () => {
  it('name the source and the report (mirrored in worker storage.py)', () => {
    expect(decompositionSourceKey('b1', 'i1', 'docx')).toBe('decompositions/b1/i1.docx');
    expect(decompositionReportKey('b1', 'i1')).toBe('decompositions/b1/i1.report.json');
  });

  it('name the held files of a PDF (mirrored in worker storage.py)', () => {
    expect(decompositionHeldManifestKey('b1', 'i1')).toBe(
      'decompositions/b1/i1.held/manifest.json',
    );
    expect(decompositionHeldImageKey('b1', 'i1', 3)).toBe('decompositions/b1/i1.held/images/3');
    expect(decompositionHeldPageKey('b1', 'i1', 2)).toBe('decompositions/b1/i1.held/pages/2.jpg');
  });
});

describe('source keys', () => {
  it.each(['a.docx', 'Manuals/Pumps/intro.docx', 'a b/c (1).docx', 'é/ü.docx', '.hidden/a.docx'])(
    'take %s',
    (key) => {
      expect(sourceKeyProblem(key)).toBeNull();
    },
  );

  it.each([
    ['', /empty/],
    ['a'.repeat(1025), /1024/],
    ['a\u0000.docx', /control/],
    ['a\u001f.docx', /control/],
    ['a\u007f.docx', /control/],
    ['a\nb.docx', /control/],
    ['a\\b.docx', /backslash/],
    ['/a.docx', /start or end/],
    ['a/', /start or end/],
    ['a//b.docx', /empty part/],
    ['./a.docx', /`\.`/],
    ['a/../b.docx', /`\.\.`/],
    ['..', /`\.\.`/],
  ])('refuse %j', (key, reason) => {
    expect(sourceKeyProblem(key)).toMatch(reason);
  });

  it('judge the NFC form: 1024 composed characters are within the limit', () => {
    // e + combining acute (U+0301): 2048 code units, 1024 once composed.
    const decomposed = `e${String.fromCharCode(0x301)}`.repeat(1024);
    expect(decomposed).toHaveLength(2048);
    expect(sourceKeyProblem(decomposed)).toBeNull();
  });

  it('find control characters in file names too', () => {
    expect(hasControlCharacter('a\u0000.docx')).toBe(true);
    expect(hasControlCharacter('a.docx')).toBe(false);
  });

  it('decompose params refuse a key the rule refuses', () => {
    const params = { batchId: BATCH, itemId: ITEM, targetId: 'default', force: false };
    expect(() => DecomposeParamsSchema.parse({ ...params, sourceKey: '../a.docx' })).toThrow();
    expect(() => DecomposeParamsSchema.parse({ ...params, sourceKey: 'a/b.docx' })).not.toThrow();
  });
});
