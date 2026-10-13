import { describe, expect, it } from 'vitest';
import { isSourceFile, isWordDocument, SOURCE_ACCEPT } from '../src/documents.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('isSourceFile', () => {
  it.each([
    ['a PDF by type', new File(['x'], 'scan', { type: 'application/pdf' }), true],
    ['a PDF by name', new File(['x'], 'scan.PDF'), true],
    ['a .docx by type', new File(['x'], 'report', { type: DOCX }), true],
    // Windows browsers often send no type for .docx.
    ['a .docx by name, upper case, no type', new File(['x'], 'REPORT.DOCX'), true],
    ['a .doc', new File(['x'], 'old.doc', { type: 'application/msword' }), false],
    ['a .docm', new File(['x'], 'macros.docm'), false],
    ['text', new File(['x'], 'notes.txt', { type: 'text/plain' }), false],
  ])('%s', (_name, file, expected) => {
    expect(isSourceFile(file)).toBe(expected);
  });

  it('offers PDFs and .docx in file pickers', () => {
    expect(SOURCE_ACCEPT.split(',')).toEqual(['application/pdf', '.pdf', '.docx', DOCX]);
  });
});

describe('isWordDocument', () => {
  it('is true only for the .docx content type', () => {
    expect(isWordDocument(DOCX)).toBe(true);
    expect(isWordDocument('application/pdf')).toBe(false);
  });
});
