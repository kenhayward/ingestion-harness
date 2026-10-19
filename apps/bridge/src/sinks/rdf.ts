import {
  bridgeError,
  type BrowseResult,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type SinkDeliverRequest,
  type SinkDeliverResult,
  type SinkDescribe,
  type SinkJobStatus,
  type TargetTestResult,
} from '@ih/bridge-contract';
import type { GraphStorePort } from '../rdf/store.js';
import { SinkError, type SinkPort, type TargetObjects, type TargetPlace } from './port.js';

export const RDF_SINK_ID = 'rdf';

/** The dataset a connection is tested against when no target names one (Fuseki's `ct`). */
const DEFAULT_DATASET = 'ct';

/** Where a triple store is reached: its URL and the writer's credentials. */
export interface RdfCredential {
  endpoint: string;
  user: string | null;
  password: string | null;
}

const DESCRIBE: SinkDescribe = {
  name: 'Triple store',
  contractVersion: 1,
  connectionKind: 'shared',
  // A shared connection carries its own endpoint, so there are no named instances.
  instances: [],
  credentialFields: [
    { id: 'endpoint', label: 'Endpoint', secret: false },
    { id: 'user', label: 'User', secret: false },
    { id: 'password', label: 'Password', secret: true },
  ],
  destinationFields: [
    {
      id: 'dataset',
      label: 'Dataset',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: false,
    },
  ],
  // A package goes to every target of a publication; this sink uses its graph (`rdf`) and needs
  // nothing else, and replacing a graph is a PUT.
  capabilities: {
    browse: false,
    replace: true,
    withdraw: true,
    readBack: false,
    accepts: ['files', 'data', 'rdf'],
  },
};

/**
 * The built-in `rdf` sink: loads a package's graph into a triple store's named graph (SPARQL Graph
 * Store Protocol PUT, replacing it), never over a newer version of that graph, so retries that
 * arrive out of order leave the newest one in place. Its object operations drop or write a named
 * graph of the target's dataset (withdraw, remint).
 */
export class RdfSink implements SinkPort, TargetObjects {
  constructor(
    private readonly opts: {
      store: (credential: RdfCredential, dataset: string) => GraphStorePort;
    },
  ) {}

  async describe(): Promise<SinkDescribe> {
    return structuredClone(DESCRIBE);
  }

  async testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult> {
    const credential = this.credential(req.credential);
    await this.opts.store(credential, DEFAULT_DATASET).ping();
    return {
      ok: true,
      identity: `${credential.user ?? 'anonymous'} at ${credential.endpoint}`,
    };
  }

  async browse(): Promise<BrowseResult> {
    return { nodes: [], nextCursor: null };
  }

  async deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult> {
    const rdf = req.package.rdf;
    if (!rdf) {
      throw new SinkError(
        bridgeError('content_rejected', 'a triple store takes a package with a graph'),
      );
    }
    const store = this.storeFor({ credential: req.credential, destination: req.destination });
    const stored = await store.version(rdf.graphName);
    if (stored !== null && stored >= rdf.version) {
      return this.receipt(rdf.graphName, `superseded by v${stored}`);
    }
    await store.put(rdf.graphName, rdf.turtle, 'text/turtle');
    return this.receipt(rdf.graphName, `v${rdf.version}`);
  }

  async deliveryStatus(sinkJobId: string): Promise<SinkJobStatus> {
    // Every graph load completes at once; there is never a job to poll.
    throw new SinkError(bridgeError('not_found', `no triple store job ${sinkJobId}`));
  }

  async probeTarget(place: TargetPlace): Promise<TargetTestResult> {
    const dataset = this.dataset(place);
    try {
      await this.storeFor(place).ping();
    } catch (err) {
      if (err instanceof SinkError) return { ok: false, step: 'connect', message: err.message };
      throw err;
    }
    return { ok: true, step: null, message: `Connected to dataset ${dataset}` };
  }

  async readObject(_place: TargetPlace, _bucket: string, _key: string): Promise<Buffer | null> {
    throw new SinkError(
      bridgeError('unsupported_part', 'a triple store does not read graphs back'),
    );
  }

  async putObject(
    place: TargetPlace,
    bucket: string,
    key: string,
    body: Buffer,
    _contentType: string,
  ): Promise<void> {
    this.inside(place, bucket, key);
    await this.storeFor(place).put(key, body.toString('utf8'), 'text/turtle');
  }

  async deleteObject(place: TargetPlace, bucket: string, key: string): Promise<void> {
    this.inside(place, bucket, key);
    await this.storeFor(place).delete(key);
  }

  private receipt(graphName: string, label: string): SinkDeliverResult {
    return {
      status: 'succeeded',
      receipt: { written: [{ kind: 'graph', id: graphName, label, url: null }] },
    };
  }

  private dataset(place: TargetPlace): string {
    const dataset = place.destination.dataset;
    if (!dataset) throw new SinkError(bridgeError('content_rejected', 'the target has no dataset'));
    return dataset;
  }

  /** A graph operation stays in the target's dataset and names an absolute graph IRI. */
  private inside(place: TargetPlace, bucket: string, key: string): void {
    if (bucket !== this.dataset(place) || !/^https?:\/\/\S+$/.test(key)) {
      throw new SinkError(
        bridgeError('content_rejected', 'the graph is outside the target', { bucket, key }),
      );
    }
  }

  private credential(credential: Record<string, string> | null): RdfCredential {
    if (credential === null) {
      throw new SinkError(bridgeError('credential_missing', 'the target has no connection'));
    }
    if (!credential.endpoint) {
      throw new SinkError(bridgeError('credential_missing', 'the connection has no endpoint'));
    }
    return {
      endpoint: credential.endpoint,
      user: credential.user || null,
      password: credential.password || null,
    };
  }

  private storeFor(place: TargetPlace): GraphStorePort {
    return this.opts.store(this.credential(place.credential), this.dataset(place));
  }
}
