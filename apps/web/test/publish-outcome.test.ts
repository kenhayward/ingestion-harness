import { describe, expect, it } from 'vitest';
import { publishedMessage } from '../src/templates/github/outcome.js';

describe('publishedMessage', () => {
  it.each([
    [undefined, 'Published v4'],
    [null, 'Published v4'],
    [
      { kind: 'pushed', commit: 'a1b2c3d4e5f6', commitUrl: 'u' },
      'Published v4 · pushed to GitHub (commit a1b2c3d)',
    ],
    [{ kind: 'pr', prNumber: 42, prUrl: 'u' }, 'Published v4 · pull request #42 opened'],
    [
      { kind: 'skipped', reason: 'Link your GitHub account in Profile to push.' },
      'Published v4 · not pushed: Link your GitHub account in Profile to push.',
    ],
    [
      { kind: 'failed', reason: 'boom' },
      'Published v4 · GitHub push failed: try again from Versions.',
    ],
  ] as const)('%j', (outcome, text) => {
    expect(publishedMessage(4, outcome)).toBe(text);
  });
});
