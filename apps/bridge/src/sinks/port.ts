import type {
  BridgeError,
  BrowseRequest,
  BrowseResult,
  ConnectionTestRequest,
  ConnectionTestResult,
  SinkDeliverRequest,
  SinkDeliverResult,
  SinkDescribe,
  SinkJobStatus,
} from '@ih/bridge-contract';

/** A sink as the bridge drives it: built in, or an external one behind an HTTP adapter. */
export interface SinkPort {
  describe(): Promise<SinkDescribe>;
  testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult>;
  browse(req: BrowseRequest): Promise<BrowseResult>;
  deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult>;
  deliveryStatus(sinkJobId: string): Promise<SinkJobStatus>;
}

/**
 * A sink's refusal in contract terms. Anything else a sink throws is treated as a retryable
 * `internal` error.
 */
export class SinkError extends Error {
  constructor(readonly error: BridgeError) {
    super(error.message);
    this.name = 'SinkError';
  }
}

export interface SinkRegistry {
  get(id: string): SinkPort | null;
  ids(): string[];
}

export class MapSinkRegistry implements SinkRegistry {
  constructor(private readonly sinks: Record<string, SinkPort>) {}

  get(id: string): SinkPort | null {
    return Object.hasOwn(this.sinks, id) ? (this.sinks[id] ?? null) : null;
  }

  ids(): string[] {
    return Object.keys(this.sinks);
  }
}
