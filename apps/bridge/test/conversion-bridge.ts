/**
 * The bridge side of the conversion and watched folder end to ends
 * (apps/api/test/integration/conversion-e2e-pg.test.ts and watch-e2e-pg.test.ts, which load this
 * at run time): the bridge's routes over HTTP for the worker (deliveries and the watched folder
 * relay), its runner delivering through `HttpSink` to the fake document sink's own server
 * (`FAKE_SINK_MODE=documents`, with `/_edit`, `/_delete`, `/_drop` and `/_folder`), and its event
 * dispatcher posting signed events to CT Studio's events route. The bridge's stores are its
 * memory ones (their Pg twins have their own tests).
 */
import {
  isDecompositionProvenance,
  type SourceFile,
  type SourceFolder,
  MemoryNonceStore,
  textForm,
  type DecompositionProvenance,
  type SinkDeliverRequest,
  type SinkDeliverResult,
} from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { buildBridge } from '../src/app.js';
import { Credentials } from '../src/connections/credential.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { runOnce } from '../src/deliveries/runner.js';
import { dispatchOnce, HttpEventSender } from '../src/events/dispatch.js';
import { MemoryPackageStore } from '../src/packages/store.js';
import { FakeDocumentSink } from '../src/sinks/fake-documents.js';
import { buildDocumentServer } from '../src/sinks/fake-server.js';
import { HttpSink } from '../src/sinks/http.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { SECRETS, TEST_CONFIG } from './helpers.js';

/** The fake sink's own key (the bridge holds it; nothing else needs it). */
const SINK_KEY = 's'.repeat(32);

/** The fake document sink, keeping the provenance each document's last write carried. */
class RecordingDocumentSink extends FakeDocumentSink {
  readonly provenance = new Map<string, DecompositionProvenance>();
  private active = 0;
  /** The most deliveries in progress at once. */
  max = 0;

  override async deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult> {
    this.max = Math.max(this.max, ++this.active);
    let result: SinkDeliverResult;
    try {
      result = await super.deliver(req);
    } finally {
      this.active--;
    }
    const pid = result.status === 'succeeded' ? result.receipt.document?.persistentId : undefined;
    if (pid && isDecompositionProvenance(req.package.provenance)) {
      this.provenance.set(pid, req.package.provenance);
    }
    return result;
  }
}

export interface ConversionBridge {
  /** Where the worker reaches the bridge (`BRIDGE_URL`). */
  url: string;
  /** Someone edits one component in the target (`POST /_edit`); its new version, or null. */
  edit(persistentId: string, componentId: string): Promise<{ version: string } | null>;
  /** Someone deletes a document in the target (`POST /_delete`); whether it was there. */
  remove(persistentId: string): Promise<boolean>;
  /** A file arrives in the root of the fake sink's watched location `inbox` (`POST /_drop`). */
  drop(name: string, content: Buffer): Promise<void>;
  /** What one folder of the location `inbox` holds (`GET /_folder`). */
  folder(folder: SourceFolder): Promise<SourceFile[]>;
  /** The persistent ids of the documents the fake sink holds. */
  documents(): string[];
  /** The text the fake sink holds for a document (its comparison form), or null if none. */
  text(persistentId: string): string | null;
  /** The provenance of the last write of a document the fake sink holds, or null if none. */
  provenance(persistentId: string): DecompositionProvenance | null;
  /** The most deliveries the fake sink had in progress at once. */
  maxConcurrent(): number;
  /** Runs every due delivery and sends every due event, until nothing is left to do. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function startConversionBridge(opts: {
  /** BRIDGE_CLIENT_KEY: the worker's calls and the events to CT Studio are signed with it. */
  key: string;
  /** BRIDGE_EVENTS_URL: CT Studio's `/api/bridge/events`. */
  eventsUrl: string;
  target: { id: string; label: string; sinkId: string; destination: Record<string, string> };
}): Promise<ConversionBridge> {
  const open: FastifyInstance[] = [];
  const documents = new RecordingDocumentSink();
  const sinkServer = await buildDocumentServer(SINK_KEY, false, documents);
  open.push(sinkServer);
  const sinkUrl = await sinkServer.listen({ host: '127.0.0.1', port: 0 });

  const deliveries = new MemoryDeliveryRepo();
  const packages = new MemoryPackageStore();
  const targets = new MemoryTargetRepo();
  await targets.put({ ...opts.target, instanceId: null, connectionId: null });
  const connections = new MemoryConnectionRepo(targets);
  const sinks = new MapSinkRegistry({
    [opts.target.sinkId]: new HttpSink({ id: opts.target.sinkId, url: sinkUrl, key: SINK_KEY }),
  });
  const app = await buildBridge({
    config: { ...TEST_CONFIG, BRIDGE_CLIENT_KEY: opts.key },
    deliveries,
    packages,
    targets,
    connections,
    credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
    sinks,
    producer: { redeem: async () => null },
    ready: async () => true,
    nonces: new MemoryNonceStore(),
    logger: false,
  });
  open.push(app);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const sender = new HttpEventSender(opts.eventsUrl, opts.key);
  const runner = { deliveries, packages, targets, sinks, connections, maxAttempts: 8 };

  return {
    url,
    async edit(persistentId, componentId) {
      const res = await fetch(`${sinkUrl}/_edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persistentId, componentId }),
      });
      return res.ok ? ((await res.json()) as { version: string }) : null;
    },
    async remove(persistentId) {
      const res = await fetch(`${sinkUrl}/_delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persistentId }),
      });
      return res.status === 204;
    },
    async drop(name, content) {
      const res = await fetch(`${sinkUrl}/_drop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, content: content.toString('base64') }),
      });
      if (res.status !== 204) throw new Error(`drop ${name}: ${res.status} ${await res.text()}`);
    },
    async folder(folder) {
      const res = await fetch(`${sinkUrl}/_folder?f=${encodeURIComponent(folder)}`);
      if (!res.ok) throw new Error(`folder ${folder}: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { files: SourceFile[] }).files;
    },
    documents: () => [...documents.documents.keys()],
    text(persistentId) {
      const stored = documents.documents.get(persistentId);
      return stored ? textForm(stored.document).join('\n') : null;
    },
    provenance: (persistentId) =>
      documents.documents.has(persistentId)
        ? (documents.provenance.get(persistentId) ?? null)
        : null,
    maxConcurrent: () => documents.max,
    async settle() {
      for (;;) {
        let worked = false;
        while (
          (await runOnce({ ...runner, leaseSeconds: 300, pollSeconds: 30 }, new Date())) ===
          'worked'
        ) {
          worked = true;
        }
        if ((await dispatchOnce({ deliveries, sender }, new Date())) > 0) worked = true;
        if (!worked) return;
      }
    },
    async close() {
      await Promise.all(open.map((a) => a.close()));
    },
  };
}
