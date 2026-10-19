/**
 * Opt-in: a real Fuseki (deploy/docker-compose.dev.yml `fuseki`, or the compose `rdf` profile).
 * Graph Store PUT replacing a named graph, its ct:graphVersion read back, DELETE, and a refused
 * body. Skipped unless IH_TEST_FUSEKI_URL is set, e.g.
 *   IH_TEST_FUSEKI_URL=http://127.0.0.1:3030 IH_TEST_FUSEKI_USER=ct-writer \
 *   IH_TEST_FUSEKI_PASSWORD=dev-writer npx vitest run --config apps/bridge/vitest.integration.config.ts fuseki
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRAPH_VERSION, HttpGraphStore } from '../../src/rdf/store.js';
import { SinkError } from '../../src/sinks/port.js';

const url = process.env.IH_TEST_FUSEKI_URL;

describe.skipIf(!url)('HttpGraphStore against Fuseki', () => {
  // A skipped suite's body still runs while tests are collected: no store without a URL.
  const store = url
    ? new HttpGraphStore({
        endpoint: url,
        dataset: process.env.IH_TEST_FUSEKI_DATASET ?? 'ct',
        user: process.env.IH_TEST_FUSEKI_USER ?? null,
        password: process.env.IH_TEST_FUSEKI_PASSWORD ?? null,
      })
    : (null as unknown as HttpGraphStore);
  const graph = `https://test.example/graph/${randomUUID()}`;
  const turtle = (v: number) =>
    `<${graph}> <${GRAPH_VERSION}> ${v} .\n<${graph}#d> a <${graph}#T> .\n`;

  it('pings, puts, replaces, reads the version and drops a named graph', async () => {
    await store.ping();
    expect(await store.version(graph)).toBeNull();
    await store.put(graph, turtle(1), 'text/turtle');
    expect(await store.version(graph)).toBe(1);
    await store.put(graph, turtle(2), 'text/turtle');
    expect(await store.version(graph)).toBe(2);
    expect(await store.delete(graph)).toBe(true);
    expect(await store.version(graph)).toBeNull();
  });

  it('refuses a body that is not Turtle as content_rejected', async () => {
    await expect(store.put(graph, 'this is not turtle <', 'text/turtle')).rejects.toSatisfy(
      (err) => err instanceof SinkError && err.error.code === 'content_rejected',
    );
  });
});
