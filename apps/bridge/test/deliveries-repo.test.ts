import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { deliveriesContract } from './deliveries-contract.js';

deliveriesContract('memory', async () => new MemoryDeliveryRepo());
