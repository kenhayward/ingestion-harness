import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF, candidateInBrief, type BriefBody } from '../src/index.js';

const brief = (o: Partial<BriefBody>): BriefBody => ({ ...EMPTY_BRIEF, ...o });

describe('candidateInBrief', () => {
  it.each<[string, string, BriefBody | null, boolean]>([
    [
      'a snake_case name in the outputs prose',
      'due_date',
      brief({ outputs: 'Due date (DMY), total' }),
      true,
    ],
    [
      'a CSV header of the example output',
      'invoice_number',
      brief({ exampleOutput: 'invoice_number,total\nINV-1,10' }),
      true,
    ],
    ['a camelCase name', 'poNumber', brief({ outputs: 'The PO number, if printed' }), true],
    [
      'a saved survey answer',
      'supplier_vat_number',
      brief({ answers: [{ question: 'VAT?', answer: 'Yes, capture the supplier VAT number' }] }),
      true,
    ],
    ['only part of the name', 'discount_percent', brief({ outputs: 'discount amount' }), false],
    ['inside another word', 'vat', brief({ outputs: 'private notes' }), false],
    ['only in purpose or glossary', 'total', brief({ purpose: 'total', glossary: 'total' }), false],
    ['no brief yet', 'total', null, false],
    ['a name without letters or digits', '__', brief({ outputs: 'anything' }), false],
  ])('%s', (_name, name, b, expected) => {
    expect(candidateInBrief(name, b)).toBe(expected);
  });
});
