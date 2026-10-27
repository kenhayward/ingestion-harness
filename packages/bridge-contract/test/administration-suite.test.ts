import { describe, expect, it } from 'vitest';
import { ADMIN_CHECKS, administrationSuite } from '../src/index.js';
import { adminFake, FAKE_KEY, type Faults } from './admin-fake.js';

const run = (faults?: Faults) =>
  administrationSuite({
    url: 'http://sink.test',
    key: FAKE_KEY,
    instanceFields: { address: 'https://new.example.test' },
    fetchImpl: adminFake(faults),
  });

const failed = async (faults: Faults) =>
  (await run(faults)).filter((r) => !r.ok).map((r) => r.name);

describe('administration conformance', () => {
  it('a sink serving the contract passes every check', async () => {
    const results = await run();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(Object.values(ADMIN_CHECKS));
  });

  it('a list that shows a secret fails', async () => {
    expect(await failed({ leakToken: true })).toContain(ADMIN_CHECKS.secretOnce);
  });

  it('renaming a locked instance fails', async () => {
    expect(await failed({ renameLocked: true })).toContain(ADMIN_CHECKS.lockedInstance);
  });

  it('a missing audit entry fails', async () => {
    expect(await failed({ noAudit: true })).toContain(ADMIN_CHECKS.audit);
  });

  it('adding a taken id fails', async () => {
    expect(await failed({ allowDuplicate: true })).toContain(ADMIN_CHECKS.duplicate);
  });

  it('a sink without administration is skipped, not failed', async () => {
    const plain: typeof fetch = async (input, init) => {
      const res = await adminFake()(input, init);
      if (!String(input).endsWith('/describe')) return res;
      const d = (await res.json()) as { capabilities: Record<string, unknown> };
      delete d.capabilities.administration;
      return new Response(JSON.stringify(d), { status: 200 });
    };
    const results = await administrationSuite({
      url: 'http://sink.test',
      key: FAKE_KEY,
      instanceFields: {},
      fetchImpl: plain,
    });
    expect(results.every((r) => r.ok && r.detail?.startsWith('skipped'))).toBe(true);
  });
});
