import { describe, expect, it } from 'vitest';
import { lockFor } from '../src/access/lockout.js';

const M = 60_000;
describe('lockFor', () => {
  it.each([
    [1, null],
    [9, null],
    [10, 15 * M],
    [11, 30 * M],
    [12, 60 * M],
    [13, 120 * M],
    [14, 240 * M],
    [15, 480 * M],
    [16, 960 * M],
    [17, 1440 * M],
    [18, 1440 * M],
    [19, 1440 * M],
    [20, 'disable'],
    [25, 'disable'],
  ] as const)('%i failures -> %s', (n, expected) => {
    expect(lockFor(n)).toBe(expected);
  });
});
