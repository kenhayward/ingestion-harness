import { healthOf, watchSourcePath, type WatchState } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { MemoryWatchRepo } from '../src/watches/repo.js';
import { watchContract } from './watch-contract.js';

watchContract('memory', async () => {
  const clock = { now: new Date('2026-10-29T12:00:00Z') };
  const repo = new MemoryWatchRepo(() => clock.now);
  return {
    repo,
    targetId: 'default',
    hooks: {
      setProblem: async (id, p) => repo.setProblem(id, p),
      setWaiting: async (id, n) => repo.setWaiting(id, n),
      addUnfinished: async (id, o) => repo.addUnfinished(id, o),
      recordFinish: async (id, d, h) =>
        repo.recordFinish(id, d, new Date(clock.now.getTime() - h * 3_600_000)),
      addEvent: async (id, l, m) => repo.addEvent(id, l, m),
    },
  };
});

describe('healthOf', () => {
  it.each<[WatchState, string | null, string]>([
    ['running', null, 'running'],
    ['running', 'folder gone', 'problem'],
    ['draining', null, 'draining'],
    ['draining', 'folder gone', 'problem'],
    ['stopped', null, 'stopped'],
    ['stopped', 'folder gone', 'stopped'],
  ])('%s with problem %j is %s', (state, problem, health) => {
    expect(healthOf({ state, problem })).toBe(health);
  });
});

describe('watchSourcePath', () => {
  const fields = [{ id: 'library' }, { id: 'folder' }, { id: 'sub' }];
  it.each<[Record<string, string>, string]>([
    [{ library: 'docs', folder: 'in', sub: 'x' }, 'docs/in/x'],
    [{ sub: 'x', library: 'docs' }, 'docs/x'],
    [{ library: 'docs', other: 'ignored', folder: 'in' }, 'docs/in'],
    [{ library: '/docs/', folder: ' in ' }, 'docs/in'],
    [{ other: 'only' }, ''],
    [{}, ''],
  ])('%j gives %j in field order, ignoring undeclared fields', (source, path) => {
    expect(watchSourcePath(fields, source)).toBe(path);
  });
});
