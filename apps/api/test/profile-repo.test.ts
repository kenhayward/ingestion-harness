import { MemoryProfileRepo } from '../src/profile/repo.js';
import { profileContract } from './profile-contract.js';

profileContract(
  'memory',
  async (clock) => ({
    repo: new MemoryProfileRepo(clock?.now),
    ken: '00000000-0000-4000-8000-000000000001',
    ada: '00000000-0000-4000-8000-000000000002',
  }),
  { clock: true },
);
