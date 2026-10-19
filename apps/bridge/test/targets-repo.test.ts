import { MemoryTargetRepo } from '../src/targets/repo.js';
import { targetsContract } from './targets-contract.js';

targetsContract('memory', async () => new MemoryTargetRepo());
