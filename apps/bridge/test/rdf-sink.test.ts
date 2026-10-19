import { readFileSync } from 'node:fs';
import { conformanceSuite, PackageSchema, type BridgePackage } from '@ih/bridge-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { GRAPH_VERSION, MemoryGraphStore } from '../src/rdf/store.js';
import { SinkError } from '../src/sinks/port.js';
import { RdfSink } from '../src/sinks/rdf.js';
import { serveSink } from '../src/sinks/serve.js';
import { KEY } from './helpers.js';

const fixture = (name: string): BridgePackage =>
  PackageSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/bridge-contract/test/fixtures/${name}`, import.meta.url),
        'utf8',
      ),
    ),
  );

const CREDENTIAL = { endpoint: 'http://fuseki:3030', user: 'ct-writer', password: 'pw' };
const PLACE = { credential: CREDENTIAL, destination: { dataset: 'ct' } };
const G = 'https://data.example/ct/graph/source/abc/invoice';
const turtle = (v: number) => `<${G}> <${GRAPH_VERSION}> ${v} .\n`;

/** The document fixture carrying graph G at `version`. */
function documentAt(version: number): BridgePackage {
  const pkg = fixture('package-document-rdf.json');
  return { ...pkg, rdf: { graphName: G, version, turtle: turtle(version) } };
}

function setup() {
  const store = new MemoryGraphStore();
  const seen: { credential: unknown; dataset: string }[] = [];
  const sink = new RdfSink({
    store: (credential, dataset) => {
      seen.push({ credential, dataset });
      return store;
    },
  });
  const deliver = (pkg: BridgePackage) =>
    sink.deliver({
      instanceId: '',
      credential: CREDENTIAL,
      destination: { dataset: 'ct' },
      idempotencyKey: pkg.idempotencyKey,
      actingUser: null,
      package: pkg,
    });
  return { store, sink, seen, deliver };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof SinkError) return err.error.code;
    throw err;
  }
  return 'no error';
};

describe('the rdf sink', () => {
  it('delivers the rdf part with a PUT and a receipt', async () => {
    const { store, seen, deliver } = setup();
    const result = await deliver(documentAt(2));
    expect(store.graphs.get(G)).toBe(turtle(2));
    expect(seen[0]).toEqual({
      credential: { endpoint: 'http://fuseki:3030', user: 'ct-writer', password: 'pw' },
      dataset: 'ct',
    });
    expect(result).toEqual({
      status: 'succeeded',
      receipt: { written: [{ kind: 'graph', id: G, label: 'v2', url: null }] },
    });
  });

  it('an older version never replaces a newer one', async () => {
    const { store, deliver } = setup();
    await deliver(documentAt(2));
    const late = await deliver(documentAt(1));
    expect(store.graphs.get(G)).toBe(turtle(2));
    expect(late).toEqual({
      status: 'succeeded',
      receipt: { written: [{ kind: 'graph', id: G, label: 'superseded by v2', url: null }] },
    });
  });

  it('the same version again is superseded, not rewritten', async () => {
    const { store, deliver } = setup();
    await deliver(documentAt(3));
    await store.put(G, `${turtle(3)}# changed\n`, 'text/turtle');
    const again = await deliver(documentAt(3));
    expect(store.graphs.get(G)).toContain('# changed');
    expect(again).toMatchObject({ receipt: { written: [{ label: 'superseded by v3' }] } });
  });

  it('a graph package (ontology) is put whatever is stored', async () => {
    const { store, deliver } = setup();
    const pkg = fixture('package-graph.json');
    await store.put(pkg.rdf!.graphName, '<x> <y> <z> .', 'text/turtle');
    await deliver(pkg);
    expect(store.graphs.get(pkg.rdf!.graphName)).toBe(pkg.rdf!.turtle);
  });

  it('a package without rdf is content_rejected', async () => {
    const { deliver } = setup();
    expect(await codeOf(deliver(fixture('package-document.json')))).toBe('content_rejected');
  });

  it('a target without a connection is credential_missing', async () => {
    const { sink } = setup();
    const pkg = documentAt(1);
    expect(
      await codeOf(
        sink.deliver({
          instanceId: '',
          credential: null,
          destination: { dataset: 'ct' },
          idempotencyKey: pkg.idempotencyKey,
          actingUser: null,
          package: pkg,
        }),
      ),
    ).toBe('credential_missing');
  });

  it('objects:delete drops the graph, refusing another dataset or a relative key', async () => {
    const { store, sink } = setup();
    await store.put(G, turtle(1), 'text/turtle');
    await sink.deleteObject(PLACE, 'ct', G);
    expect(store.graphs.has(G)).toBe(false);
    await sink.deleteObject(PLACE, 'ct', G); // gone already: still fine
    expect(await codeOf(sink.deleteObject(PLACE, 'other', G))).toBe('content_rejected');
    expect(await codeOf(sink.deleteObject(PLACE, 'ct', 'graph/source/abc'))).toBe(
      'content_rejected',
    );
  });

  it('putObject writes a graph inside the dataset', async () => {
    const { store, sink } = setup();
    await sink.putObject(PLACE, 'ct', G, Buffer.from(turtle(4)), 'text/turtle');
    expect(store.graphs.get(G)).toBe(turtle(4));
  });

  it('readObject is unsupported', async () => {
    const { sink } = setup();
    expect(await codeOf(sink.readObject(PLACE, 'ct', G))).toBe('unsupported_part');
    expect((await sink.describe()).capabilities).toEqual({
      browse: false,
      replace: true,
      withdraw: true,
      readBack: false,
      accepts: ['files', 'data', 'rdf'],
    });
  });

  it('probeTarget reports the dataset, or the failing step', async () => {
    const { sink } = setup();
    expect(await sink.probeTarget(PLACE)).toEqual({
      ok: true,
      step: null,
      message: 'Connected to dataset ct',
    });
    const refused = new RdfSink({
      store: () => ({
        ...new MemoryGraphStore(),
        put: async () => {},
        delete: async () => false,
        version: async () => null,
        ping: async () => {
          throw new SinkError({
            class: 'needs_user',
            code: 'credential_rejected',
            message: 'refused',
          });
        },
      }),
    });
    expect(await refused.probeTarget(PLACE)).toEqual({
      ok: false,
      step: 'connect',
      message: 'refused',
    });
  });
});

describe('the rdf sink over HTTP', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close()));
  });

  it('passes the conformance suite', async () => {
    const { sink, store } = setup();
    const app = await serveSink(sink, KEY);
    open.push(app);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const results = await conformanceSuite({
      url,
      key: KEY,
      instanceId: '',
      credential: CREDENTIAL,
      destination: { dataset: 'ct' },
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toContain('deliver a graph package');
    expect(store.graphs.size).toBe(2);
  });
});
