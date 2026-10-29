import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceKeyProblem } from '../src/conversions.js';
import { watchSourcePath } from '../src/watches.js';

// Held equal to the worker's `watch_source_path` (worker/tests/test_watch_pure.py reads the same
// file). The fixture's file-name cases are the worker's alone: the TS side has no working name.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/watch-naming.json', import.meta.url), 'utf8'),
) as {
  sourcePaths: { fields: string[]; source: Record<string, string>; expected: string }[];
  sourceKeys: { key: string; repeat?: number; problem: string | null }[];
};

describe('watchSourcePath against the shared fixture', () => {
  it.each(fixture.sourcePaths)('$fields $source -> "$expected"', (c) => {
    expect(
      watchSourcePath(
        c.fields.map((id) => ({ id })),
        c.source,
      ),
    ).toBe(c.expected);
  });
});

// The worker's `source_key_problem` skips a file whose source key this rule refuses.
describe('sourceKeyProblem against the shared fixture', () => {
  it.each(fixture.sourceKeys)('$key x $repeat -> $problem', (c) => {
    expect(sourceKeyProblem(c.key.repeat(c.repeat ?? 1))).toBe(c.problem);
  });
});
