import { describe, expect, it } from 'vitest';
import {
  BriefBodySchema,
  DataPolicySchema,
  EMPTY_BRIEF,
  SurveyBodySchema,
  draftingKey,
  draftLogKey,
  runAttemptKey,
  exportKey,
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

  it('rejects duplicate section ids', () => {
    const result = SegmentDocumentSchema.safeParse({
      sections: [
        { id: 'a', anchor: 'x' },
        { id: 'a', anchor: 'y' },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('duplicate section id a');
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

  it('reads a grid stored before repeating sections', () => {
    const result = SegmentationResultSchema.parse({
      anchorErrors: {},
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
    expect(result.samples[0]!.keyIssues).toBeUndefined();
    expect(result.samples[0]!.sections[0]!.occurrences).toBeUndefined();
    expect(result.samples[0]!.sections[0]!.matches).toBeUndefined();
  });

  it('reads the occurrences of a repeating section', () => {
    const occurrence = { page: 2, line: 'Table 1: …', chars: 40, key: '4586783', keySource: 'own' };
    const result = SegmentationResultSchema.parse({
      anchorErrors: {},
      samples: [
        {
          sampleId: 's1',
          firstPage: 1,
          pageCount: 4,
          error: null,
          missingRequired: [],
          keyIssues: ['microbial: no occurrence for batch 4586785'],
          sections: [
            {
              id: 'appearance',
              found: true,
              page: 2,
              line: 'Table 1: …',
              chars: 40,
              occurrences: [occurrence],
              matches: 0,
            },
          ],
        },
      ],
    });
    expect(result.samples[0]!.sections[0]!.occurrences).toEqual([occurrence]);
    expect(result.samples[0]!.keyIssues).toEqual(['microbial: no occurrence for batch 4586785']);
  });

  it('accepts segment jobs', () => {
    expect(JobSummarySchema.shape.task.parse('segment')).toBe('segment');
  });
});

describe('drafting contracts', () => {
  it('keys a drafting result by project and job (mirrors worker storage.py)', () => {
    expect(draftingKey('letter', 'j1')).toBe('drafting/letter/j1.json');
  });

  it("keys a drafting job's model log, and an older run's attempt audit (mirrors storage.py)", () => {
    expect(draftLogKey('j1')).toBe('j1/draft-log.json');
    expect(runAttemptKey('j1', 'draft-survey', 2)).toBe('j1/draft-survey/attempt-2.json');
  });

  it('names an export bundle in the runs bucket (mirrors worker storage.py)', () => {
    expect(exportKey('letter', 'j1')).toBe('exports/letter/j1.zip');
  });

  it('accepts export jobs', () => {
    expect(JobSummarySchema.shape.task.parse('export')).toBe('export');
  });

  it('accepts only the two data policies', () => {
    expect(DataPolicySchema.parse('local')).toBe('local');
    expect(DataPolicySchema.safeParse('cloud').success).toBe(false);
  });

  it('keeps survey answers in the brief, defaulting to none', () => {
    expect(BriefBodySchema.parse({}).answers).toEqual([]);
    expect(
      BriefBodySchema.parse({ answers: [{ question: 'Which copy?', answer: 'Executed' }] }).answers,
    ).toEqual([{ question: 'Which copy?', answer: 'Executed' }]);
  });

  it('parses a survey body and rejects unknown keys', () => {
    const body = {
      summary: 'Process validation protocols, blank and executed.',
      structure: [
        { name: 'Approvals', description: 'Signatures', howToFind: 'PROTOCOL APPROVAL heading' },
      ],
      variants: ['Scanned executed copy follows the blank protocol'],
      candidates: [
        {
          name: 'protocol_number',
          description: 'Protocol id',
          where: 'page header',
          kind: 'field',
        },
      ],
      questions: [
        { question: 'Which copy should be extracted?', why: 'Some PDFs hold two copies' },
      ],
    };
    expect(SurveyBodySchema.parse(body)).toEqual(body);
    expect(SurveyBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it('reads seenIn on a candidate, and surveys written before it', () => {
    const candidate = { name: 'vat', description: 'VAT', where: 'totals', kind: 'field' as const };
    const body = {
      summary: 's',
      structure: [],
      variants: [],
      candidates: [candidate],
      questions: [],
    };
    expect(SurveyBodySchema.parse(body)).toEqual(body);
    const seen = { ...body, candidates: [{ ...candidate, seenIn: { n: 3, of: 6 } }] };
    expect(SurveyBodySchema.parse(seen)).toEqual(seen);
    const extra = { ...body, candidates: [{ ...candidate, seenIn: { n: 3, of: 6, x: 1 } }] };
    expect(SurveyBodySchema.safeParse(extra).success).toBe(false);
  });

  it('reads a grid written before suggestions as having none, and keeps suggestions', () => {
    const grid = { anchorErrors: {}, samples: [] };
    expect(SegmentationResultSchema.parse(grid)).toEqual({ ...grid, suggestions: [] });
    const suggestion = {
      section: 'supplier',
      sampleId: 's1',
      anchor: '^(From|Supplier|Vendor)\\b',
      reason: 'This sample labels it "Vendor:"; no alternative of the anchor matches that.',
    };
    expect(SegmentationResultSchema.parse({ ...grid, suggestions: [suggestion] })).toEqual({
      ...grid,
      suggestions: [suggestion],
    });
  });

  it('accepts draft jobs', () => {
    expect(JobSummarySchema.shape.task.parse('draft')).toBe('draft');
  });
});
