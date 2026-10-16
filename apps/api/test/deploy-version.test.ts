import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containedByCalendarTag,
  isCalendarTag,
  nearestCalendarTag,
  noBuildImageTag,
  onFirstParent,
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
  const waits = { headTag: null, onMain: true, taggedLater: false, fetched: true, untagged: false };
  it.each([
    ['an untagged commit on main', waits, true],
    ['when told not to', { ...waits, untagged: true }, false],
    ['a commit off main (a branch, a local commit)', { ...waits, onMain: false }, false],
    ['a tagged commit', { ...waits, headTag: '2026.10.17.3' }, false],
    [
      'a commit a later tag already contains (it will never be tagged)',
      { ...waits, taggedLater: true },
      false,
    ],
    ['offline: the fetch failed, so no tag can arrive', { ...waits, fetched: false }, false],
  ])('%s', (_name, input, expected) => {
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

describe('git lookups', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const commit = (m: string) => git('commit', '-q', '--allow-empty', '-m', m);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ih-ver-'));
    git('init', '-q', '-b', 'main');
    commit('one');
    git('tag', '2026.10.16.1');
    commit('two');
    git('tag', '2026.10.17.x'); // looks like a calendar tag, is not one
    commit('three');
    git('switch', '-q', '-c', 'feature');
    commit('feature work');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the nearest real calendar tag past a look-alike', () => {
    expect(nearestCalendarTag('HEAD', dir)).toBe('2026.10.16.1');
  });

  it('knows a merged PR commit is not on main itself', () => {
    expect(onFirstParent('main', 'main', dir)).toBe(true);
    expect(onFirstParent('main^1', 'main', dir)).toBe(true);
    expect(onFirstParent('feature', 'main', dir)).toBe(false);
  });

  it('knows when a later tag already contains a commit', () => {
    expect(containedByCalendarTag('main^1', dir)).toBe(false);
    git('tag', '2026.10.17.2', 'main');
    expect(containedByCalendarTag('main^1', dir)).toBe(true);
    expect(containedByCalendarTag('feature', dir)).toBe(true);
  });

  it('rolls back to the image a tagged build was given', () => {
    expect(noBuildImageTag(dir)).toBe('2026.10.17.2');
    git('tag', '-d', '2026.10.17.2');
    expect(noBuildImageTag(dir)).toBe(git('rev-parse', '--short', 'HEAD'));
  });
});
