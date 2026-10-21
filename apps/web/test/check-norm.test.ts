import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalise } from '../src/review/effective.js';

const fixture = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../packages/shared/test/fixtures/check-norm.json',
    ),
    'utf8',
  ),
) as { cases: { input: string; norm: string }[] };

describe('check value normalisation (held in step with the worker)', () => {
  it.each(fixture.cases)('normalises $input', ({ input, norm }) => {
    expect(normalise(input)).toBe(norm);
  });
});
