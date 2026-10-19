import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { BridgeErrorSchema } from '../errors.js';
import { PackageSchema } from '../package.js';
import { signRequest } from '../signing.js';
import {
  BrowseResultSchema,
  ConnectionTestResultSchema,
  SinkDeliverResultSchema,
  SinkDescribeSchema,
  SinkJobStatusSchema,
  type SinkDescribe,
} from '../sink-api.js';

export interface ConformanceOptions {
  /** The sink's base URL, e.g. http://sink:8080 */
  url: string;
  /** The signing key the bridge would use for this sink. */
  key: string;
  instanceId: string;
  credential: Record<string, string> | null;
  destination: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** How long a pending delivery may take before the check fails (default 60 s). */
  pollTimeoutMs?: number;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** A shared package fixture: from src/conformance or dist/conformance alike. */
function fixturePackage(name = 'package-document.json') {
  const file = new URL(`../../test/fixtures/${name}`, import.meta.url);
  return PackageSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const describeIssues = (r: z.ZodSafeParseResult<unknown>) =>
  r.success ? undefined : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

/**
 * Drives a sink through contract v1 and reports each check. Plain async code (no test runner), so
 * the CLI and any CI can run it against a live sink.
 */
export async function conformanceSuite(opts: ConformanceOptions): Promise<CheckResult[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, '');
  const results: CheckResult[] = [];
  const badErrors: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    results.push({ name, ok, ...(detail ? { detail } : {}) });

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, signed = true) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = signed
      ? signRequest(opts.key, { method, path, body: payload })
      : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: payload }),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (res.status >= 400 && res.status !== 401 && !BridgeErrorSchema.safeParse(json).success) {
      badErrors.push(`${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, json };
  }

  // 1. describe
  let described: SinkDescribe | null = null;
  try {
    const res = await call('GET', '/describe');
    const parsed = SinkDescribeSchema.safeParse(res.json);
    described = parsed.success ? parsed.data : null;
    check('describe', res.status === 200 && parsed.success, describeIssues(parsed));
  } catch (err) {
    check('describe', false, String(err));
  }

  // 2. unsigned requests are refused
  try {
    const res = await call('GET', '/describe', undefined, false);
    check('unsigned refused', res.status === 401, `status ${res.status}`);
  } catch (err) {
    check('unsigned refused', false, String(err));
  }

  // 2b. a replayed signature (same nonce) is refused
  try {
    const headers = signRequest(opts.key, { method: 'GET', path: '/describe', body: '' });
    const first = await fetchImpl(`${base}/describe`, { headers });
    const again = await fetchImpl(`${base}/describe`, { headers });
    await Promise.all([first.text(), again.text()]);
    check('replay refused', first.status === 200 && again.status === 401, `status ${again.status}`);
  } catch (err) {
    check('replay refused', false, String(err));
  }

  // 2c. a body changed after signing is refused
  try {
    const signedBody = JSON.stringify({ instanceId: opts.instanceId, credential: {} });
    const sentBody = JSON.stringify({ instanceId: `${opts.instanceId}-changed`, credential: {} });
    const headers = {
      ...signRequest(opts.key, { method: 'POST', path: '/connections:test', body: signedBody }),
      'content-type': 'application/json',
    };
    const res = await fetchImpl(`${base}/connections:test`, {
      method: 'POST',
      headers,
      body: sentBody,
    });
    await res.text();
    check('tampered body refused', res.status === 401, `status ${res.status}`);
  } catch (err) {
    check('tampered body refused', false, String(err));
  }

  // 3. connections:test answers a result or a contract error
  try {
    const res = await call('POST', '/connections:test', {
      instanceId: opts.instanceId,
      credential: opts.credential ?? {},
    });
    const ok =
      (res.status === 200 && ConnectionTestResultSchema.safeParse(res.json).success) ||
      (res.status >= 400 && res.status < 500 && BridgeErrorSchema.safeParse(res.json).success);
    check('connections:test', ok, `status ${res.status}`);
  } catch (err) {
    check('connections:test', false, String(err));
  }

  // 4. browse, when the sink offers it
  const browseField = described?.destinationFields.find((f) => f.browse);
  if (described?.capabilities.browse && browseField) {
    try {
      const res = await call('POST', '/browse', {
        instanceId: opts.instanceId,
        credential: opts.credential,
        field: browseField.id,
        parentId: null,
        cursor: null,
      });
      const parsed = BrowseResultSchema.safeParse(res.json);
      check('browse', res.status === 200 && parsed.success, describeIssues(parsed));
    } catch (err) {
      check('browse', false, String(err));
    }
  } else {
    check('browse', true, 'skipped: the sink does not browse');
  }

  // 5. deliver the fixture, waiting out a pending answer. A sink that takes graphs (`rdf`) gets
  // the document whose package carries one, as CT Studio sends it.
  const takesGraphs = described?.capabilities.accepts.includes('rdf') ?? false;
  const documentPackage = fixturePackage(
    takesGraphs ? 'package-document-rdf.json' : 'package-document.json',
  );
  const deliver = async (pkg = documentPackage): Promise<string | null> => {
    const res = await call('POST', '/deliveries', {
      instanceId: opts.instanceId,
      credential: opts.credential,
      destination: opts.destination,
      idempotencyKey: pkg.idempotencyKey,
      actingUser: null,
      package: pkg,
    });
    const parsed = SinkDeliverResultSchema.safeParse(res.json);
    if (res.status !== 200 || !parsed.success) return `status ${res.status}`;
    if (parsed.data.status === 'succeeded') return null;
    const deadline = Date.now() + (opts.pollTimeoutMs ?? 60_000);
    for (;;) {
      const poll = await call('GET', `/deliveries/${encodeURIComponent(parsed.data.sinkJobId)}`);
      const status = SinkJobStatusSchema.safeParse(poll.json);
      if (!status.success) return `poll status ${poll.status}`;
      if (status.data.status === 'succeeded') return null;
      if (status.data.status === 'failed') return `failed: ${status.data.error.code}`;
      if (Date.now() > deadline) return 'still pending after the timeout';
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  try {
    const problem = await deliver();
    check('deliver', problem === null, problem ?? undefined);
  } catch (err) {
    check('deliver', false, String(err));
  }

  // 5b. a graph package (an ontology, a rebuilt graph), when the sink takes graphs
  if (takesGraphs) {
    try {
      const problem = await deliver(fixturePackage('package-graph.json'));
      check('deliver a graph package', problem === null, problem ?? undefined);
    } catch (err) {
      check('deliver a graph package', false, String(err));
    }
  }

  // 6. the same key again, when the sink can replace
  if (described?.capabilities.replace) {
    try {
      const problem = await deliver();
      check('same key again', problem === null, problem ?? undefined);
    } catch (err) {
      check('same key again', false, String(err));
    }
  } else {
    check('same key again', true, 'skipped: the sink does not replace');
  }

  // 7. every error body seen is a contract error
  check('errors', badErrors.length === 0, badErrors.join(' | ') || undefined);
  return results;
}
