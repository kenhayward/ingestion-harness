import { describe, expect, it } from 'vitest';
import type { SinkDescribe } from '@ih/bridge-contract';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { laneLimitsOf } from '../src/deliveries/runner.js';
import type { SinkRegistry } from '../src/sinks/port.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { LANE_TARGETS, lanesContract } from './lanes-contract.js';

lanesContract('memory', async () => {
  const targets = new MemoryTargetRepo();
  for (const t of LANE_TARGETS) {
    await targets.put({ ...t, label: t.id, connectionId: null, destination: {} });
  }
  return new MemoryDeliveryRepo(targets);
});

describe('laneLimitsOf', () => {
  const describeWith = (lanes?: number) =>
    ({ instances: [{ id: 'i1', label: 'I1', ...(lanes ? { lanes } : {}) }] }) as SinkDescribe;
  const registry = (described: Record<string, SinkDescribe | null>): SinkRegistry => ({
    get: () => null,
    ids: () => Object.keys(described),
    status: () => 'available',
    described: (id) => described[id] ?? null,
  });

  it('never limits the built-in sinks', () => {
    const lanes = laneLimitsOf(registry({ s3: describeWith(3), rdf: null }));
    expect(lanes('s3', null)).toBeNull();
    expect(lanes('rdf', 'x')).toBeNull();
  });

  it("reads an external sink's lanes per instance, 1 when it declares none", () => {
    const lanes = laneLimitsOf(registry({ a: describeWith(5), b: describeWith() }));
    expect(lanes('a', 'i1')).toBe(5);
    expect(lanes('a', 'other')).toBe(1);
    expect(lanes('b', 'i1')).toBe(1);
  });

  it('gives a sink not described yet one lane', () => {
    expect(laneLimitsOf(registry({ c: null }))('c', 'i1')).toBe(1);
  });
});
