import { MemoryAccessRepo } from '../src/access/repo.js';
import { accessContract } from './access-contract.js';

accessContract('memory', async (clock) => new MemoryAccessRepo(clock?.now), { clock: true });
