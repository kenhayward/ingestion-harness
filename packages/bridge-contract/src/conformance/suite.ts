import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { BridgeErrorSchema, type BridgeError } from '../errors.js';
import { decompositionIdempotencyKey } from '../idempotency.js';
import { isDecompositionProvenance, PackageSchema, type BridgePackage } from '../package.js';
import { signRequest } from '../signing.js';
import {
  BrowseResultSchema,
  ConnectionTestResultSchema,
  SinkDeliverResultSchema,
  SinkDescribeSchema,
  SinkJobStatusSchema,
  type ConditionalUpdate,
  type Receipt,
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

/** A delivery's outcome: the receipt it wrote, or the problem (with the sink's error, if any). */
type Delivered =
  | { receipt: Receipt; problem: null; error: null }
  | { receipt: null; problem: string; error: BridgeError | null };

const refused = (problem: string, error: BridgeError | null = null): Delivered => ({
  receipt: null,
  problem,
  error,
});

/** The names of the checks for decomposed documents, in the order they run. */
const DOCUMENT_CHECKS = {
  create: 'document: create',
  readBack: 'document: read back',
  sameKey: 'document: same key again',
  wrongVersion: 'document: update with a wrong version is refused',
  update: 'document: update with matching versions',
  retried: 'document: update retried with the same key',
} as const;

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
    const personalWithoutFields =
      described?.connectionKind === 'personal' && described.credentialFields.length === 0;
    // Every version 1 package carries files and data, and every document package a document and
    // images: a sink takes the parts it may ignore.
    const accepts = described?.capabilities.accepts ?? [];
    const takesAll = (parts: ReadonlyArray<(typeof accepts)[number]>) =>
      parts.every((p) => accepts.includes(p));
    const takesTooLittle =
      !!described && !takesAll(['files', 'data']) && !takesAll(['document', 'images']);
    const problem = personalWithoutFields
      ? 'a personal sink declares the credential fields its users enter'
      : takesTooLittle
        ? accepts.includes('document')
          ? 'a sink takes files and data, or document and images (it may ignore them)'
          : 'a sink takes files and data (it may ignore them)'
        : null;
    check(
      'describe',
      res.status === 200 && parsed.success && !problem,
      problem ?? describeIssues(parsed),
    );
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
  // the document whose package carries one, as CT Studio sends it. A sink that takes documents
  // but not files gets no version 1 package: the document checks (8) cover its deliveries.
  const takes = (part: SinkDescribe['capabilities']['accepts'][number]) =>
    described?.capabilities.accepts.includes(part) ?? false;
  const takesGraphs = takes('rdf');
  const documentsOnly = takes('document') && !takes('files');
  const documentsOnlySkip =
    'skipped: the sink takes documents, not files (the document checks cover it)';
  const documentPackage = fixturePackage(
    takesGraphs ? 'package-document-rdf.json' : 'package-document.json',
  );
  const deliver = async (
    pkg: BridgePackage = documentPackage,
    update?: ConditionalUpdate,
  ): Promise<Delivered> => {
    const res = await call('POST', '/deliveries', {
      instanceId: opts.instanceId,
      credential: opts.credential,
      destination: opts.destination,
      idempotencyKey: pkg.idempotencyKey,
      actingUser: null,
      package: pkg,
      ...(update ? { update } : {}),
    });
    const parsed = SinkDeliverResultSchema.safeParse(res.json);
    if (res.status !== 200 || !parsed.success) {
      const error = BridgeErrorSchema.safeParse(res.json);
      return refused(`status ${res.status}`, error.success ? error.data : null);
    }
    if (parsed.data.status === 'succeeded') {
      return { receipt: parsed.data.receipt, problem: null, error: null };
    }
    const deadline = Date.now() + (opts.pollTimeoutMs ?? 60_000);
    for (;;) {
      const poll = await call('GET', `/deliveries/${encodeURIComponent(parsed.data.sinkJobId)}`);
      const status = SinkJobStatusSchema.safeParse(poll.json);
      if (!status.success) return refused(`poll status ${poll.status}`);
      if (status.data.status === 'succeeded') {
        return { receipt: status.data.receipt, problem: null, error: null };
      }
      if (status.data.status === 'failed') {
        return refused(`failed: ${status.data.error.code}`, status.data.error);
      }
      if (Date.now() > deadline) return refused('still pending after the timeout');
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  if (documentsOnly) {
    check('deliver', true, documentsOnlySkip);
  } else {
    try {
      const { problem } = await deliver();
      check('deliver', problem === null, problem ?? undefined);
    } catch (err) {
      check('deliver', false, String(err));
    }
  }

  // 5b. a graph package (an ontology, a rebuilt graph), when the sink takes graphs
  if (takesGraphs) {
    try {
      const { problem } = await deliver(fixturePackage('package-graph.json'));
      check('deliver a graph package', problem === null, problem ?? undefined);
    } catch (err) {
      check('deliver a graph package', false, String(err));
    }
  }

  // 6. the same key again, when the sink can replace
  if (documentsOnly) {
    check('same key again', true, documentsOnlySkip);
  } else if (described?.capabilities.replace) {
    try {
      const { problem } = await deliver();
      check('same key again', problem === null, problem ?? undefined);
    } catch (err) {
      check('same key again', false, String(err));
    }
  } else {
    check('same key again', true, 'skipped: the sink does not replace');
  }

  // 8. decomposed documents, when the sink takes them
  if (described?.capabilities.decomposedDocuments) {
    await documentChecks(deliver, check);
  } else {
    for (const name of Object.values(DOCUMENT_CHECKS)) {
      check(name, true, 'skipped: the sink does not take decomposed documents');
    }
  }

  // 9. every error body seen is a contract error
  check('errors', badErrors.length === 0, badErrors.join(' | ') || undefined);
  return results;
}

/**
 * The decomposed document checks: create, read back, the same key again, an update expecting one
 * wrong version (refused, and so changing nothing), the update expecting what the create wrote,
 * and that update retried. Each run has its own keys (a forced batch of its own), so the suite
 * runs again against a real sink.
 */
async function documentChecks(
  deliver: (pkg: BridgePackage, update?: ConditionalUpdate) => Promise<Delivered>,
  check: (name: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  const fixture = fixturePackage('package-decomposed.json');
  const provenance = fixture.provenance;
  if (!isDecompositionProvenance(provenance)) throw new Error('the fixture is not a decomposition');
  const run = `conformance-${randomUUID()}`;
  /** The fixture at a decomposer version, keyed for this run and the document it replaces. */
  const packageFor = (persistentId: string | null, decomposerVersion: number): BridgePackage => ({
    ...fixture,
    idempotencyKey: decompositionIdempotencyKey(
      provenance.sourceSha256,
      persistentId,
      decomposerVersion,
      run,
    ),
    provenance: { ...provenance, decomposerVersion },
  });
  const attempt = async (name: string, body: () => Promise<string | undefined>) => {
    try {
      const problem = await body();
      check(name, !problem, problem);
    } catch (err) {
      check(name, false, String(err));
    }
  };

  // Create.
  const created = packageFor(null, provenance.decomposerVersion);
  let doc: Receipt['document'] = undefined;
  await attempt(DOCUMENT_CHECKS.create, async () => {
    const d = await deliver(created);
    doc = d.receipt?.document;
    if (!d.receipt) return d.problem;
    if (!doc) return 'the receipt has no document';
    return doc.components.length ? undefined : 'the receipt lists no components';
  });
  const document = doc as Receipt['document'];
  if (!document?.components.length) {
    for (const name of Object.values(DOCUMENT_CHECKS).slice(1)) {
      check(name, false, 'no document was created');
    }
    return;
  }
  const pid = document.persistentId;
  const samePersistentId = (d: Delivered) => {
    if (!d.receipt) return d.problem;
    const got = d.receipt.document?.persistentId;
    return got === pid ? undefined : `persistent id ${got ?? 'missing'}, not ${pid}`;
  };

  // Read back.
  const { readBack } = document;
  check(
    DOCUMENT_CHECKS.readBack,
    readBack.ok,
    readBack.ok ? undefined : `at ${readBack.at}: ${readBack.detail}`,
  );

  // The same key again.
  await attempt(DOCUMENT_CHECKS.sameKey, async () => samePersistentId(await deliver(created)));

  // An update expecting one component at a version it never had: refused, naming that component.
  // Every other expected version matches, so only a sink that compares versions refuses it.
  const expected = document.components;
  await attempt(DOCUMENT_CHECKS.wrongVersion, async () => {
    const wrong = expected.find((c) => c.kind !== 'map') ?? expected[0]!;
    const d = await deliver(packageFor(pid, provenance.decomposerVersion + 2), {
      persistentId: pid,
      expected: expected.map((c) =>
        c === wrong ? { ...c, version: `${c.version}-not-in-target` } : c,
      ),
    });
    if (d.receipt) return 'the update was applied';
    const { error } = d;
    if (error?.code !== 'changed_in_target' || error.class !== 'needs_user') {
      const got = error ? `${error.class} ${error.code}` : d.problem;
      return `refused with ${got}, not needs_user changed_in_target`;
    }
    const changed = error.details?.changed;
    const named =
      Array.isArray(changed) && changed.some((c) => (c as { id?: unknown })?.id === wrong.id);
    return named ? undefined : `details.changed does not name ${wrong.id}`;
  });

  // An update from the next decomposer version, expecting what the create wrote; then the same
  // update retried, which the sink recognises by its key instead of refusing it as changed.
  const update: ConditionalUpdate = { persistentId: pid, expected };
  const updated = packageFor(pid, provenance.decomposerVersion + 1);
  for (const name of [DOCUMENT_CHECKS.update, DOCUMENT_CHECKS.retried]) {
    await attempt(name, async () => samePersistentId(await deliver(updated, update)));
  }
}
