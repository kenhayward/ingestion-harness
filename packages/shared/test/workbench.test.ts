import { describe, expect, it } from 'vitest';
import {
  BriefBodySchema,
  EMPTY_BRIEF,
  JobSummarySchema,
  PreparedTextSchema,
  PreparedTriageSchema,
  preparedTextKey,
  preparedTriageKey,
  SegmentDocumentSchema,
  SegmentationResultSchema,
  segmentationKey,
} from '../src/index.js';

describe('workbench contracts', () => {
  it('keys prepared text and triage by the PDF sha256 (mirrors worker storage.py)', () => {
    expect(preparedTextKey('abc')).toBe('prepared/abc/text.json');
    expect(preparedTriageKey('abc')).toBe('prepared/abc/triage.json');
  });

  it('fills a partial brief with empty strings and rejects unknown keys', () => {
    expect(BriefBodySchema.parse({ purpose: 'Batch records' })).toEqual({
      ...EMPTY_BRIEF,
      purpose: 'Batch records',
    });
    expect(BriefBodySchema.safeParse({ purpose: 'x', colour: 'red' }).success).toBe(false);
  });

  it('parses the prepared text and triage the worker writes', () => {
    expect(
      PreparedTextSchema.parse({
        sha256: 'abc',
        pages: [{ number: 1, text: 'HEADER', ocr: false }],
      }).pages[0]!.ocr,
    ).toBe(false);
    expect(
      PreparedTriageSchema.parse({
        sha256: 'abc',
        pageCount: 2,
        ocrPages: [2],
        chars: 40,
        ocrModel: 'local/olmocr-2-7b-1025',
      }).ocrPages,
    ).toEqual([2]);
  });

  it('accepts prepare jobs with a project', () => {
    const job = JobSummarySchema.shape.task.parse('prepare');
    expect(job).toBe('prepare');
    expect(JobSummarySchema.shape.projectId.parse(null)).toBeNull();
  });
});

describe('segmentation contracts', () => {
  it('keys a segmentation result by project and job (mirrors worker storage.py)', () => {
    expect(segmentationKey('letter', 'j1')).toBe('segmentation/letter/j1.json');
  });

  it('defaults page markers on and requires at least one section', () => {
    expect(SegmentDocumentSchema.parse({ sections: [{ id: 'all', anchor: '\\A' }] })).toEqual({
      sections: [{ id: 'all', anchor: '\\A', required: true }],
      pageMarkers: true,
    });
    expect(SegmentDocumentSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(
      SegmentDocumentSchema.safeParse({ sections: [{ id: 'Bad Id', anchor: 'x' }] }).success,
    ).toBe(false);
  });

  it('parses the grid the worker writes', () => {
    const result = SegmentationResultSchema.parse({
      anchorErrors: { totals: 'missing ), unterminated subpattern at position 0' },
      samples: [
        {
          sampleId: 's1',
          firstPage: 1,
          pageCount: 2,
          error: null,
          missingRequired: [],
          sections: [{ id: 'header', found: true, page: 1, line: 'INVOICE 42', chars: 30 }],
        },
      ],
    });
    expect(result.samples[0]!.sections[0]!.page).toBe(1);
  });

  it('accepts segment jobs', () => {
    expect(JobSummarySchema.shape.task.parse('segment')).toBe('segment');
  });
});
