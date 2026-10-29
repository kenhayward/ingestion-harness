import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_LANES, SinkDescribeSchema, SinkViewSchema, lanesOf } from '../src/index.js';

const base = JSON.parse(
  readFileSync(new URL('./fixtures/describe-v2.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const withInstances = (instances: unknown[]) => ({ ...base, instances });

describe('lanes on describe instances', () => {
  it('parses an instance with lanes', () => {
    const d = SinkDescribeSchema.parse(withInstances([{ id: 't1', label: 'T', lanes: 10 }]));
    expect(d.instances[0]?.lanes).toBe(10);
  });

  it.each([0, 65, 1.5])('refuses lanes %s', (lanes) => {
    expect(
      SinkDescribeSchema.safeParse(withInstances([{ id: 't1', label: 'T', lanes }])).success,
    ).toBe(false);
  });

  it('exports the cap', () => {
    expect(MAX_LANES).toBe(64);
  });

  it('lanesOf reads the instance, else 1', () => {
    const d = SinkDescribeSchema.parse(
      withInstances([
        { id: 't1', label: 'T', lanes: 10 },
        { id: 't2', label: 'U' },
      ]),
    );
    expect(lanesOf(d, 't1')).toBe(10);
    expect(lanesOf(d, 't2')).toBe(1);
    expect(lanesOf(d, 'other')).toBe(1);
  });

  it('the producer view keeps lanes', () => {
    const view = {
      id: 's',
      name: 'S',
      status: 'available',
      contractVersion: 2,
      capabilities: base.capabilities as object,
      connectionKind: 'personal',
      instances: [{ id: 't1', label: 'T', lanes: 10 }],
      destinationFields: base.destinationFields,
      credentialFields: base.credentialFields,
    };
    expect(SinkViewSchema.parse(view).instances[0]?.lanes).toBe(10);
  });
});
