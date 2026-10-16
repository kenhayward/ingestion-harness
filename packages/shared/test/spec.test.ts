import { describe, expect, it } from 'vitest';
import { captureGroups, DocumentSpecSchema } from '../src/spec.js';

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

  it('accepts copy selection and page images with defaults', () => {
    const spec = DocumentSpecSchema.parse({
      ...valid,
      document: { ...valid.document, copies: { anchor: '^APPROVAL' } },
      extractions: [{ ...valid.extractions[0], pageImages: [1, 2] }],
    });
    expect(spec.document.copies?.select).toBe('last');
    expect(spec.extractions[0]?.pageImages).toEqual([1, 2]);
    expect(DocumentSpecSchema.parse(valid).extractions[0]?.pageImages).toEqual([]);
    expect(
      DocumentSpecSchema.safeParse({
        ...valid,
        extractions: [{ ...valid.extractions[0], pageImages: [0] }],
      }).success,
    ).toBe(false);
  });

  describe('chunked extractions', () => {
    const arraySchema = {
      type: 'object',
      properties: { rows: { type: 'array' }, note: { type: 'string' } },
    };
    const twoSections = {
      sections: [
        { id: 'header', anchor: '^HEADER' },
        { id: 'body', anchor: '^BODY' },
      ],
    };
    const chunked = (overrides: Record<string, unknown>) =>
      DocumentSpecSchema.safeParse({
        ...valid,
        document: twoSections,
        extractions: [
          {
            ...valid.extractions[0],
            schema: arraySchema,
            chunkPages: 1,
            mergePath: 'rows',
            ...overrides,
          },
        ],
      });

    it('accepts chunkPages + mergePath and defaults maxTokens', () => {
      const result = chunked({ maxTokens: 32000 });
      expect(result.success).toBe(true);
      expect(result.data?.extractions[0]?.maxTokens).toBe(32000);
      expect(DocumentSpecSchema.parse(valid).extractions[0]?.maxTokens).toBe(64000);
    });

    it.each([
      [{ mergePath: undefined }, 'mergePath'],
      [{ mergePath: 'note' }, 'array'],
      [{ sections: ['header', 'body'] }, 'exactly one section'],
    ])('rejects %j', (overrides, message) => {
      const result = chunked(overrides);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(message);
    });
  });

  describe('checks', () => {
    const base = { id: 'c', values: 'head.rows[*].a', reference: 'head.rows[*].b' };
    const withCheck = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      DocumentSpecSchema.safeParse({ ...valid, checks: [{ ...base, ...check }], ...extra });

    it('parses checks with defaults and lets outputs read from them', () => {
      const result = withCheck(
        {},
        {
          outputs: [
            ...valid.outputs,
            { id: 'c_csv', format: 'csv', from: 'c', columns: [{ name: 'v', path: 'value' }] },
          ],
        },
      );
      expect(result.success).toBe(true);
      expect(result.data?.checks[0]?.maxDistance).toBe(2);
      expect(DocumentSpecSchema.parse(valid).checks).toEqual([]);
    });

    it.each([
      [{ values: 'nope.rows[*].a' }, 'unknown extraction'],
      [{ id: 'head' }, 'duplicate'],
      [{ aliases: 'other.rows[*].x' }, 'aliases must start with'],
    ])('rejects %j', (check, message) => {
      const result = withCheck(check);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(message);
    });
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

describe('repeating sections in the spec format', () => {
  it.each([
    [String.raw`BATCH\s+(\w+)`, 1, []],
    [String.raw`(?:BATCH|LOT)\s+(\w+)`, 1, []],
    [String.raw`(?P<key>\w+)`, 1, ['key']],
    [String.raw`(?<key>\w+)`, 1, ['key']],
    ['(?=x)(?!y)(?<=z)(?<!w)', 0, []],
    [String.raw`\(not a group\)`, 0, []],
    ['[(]x', 0, []],
    [String.raw`[\]()]x`, 0, []],
    ['[]()]x', 0, []],
    ['(a)(b)', 2, []],
  ] as const)('captureGroups(%s)', (pattern, count, names) => {
    expect(captureGroups(pattern)).toEqual({ count, names });
  });

  it('refuses repeat in a legacy spec', () => {
    const spec = {
      ...valid,
      document: { sections: [{ id: 'header', anchor: '^HEADER', repeat: true }] },
    };
    const result = DocumentSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.message).join('\n')).toContain(
      'repeat is supported in recipes only',
    );
  });
});
