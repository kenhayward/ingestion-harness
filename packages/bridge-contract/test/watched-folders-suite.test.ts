import { describe, expect, it } from 'vitest';
import { WATCH_CHECKS, watchedFoldersSuite } from '../src/index.js';
import { SOURCES_KEY, SOURCES_PLACE, sourcesFake, type SourceFault } from './sources-fake.js';

const run = (faults?: SourceFault[], fetchImpl = sourcesFake(faults)) =>
  watchedFoldersSuite({
    url: 'http://sink.test',
    key: SOURCES_KEY,
    instanceId: 'main',
    credential: { token: 'x' },
    source: SOURCES_PLACE,
    fetchImpl,
  });

describe('watched folders conformance', () => {
  it('a sink serving the contract passes every check', async () => {
    const results = await run();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(Object.values(WATCH_CHECKS));
  });

  it('a move that is not idempotent fails, naming the error', async () => {
    const bad = (await run(['move-not-idempotent'])).filter((r) => !r.ok);
    expect(bad.map((r) => r.name)).toContain(WATCH_CHECKS.moveAgain);
    expect(bad.find((r) => r.name === WATCH_CHECKS.moveAgain)?.detail).toContain('not_found');
  });

  it('a missing folder answered with the wrong code fails', async () => {
    const bad = (await run(['missing-folder-wrong-code'])).filter((r) => !r.ok);
    expect(bad.map((r) => r.name)).toContain(WATCH_CHECKS.missingFolder);
  });

  it('a sink at version 3 is skipped, not failed', async () => {
    const v3: typeof fetch = async (input, init) => {
      if (!String(input).endsWith('/describe')) return sourcesFake()(input, init);
      const { readFileSync } = await import('node:fs');
      const d = readFileSync(new URL('./fixtures/describe-v3.json', import.meta.url), 'utf8');
      return new Response(d, { status: 200 });
    };
    const results = await run(undefined, v3);
    expect(results.map((r) => r.name)).toEqual(Object.values(WATCH_CHECKS));
    expect(results.every((r) => r.ok && r.detail?.startsWith('skipped'))).toBe(true);
  });
});
