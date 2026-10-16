import { describe, expect, it } from 'vitest';
import {
  isCalendarTag,
  nextCalendarTag,
  resolveVersion,
  shouldWait,
  waitForTag,
} from '../../../deploy/scripts/version.mjs';

describe('nextCalendarTag', () => {
  const at = new Date('2026-10-17T00:30:00Z');
  it.each<[string, Date, string[], string]>([
    ['the first tag of the day', at, [], '2026.10.17.1'],
    [
      'one past the highest of the day',
      at,
      ['2026.10.17.1', '2026.10.17.2', '2026.10.16.9'],
      '2026.10.17.3',
    ],
    ['numbers, not text', at, ['2026.10.17.9', '2026.10.17.10'], '2026.10.17.11'],
    ['ignoring other tags', at, ['v1', '2026.10.17.x', '2026.10.17.0'], '2026.10.17.1'],
    ['the UTC date', new Date('2026-10-16T23:59:59-02:00'), ['2026.10.16.4'], '2026.10.17.1'],
  ])('%s', (_name, now, tags, expected) => {
    expect(nextCalendarTag(now, tags)).toBe(expected);
  });
});

describe('isCalendarTag', () => {
  it.each([
    ['2026.10.17.3', true],
    ['v2026.10.17.3', false],
    ['2026.10.17', false],
    ['2026.10.17.0', false],
    ['2026.10.17.3+dirty', false],
  ])('%s → %s', (tag, expected) => {
    expect(isCalendarTag(tag)).toBe(expected);
  });
});

describe('resolveVersion', () => {
  const base = { commit: 'abc1234', dirty: false };
  it('a tagged clean build is its tag', () => {
    expect(
      resolveVersion({
        ...base,
        headTag: '2026.10.17.3',
        nearestTag: '2026.10.17.3',
        previousTag: '2026.10.17.2',
      }),
    ).toEqual({
      version: '2026.10.17.3',
      previous: '2026.10.17.2',
      commit: 'abc1234',
      imageTag: '2026.10.17.3',
    });
  });

  it('a tagged build with local changes is marked dirty and keeps the hash image tag', () => {
    expect(
      resolveVersion({
        ...base,
        dirty: true,
        headTag: '2026.10.17.3',
        nearestTag: '2026.10.17.3',
        previousTag: '2026.10.17.2',
      }),
    ).toMatchObject({ version: '2026.10.17.3+dirty', imageTag: 'abc1234' });
  });

  it('an untagged build is the nearest tag plus the hash', () => {
    const input = {
      ...base,
      headTag: null,
      nearestTag: '2026.10.17.2',
      previousTag: '2026.10.17.2',
    };
    expect(resolveVersion(input)).toEqual({
      version: '2026.10.17.2+abc1234',
      previous: '2026.10.17.2',
      commit: 'abc1234',
      imageTag: 'abc1234',
    });
    expect(resolveVersion({ ...input, dirty: true }).version).toBe('2026.10.17.2+abc1234.dirty');
  });

  it('a build with no tag in its history is dev', () => {
    const input = { ...base, headTag: null, nearestTag: null, previousTag: null };
    expect(resolveVersion(input)).toEqual({
      version: 'dev+abc1234',
      previous: '',
      commit: 'abc1234',
      imageTag: 'abc1234',
    });
    expect(resolveVersion({ ...input, dirty: true }).version).toBe('dev+abc1234.dirty');
  });
});

describe('shouldWait', () => {
  it.each([
    [{ headTag: null, onMain: true, untagged: false }, true],
    [{ headTag: null, onMain: true, untagged: true }, false],
    [{ headTag: null, onMain: false, untagged: false }, false],
    [{ headTag: '2026.10.17.3', onMain: true, untagged: false }, false],
  ])('%j → %s', (input, expected) => {
    expect(shouldWait(input)).toBe(expected);
  });
});

describe('waitForTag', () => {
  function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
  }

  it('returns the tag once CI has pushed it', async () => {
    const c = clock();
    const answers = [null, null, '2026.10.17.4'];
    const tag = await waitForTag({ check: async () => answers.shift() ?? null, ...c });
    expect(tag).toBe('2026.10.17.4');
    expect(c.sleeps).toEqual([30_000, 30_000]);
  });

  it('gives up after 15 minutes', async () => {
    const c = clock();
    expect(await waitForTag({ check: async () => null, ...c })).toBeNull();
    expect(c.now()).toBeGreaterThanOrEqual(900_000);
    expect(c.sleeps.length).toBeLessThanOrEqual(31);
  });
});
