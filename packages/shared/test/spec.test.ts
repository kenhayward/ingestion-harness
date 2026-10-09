import { describe, expect, it } from 'vitest';
import { DocumentSpecSchema } from '../src/spec.js';

const valid = {
  id: 'demo',
  version: 1,
  title: 'Demo',
  document: { sections: [{ id: 'header', anchor: '^HEADER' }] },
  extractions: [
    { id: 'head', sections: ['header'], prompt: 'prompts/head.md.j2', schema: { type: 'object' } },
  ],
  outputs: [{ id: 'all', format: 'json', from: '*' }],
};

describe('DocumentSpecSchema', () => {
  it('accepts a minimal valid spec and applies defaults', () => {
    const spec = DocumentSpecSchema.parse(valid);
    expect(spec.extractions[0]?.model).toBe('default');
    expect(spec.extractions[0]?.maxAttempts).toBe(2);
    expect(spec.document.sections[0]?.required).toBe(true);
    expect(spec.document.ocr).toBe('auto');
  });

  it('validates the OCR mode', () => {
    const withOcr = (ocr: string) =>
      DocumentSpecSchema.safeParse({ ...valid, document: { ...valid.document, ocr } });
    expect(withOcr('always').success).toBe(true);
    expect(withOcr('never').success).toBe(true);
    expect(withOcr('sometimes').success).toBe(false);
  });

  it('rejects extractions that reference unknown sections', () => {
    const result = DocumentSpecSchema.safeParse({
      ...valid,
      extractions: [{ ...valid.extractions[0], sections: ['nope'] }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unknown section');
  });

  it('rejects outputs that reference unknown extractions', () => {
    const result = DocumentSpecSchema.safeParse({
      ...valid,
      outputs: [{ id: 'x', format: 'csv', from: 'missing', columns: [{ name: 'a', path: 'a' }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate ids', () => {
    const result = DocumentSpecSchema.safeParse({
      ...valid,
      outputs: [valid.outputs[0], valid.outputs[0]],
    });
    expect(result.success).toBe(false);
  });
});
