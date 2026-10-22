import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { namingInputs, parsePattern, patternVariables, resolvePattern } from '../src/index.js';

interface InputCase {
  name: string;
  document: { fields: Record<string, { value: unknown }> };
  jobId: string;
  recipe: { id: string; version: number };
  source: { filename: string; sha256: string };
  publishedAt: string;
  naming: Record<string, string>;
}
interface PatternCase {
  pattern: string;
  naming: Record<string, string>;
  value?: string;
  unresolved?: string[];
  error?: string;
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/naming.json', import.meta.url), 'utf8'),
) as { inputs: InputCase[]; patterns: PatternCase[] };

/** The shared naming fixture: the worker builds the same inputs (test_bridge_naming.py). */
describe('naming inputs', () => {
  it.each(fixture.inputs.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(
      namingInputs({
        fields: c.document.fields,
        jobId: c.jobId,
        recipe: c.recipe,
        source: c.source,
        publishedAt: c.publishedAt,
      }),
    ).toEqual(c.naming);
  });
});

describe('patterns', () => {
  it.each(fixture.patterns.map((c) => [c.pattern, c] as const))('%s', (pattern, c) => {
    const parsed = parsePattern(pattern);
    if (c.error) {
      expect(parsed).toEqual({ error: c.error });
      expect(() => resolvePattern(pattern, c.naming)).toThrow(c.error);
      return;
    }
    expect(parsed).not.toHaveProperty('error');
    const resolved = resolvePattern(pattern, c.naming);
    expect(resolved).toEqual(
      c.value !== undefined ? { value: c.value } : { unresolved: c.unresolved },
    );
  });

  it('lists the variables a pattern uses, once each, in order', () => {
    expect(patternVariables("{field:a|date} {field:a} {'x'} {job.id}")).toEqual([
      'field:a',
      'date',
      'job.id',
    ]);
    expect(patternVariables('{oops')).toEqual([]);
  });
});
