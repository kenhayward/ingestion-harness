import { MemoryNonceStore, signRequest } from '@ih/bridge-contract';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildBridge, type BridgeDeps } from '../src/app.js';

export const KEY = 'k'.repeat(32);

/** `app.inject` with the request signed by `key`. */
export function signedInject(
  app: FastifyInstance,
  key: string,
  r: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; body?: unknown },
): Promise<LightMyRequestResponse> {
  const payload = r.body === undefined ? '' : JSON.stringify(r.body);
  const headers: Record<string, string> = signRequest(key, {
    method: r.method,
    path: r.url,
    body: payload,
  });
  if (r.body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method: r.method, url: r.url, headers, payload });
}

/** A bridge on in-memory fakes; `over` replaces any of them. */
export async function testBridge(over: Partial<BridgeDeps> = {}): Promise<FastifyInstance> {
  return buildBridge({
    config: { BRIDGE_CLIENT_KEY: KEY, BRIDGE_MAX_PACKAGE_MB: 50 },
    ready: async () => true,
    nonces: new MemoryNonceStore(),
    logger: false,
    ...over,
  });
}
