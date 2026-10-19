import { describe, expect, it } from 'vitest';
import { MemoryConnectionRepo, seedInternalConnection } from '../src/connections/repo.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { connectionsContract } from './connections-contract.js';

connectionsContract('memory', async () => {
  const targets = new MemoryTargetRepo();
  return { connections: new MemoryConnectionRepo(targets), targets };
});

describe('seedInternalConnection', () => {
  it('writes the built-in connection once, keeping what the runner recorded on it', async () => {
    const connections = new MemoryConnectionRepo(new MemoryTargetRepo());
    await seedInternalConnection(connections);
    expect(await connections.get('internal')).toMatchObject({
      kind: 'shared',
      sinkId: 's3',
      fields: {},
      secretSet: false,
      secretEnv: null,
    });
    await connections.mark('internal', 'ok', null, new Date('2026-10-20T00:00:00Z'));
    await seedInternalConnection(connections);
    expect(await connections.get('internal')).toMatchObject({ status: 'ok' });
  });
});
