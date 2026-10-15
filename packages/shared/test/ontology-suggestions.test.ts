import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OntologySuggestionsViewSchema,
  SuggestParamsSchema,
  SuggestionRecordSchema,
  ontologyLibraryKey,
  ontologySuggestionsKey,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ontology-suggestions.json', import.meta.url), 'utf8'),
) as {
  libraryKeys: {
    name: string;
    versions: { id: string; version: number }[];
    model: string | null;
    key: string;
  }[];
  params: unknown;
  record: unknown;
};

describe('ontology suggestions contract', () => {
  it.each(fixture.libraryKeys)('libraryKey: $name', ({ versions, model, key }) => {
    expect(ontologyLibraryKey(versions, model)).toBe(key);
  });

  it('parses the shared params and record', () => {
    expect(SuggestParamsSchema.parse(fixture.params)).toEqual(fixture.params);
    expect(SuggestionRecordSchema.parse(fixture.record)).toEqual(fixture.record);
  });

  it('refuses unknown keys in params', () => {
    expect(SuggestParamsSchema.safeParse({ ...(fixture.params as object), extra: 1 }).success).toBe(
      false,
    );
  });

  it('has a view with no record', () => {
    expect(
      OntologySuggestionsViewSchema.parse({
        record: null,
        running: false,
        failed: null,
        stale: null,
      }),
    ).toEqual({ record: null, running: false, failed: null, stale: null });
  });

  it('keys records per project and job', () => {
    expect(ontologySuggestionsKey('letter', 'job-1')).toBe(
      'ontology-suggestions/letter/job-1.json',
    );
  });
});
