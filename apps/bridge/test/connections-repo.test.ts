import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { connectionsContract } from './connections-contract.js';

connectionsContract('memory', async () => {
  const targets = new MemoryTargetRepo();
  return { connections: new MemoryConnectionRepo(targets), targets };
});
