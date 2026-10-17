import { describe, expect, it } from 'vitest';
import {
  DEV_VERSION,
  REPO_URL,
  VersionInfoSchema,
  versionLink,
  type VersionInfo,
} from '../src/index.js';

const info = (version: string, previous: string | null): VersionInfo => ({
  version,
  previous,
  commit: 'abc1234',
});

describe('versionLink', () => {
  it.each<[VersionInfo, string | null]>([
    [info('2026.10.17.3', '2026.10.17.2'), `${REPO_URL}/compare/2026.10.17.2...2026.10.17.3`],
    [info('2026.10.17.3+dirty', '2026.10.17.2'), `${REPO_URL}/compare/2026.10.17.2...2026.10.17.3`],
    [info('2026.10.17.1', null), `${REPO_URL}/tree/2026.10.17.1`],
    [info('2026.10.17.2+abc1234', '2026.10.17.2'), `${REPO_URL}/compare/2026.10.17.2...abc1234`],
    [
      info('2026.10.17.2+abc1234.dirty', '2026.10.17.2'),
      `${REPO_URL}/compare/2026.10.17.2...abc1234`,
    ],
    [info('dev+abc1234', null), null],
    [DEV_VERSION, null],
  ])('%j links to %s', (v, expected) => {
    expect(versionLink(v)).toBe(expected);
  });

  it('takes another repository', () => {
    expect(versionLink(info('2026.10.17.1', null), 'https://example.com/r')).toBe(
      'https://example.com/r/tree/2026.10.17.1',
    );
  });
});

describe('VersionInfoSchema', () => {
  it('accepts a dev build and needs a commit', () => {
    expect(VersionInfoSchema.parse({ version: 'dev', previous: null, commit: 'x' })).toEqual({
      version: 'dev',
      previous: null,
      commit: 'x',
    });
    expect(VersionInfoSchema.safeParse({ version: 'dev', previous: null }).success).toBe(false);
  });
});
