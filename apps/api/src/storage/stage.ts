import type { AppDeps } from '../app.js';
import type { ObjectStore } from './object-store.js';

/** Draft outputs live in the outputs bucket (API store); published ones in the final target. */
export function storeFor(
  deps: Pick<AppDeps, 'store' | 'targetStore'>,
  stage: 'draft' | 'published',
): ObjectStore {
  return stage === 'published' ? deps.targetStore : deps.store;
}
