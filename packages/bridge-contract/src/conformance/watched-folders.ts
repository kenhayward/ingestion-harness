import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { BridgeErrorSchema } from '../errors.js';
import { signRequest } from '../signing.js';
import { SinkDescribeSchema, watchedFoldersOf } from '../sink-api.js';
import {
  FOLDER_MISSING_REASON,
  SOURCE_PATHS,
  SourceListAnswerSchema,
  type SourceFolder,
} from '../sources.js';

export interface WatchedFoldersOptions {
  url: string;
  key: string;
  instanceId: string;
  credential: Record<string, string>;
  /** Where to watch: a value for each of the sink's `sourceFields`. */
  source: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** The names of the watched folder checks, in the order they run. */
export const WATCH_CHECKS = {
  listRoot: 'watch: list root',
  put: 'watch: put text',
  move: 'watch: move into processing',
  moveAgain: 'watch: move is idempotent',
  read: 'watch: read moved file',
  listAfter: 'watch: list after move',
  missingFolder: 'watch: missing folder',
} as const;

const issues = (r: z.ZodSafeParseResult<unknown>) =>
  r.success ? undefined : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

/**
 * Drives a sink's watched folder calls (contract version 4): puts a file named
 * `ct-conformance-<uuid>.txt` in the root, moves it to `processing` (twice: the repeat must also
 * succeed), reads it, then moves it on to `failed`. It never deletes anything. A sink that does not
 * declare watched folders has every check skipped.
 */
export async function watchedFoldersSuite(
  opts: WatchedFoldersOptions,
): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, '');
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    results.push({ name, ok, ...(detail ? { detail } : {}) });
  const name = `ct-conformance-${randomUUID()}.txt`;
  const content = `conformance ${name}`;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = signRequest(opts.key, { method, path, body: payload });
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: payload }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
  }
  const send = (path: string, body: Record<string, unknown>, source = opts.source) =>
    call('POST', path, {
      instanceId: opts.instanceId,
      credential: opts.credential,
      source,
      actingUser: null,
      ...body,
    });
  const errorOf = (res: { status: number; json: unknown }) => {
    const e = BridgeErrorSchema.safeParse(res.json);
    return e.success ? e.data : null;
  };
  const answered = (res: { status: number; json: unknown }) => {
    const e = errorOf(res);
    return `answered ${res.status}${e ? ` ${e.code}: ${e.message}` : ''}`;
  };
  const attempt = async (checkName: string, body: () => Promise<string | undefined>) => {
    try {
      const problem = await body();
      check(checkName, !problem, problem);
    } catch (err) {
      check(checkName, false, String(err));
    }
  };
  const list = async (folder: SourceFolder) => {
    const res = await send(SOURCE_PATHS.list, { folder });
    return { res, parsed: SourceListAnswerSchema.safeParse(res.json) };
  };
  const move = (from: SourceFolder, to: SourceFolder) =>
    send(SOURCE_PATHS.move, { from: { folder: from, name }, to: { folder: to, name } });

  let declared = false;
  try {
    const d = SinkDescribeSchema.safeParse((await call('GET', '/describe')).json);
    declared = d.success && watchedFoldersOf(d.data) !== null;
  } catch {
    declared = false;
  }
  if (!declared) {
    for (const n of Object.values(WATCH_CHECKS)) {
      check(n, true, 'skipped: the sink does not declare watched folders');
    }
    return results;
  }

  await attempt(WATCH_CHECKS.listRoot, async () => {
    const { res, parsed } = await list('');
    if (res.status !== 200 || !parsed.success) return issues(parsed) ?? answered(res);
    return undefined;
  });
  await attempt(WATCH_CHECKS.put, async () => {
    const res = await send(SOURCE_PATHS.put, { folder: '', name, content });
    if (res.status !== 204) return answered(res);
    const { parsed } = await list('');
    if (!parsed.success) return issues(parsed);
    return parsed.data.files.some((f) => f.name === name) ? undefined : 'the file is not listed';
  });
  await attempt(WATCH_CHECKS.move, async () => {
    const res = await move('', 'processing');
    return res.status === 204 ? undefined : answered(res);
  });
  await attempt(WATCH_CHECKS.moveAgain, async () => {
    const res = await move('', 'processing');
    return res.status === 204 ? undefined : answered(res);
  });
  await attempt(WATCH_CHECKS.read, async () => {
    const res = await send(SOURCE_PATHS.read, { folder: 'processing', name });
    if (res.status !== 200) return answered(res);
    if (!res.type.startsWith('application/octet-stream')) return `content type ${res.type}`;
    return res.text === content ? undefined : 'not the content that was put';
  });
  await attempt(WATCH_CHECKS.listAfter, async () => {
    const root = await list('');
    const processing = await list('processing');
    if (!root.parsed.success) return issues(root.parsed) ?? answered(root.res);
    if (!processing.parsed.success) return issues(processing.parsed) ?? answered(processing.res);
    if (root.parsed.data.files.some((f) => f.name === name)) return 'still in the root';
    if (!processing.parsed.data.files.some((f) => f.name === name)) return 'not in processing';
    const out = await move('processing', 'failed');
    if (out.status !== 204) return `moving it out: ${answered(out)}`;
    const failed = await list('failed');
    if (!failed.parsed.success) return issues(failed.parsed);
    return failed.parsed.data.files.some((f) => f.name === name)
      ? undefined
      : 'not in failed after moving it out';
  });
  await attempt(WATCH_CHECKS.missingFolder, async () => {
    const [field] = Object.keys(opts.source);
    const source = { ...opts.source };
    if (field) source[field] = `${opts.source[field]}/ct-missing-${randomUUID().slice(0, 8)}`;
    const res = await send(SOURCE_PATHS.list, { folder: '' }, source);
    const e = errorOf(res);
    const reason = (e?.details as { reason?: unknown } | undefined)?.reason;
    return res.status === 404 && e?.code === 'not_found' && reason === FOLDER_MISSING_REASON
      ? undefined
      : `${answered(res)}${reason ? ` (${String(reason)})` : ''}`;
  });
  return results;
}
