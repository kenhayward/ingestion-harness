import { describe, expect, it } from 'vitest';
import signatures from './fixtures/mapping-signature.json' with { type: 'json' };
import answers from './fixtures/remembered-answers.json' with { type: 'json' };
import {
  answerKey,
  answersOf,
  answerTerms,
  GENERIC_NAMES,
  RememberedAnswerSchema,
  signatureOf,
  TRAILING_UNITS,
  UNIT_SPELLINGS,
  type SignatureInput,
} from '../src/mapping-memory.js';

describe('signatureOf (shared fixture mapping-signature.json)', () => {
  it.each(signatures.cases)('$input.name', ({ input, key, unit, generic }) => {
    expect(signatureOf(input as SignatureInput)).toMatchObject({ key, unit, generic });
  });

  it('keeps one signature for a name in any table unless the name is generic', () => {
    const a = signatureOf({ kind: 'column', name: 'Batch number', type: 'text', table: 'A' });
    const b = signatureOf({ kind: 'field', name: 'batch_number', type: 'text' });
    expect(a.key).toBe(b.key);
    const m1 = signatureOf({ kind: 'column', name: 'Mean', type: 'number', table: 'Dissolution' });
    const m2 = signatureOf({ kind: 'column', name: 'Mean', type: 'number', table: 'Assay' });
    expect(m1.key).not.toBe(m2.key);
  });

  it('uses the word lists the fixture holds (the worker checks the same lists)', () => {
    expect([...GENERIC_NAMES]).toEqual(signatures.generic);
    expect(UNIT_SPELLINGS).toEqual(signatures.units);
    expect([...TRAILING_UNITS]).toEqual(signatures.trailingUnits);
  });
});

describe('answersOf (shared fixture remembered-answers.json)', () => {
  it.each(answers.cases)('$name', ({ definition, answers: expected }) => {
    const got = answersOf(definition as Record<string, unknown>).map(
      ({ path, signature, answer }) => ({ path, signature, answer }),
    );
    expect(got).toEqual(expected);
  });

  it('records the pinned ontologies with each answer', () => {
    const [first] = answersOf(answers.cases[0]!.definition as Record<string, unknown>);
    expect(first!.ontologies).toEqual(['exo']);
  });

  it('gives equal answers equal keys whatever the key order', () => {
    const a = RememberedAnswerSchema.parse({ form: 'node', class: 'x:C', value: 'x:v' });
    const b = RememberedAnswerSchema.parse({ value: 'x:v', class: 'x:C', form: 'node' });
    expect(answerKey(a)).toBe(answerKey(b));
  });

  it('lists the terms an answer uses, not its templates or unit', () => {
    expect(
      answerTerms({ form: 'node', class: 'x:C', value: 'x:v', unit: 'unit:PERCENT' }).sort(),
    ).toEqual(['x:C', 'x:v']);
    expect(answerTerms({ form: 'concept', property: 'x:p', values: { a: 'x:A' } }).sort()).toEqual([
      'x:A',
      'x:p',
    ]);
  });
});
