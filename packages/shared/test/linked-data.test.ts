import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LinkedDataBodySchema,
  baseIriProblem,
  baseIriWarnings,
  effectiveBaseIri,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/base-iri.json', import.meta.url), 'utf8'),
) as {
  effective: { customerSlug: string | null; baseIri: string | null; base: string | null }[];
  problems: { iri: string; problem: string | null }[];
};

describe('the effective base IRI (shared with the worker)', () => {
  it.each(fixture.effective.map((c) => [c.customerSlug, c.baseIri, c.base] as const))(
    'slug %s, base %s → %s',
    (customerSlug, baseIri, base) => {
      expect(effectiveBaseIri({ customerSlug, baseIri })).toBe(base);
    },
  );
});

describe('base IRI rules', () => {
  it.each(fixture.problems.map((c) => [c.iri, c.problem] as const))('%s', (iri, problem) => {
    expect(baseIriProblem(iri)).toBe(problem);
  });

  it('warns about words that tie an IRI to an environment or a product', () => {
    expect(baseIriWarnings('https://data.acme.example/ct/')).toEqual([]);
    expect(baseIriWarnings('https://staging.acme.example/sparql/v2/')).toEqual([
      'staging',
      'sparql',
      'v2',
    ]);
  });

  it('parses the settings body', () => {
    const ok = { customerName: 'Acme', customerSlug: 'acme', baseIri: null };
    expect(LinkedDataBodySchema.safeParse(ok).success).toBe(true);
    expect(LinkedDataBodySchema.safeParse({ ...ok, customerSlug: 'Acme Co' }).success).toBe(false);
    expect(LinkedDataBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
