import type { FastifyInstance } from 'fastify';
import { buildBridge, type BridgeDeps } from '../src/app.js';

export const KEY = 'k'.repeat(32);

/** A bridge on in-memory fakes; `over` replaces any of them. */
export async function testBridge(over: Partial<BridgeDeps> = {}): Promise<FastifyInstance> {
  return buildBridge({
    config: { BRIDGE_CLIENT_KEY: KEY, BRIDGE_MAX_PACKAGE_MB: 50 },
    ready: async () => true,
    logger: false,
    ...over,
  });
}
