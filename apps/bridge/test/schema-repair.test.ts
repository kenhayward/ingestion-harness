import { describe, expect, it } from 'vitest';
import { withSchemaRepair } from '../src/db/repair.js';

const missingTable = () =>
  Object.assign(new Error('relation "bridge.deliveries" does not exist'), { code: '42P01' });

describe('withSchemaRepair', () => {
  it('migrates again when a restore swapped in a database without the bridge schema', async () => {
    let repaired = 0;
    let calls = 0;
    const tick = withSchemaRepair(
      async () => {
        calls += 1;
        if (calls === 1) throw missingTable();
        return true;
      },
      async () => {
        repaired += 1;
      },
    );
    expect(await tick()).toBe(false);
    expect(repaired).toBe(1);
    expect(await tick()).toBe(true);
    expect(repaired).toBe(1);
  });

  it('passes any other failure on', async () => {
    const tick = withSchemaRepair(
      async () => {
        throw new Error('connection refused');
      },
      async () => {
        throw new Error('must not repair');
      },
    );
    await expect(tick()).rejects.toThrow('connection refused');
  });
});
