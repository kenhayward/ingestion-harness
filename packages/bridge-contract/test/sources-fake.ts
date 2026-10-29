import { readFileSync } from 'node:fs';
import {
  bridgeError,
  MemoryNonceStore,
  SOURCE_PATHS,
  SourceListRequestSchema,
  SourceMoveRequestSchema,
  SourcePutRequestSchema,
  SourceReadRequestSchema,
  verifyRequest,
  type BridgeError,
  type SourceFolder,
} from '../src/index.js';

export const SOURCES_KEY = 'sources-fake-key';
/** The watched location the fake serves; any other `folder` value is a missing folder. */
export const SOURCES_PLACE = { folder: 'inbox' };

/** Ways the fake can break the contract, so the suite's checks are seen to fail. */
export type SourceFault = 'move-not-idempotent' | 'missing-folder-wrong-code';

const status: Record<string, number> = {
  not_found: 404,
  content_rejected: 422,
  destination_exists: 409,
};

/** A minimal sink with watched folders, as a `fetch`: files in memory, per folder. */
export function sourcesFake(faults: SourceFault[] = []): typeof fetch {
  const nonces = new MemoryNonceStore();
  const describe = JSON.parse(
    readFileSync(new URL('./fixtures/describe-v4.json', import.meta.url), 'utf8'),
  ) as unknown;
  const folders: Record<SourceFolder, Map<string, string>> = {
    '': new Map(),
    processing: new Map(),
    delivered: new Map(),
    failed: new Map(),
  };
  const json = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  const fail = (e: BridgeError) => json(status[e.code] ?? 400, e);
  const rejected = (msg: string) => fail(bridgeError('content_rejected', msg));
  const noContent = () => new Response(null, { status: 204 });

  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const path = url.pathname + url.search;
    if (!verifyRequest(SOURCES_KEY, { method, path, body, headers }, nonces).ok) {
      return json(401, { error: 'unsigned' });
    }
    if (method === 'GET' && path === '/describe') return json(200, describe);
    const raw: unknown = body ? JSON.parse(body) : undefined;
    const known = (source: Record<string, string>) => source.folder === SOURCES_PLACE.folder;
    const missing = () =>
      faults.includes('missing-folder-wrong-code')
        ? fail(bridgeError('content_rejected', 'no such folder'))
        : fail(bridgeError('not_found', 'no such folder', { reason: 'folder_missing' }));

    if (path === SOURCE_PATHS.list) {
      const r = SourceListRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      if (!known(r.data.source)) return missing();
      const files = [...folders[r.data.folder]].map(([name, content]) => ({
        name,
        size: content.length,
        modifiedAt: new Date().toISOString(),
        etag: null,
      }));
      return json(200, { files });
    }
    if (path === SOURCE_PATHS.read) {
      const r = SourceReadRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      if (!known(r.data.source)) return missing();
      const content = folders[r.data.folder].get(r.data.name);
      if (content === undefined) return fail(bridgeError('not_found', 'no such file'));
      return new Response(content, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    if (path === SOURCE_PATHS.put) {
      const r = SourcePutRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      if (!known(r.data.source)) return missing();
      folders[r.data.folder].set(r.data.name, r.data.content);
      return noContent();
    }
    if (path === SOURCE_PATHS.move) {
      const r = SourceMoveRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      if (!known(r.data.source)) return missing();
      const { from, to } = r.data;
      const content = folders[from.folder].get(from.name);
      if (content === undefined) {
        if (folders[to.folder].has(to.name) && !faults.includes('move-not-idempotent')) {
          return noContent();
        }
        return fail(bridgeError('not_found', 'no such file'));
      }
      const there = folders[to.folder].get(to.name);
      if (there !== undefined && !(from.folder === to.folder && from.name === to.name)) {
        if (there.length !== content.length) {
          return fail(bridgeError('destination_exists', `${to.name} is already in ${to.folder}`));
        }
        folders[from.folder].delete(from.name);
        return noContent();
      }
      folders[from.folder].delete(from.name);
      folders[to.folder].set(to.name, content);
      return noContent();
    }
    return fail(bridgeError('not_found', `no route ${path}`));
  };
}
