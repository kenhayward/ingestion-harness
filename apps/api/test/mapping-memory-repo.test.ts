import { MemoryMappingMemoryRepo } from '../src/mapping-memory/repo.js';
import { mappingMemoryContract } from './mapping-memory-contract.js';

mappingMemoryContract('memory', async () => new MemoryMappingMemoryRepo());
