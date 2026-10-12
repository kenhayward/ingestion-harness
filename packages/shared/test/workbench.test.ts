import { describe, expect, it } from 'vitest';
import {
  BriefBodySchema,
  EMPTY_BRIEF,
  JobSummarySchema,
  PreparedTextSchema,
  PreparedTriageSchema,
  preparedTextKey,
  preparedTriageKey,
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
