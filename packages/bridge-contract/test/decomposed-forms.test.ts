import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DecomposedDocumentSchema, gridForms, normalise, textForm } from '../src/index.js';

interface Vector {
  name: string;
  document: unknown;
  text_form: string[];
  grid_forms: Record<string, string[][]>;
}

const vectors = JSON.parse(
  readFileSync(new URL('../vectors/comparison-forms.json', import.meta.url), 'utf8'),
) as Vector[];

/** The shared comparison forms: the TypeScript forms must reproduce the vectors exactly. */
describe('decomposed document comparison forms', () => {
  it('reproduces every vector', () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      const doc = DecomposedDocumentSchema.parse(v.document);
      expect(doc, v.name).toEqual(v.document);
      expect(textForm(doc), v.name).toEqual(v.text_form);
      expect(gridForms(doc), v.name).toEqual(v.grid_forms);
    }
  });

  it('rejects unknown fields', () => {
    const doc = structuredClone(vectors[0]!.document) as Record<string, unknown>;
    expect(DecomposedDocumentSchema.safeParse(doc).success).toBe(true);
    expect(DecomposedDocumentSchema.safeParse({ ...doc, bogus: 1 }).success).toBe(false);
    const text = { kind: 'text', text: 'a', marks: [], bogus: 1 };
    const withBadInline = {
      ...doc,
      blocks: [{ kind: 'paragraph', id: 'p', inlines: [text] }],
    };
    expect(DecomposedDocumentSchema.safeParse(withBadInline).success).toBe(false);
  });

  it('rejects snake_case keys', () => {
    const table = {
      kind: 'table',
      id: 't',
      column_widths: [1],
      headerRows: 0,
      rows: [],
    };
    const doc = {
      blocks: [table],
      sections: [],
      images: [],
      equations: [],
      notes: [],
      properties: [],
      report: [],
    };
    expect(DecomposedDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it.each([
    ['  a  b ', 'a b'],
    ['a  b', 'a b'],
    ['a\nb\tc', 'a b c'],
    ['é', 'é'],
    ['a  b　', 'a b'],
    ['a​b', 'a​b'],
    ['', ''],
    [' \n ', ''],
  ])('normalises %j', (raw, expected) => {
    expect(normalise(raw)).toBe(expected);
  });
});
