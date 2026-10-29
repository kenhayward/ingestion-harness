import type {
  AdminCallName,
  BridgeError,
  BrowseRequest,
  BrowseResult,
  ConnectionTestRequest,
  ConnectionTestResult,
  SinkDeliverRequest,
  SinkDeliverResult,
  SinkDescribe,
  SinkJobStatus,
  TargetTestResult,
} from '@ih/bridge-contract';

/** A sink as the bridge drives it: built in, or an external one behind an HTTP adapter. */
export interface SinkPort {
  describe(): Promise<SinkDescribe>;
  testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult>;
  browse(req: BrowseRequest): Promise<BrowseResult>;
  deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult>;
  deliveryStatus(sinkJobId: string): Promise<SinkJobStatus>;
  /**
   * Contract version 3: one administration call (`ADMIN_ROUTES`), its answer checked against the
   * call's schema. Only external sinks have it; the bridge offers it only for a sink whose
   * describe declares administration.
   */
  admin?(call: AdminCallName, id: string | null, request: unknown): Promise<unknown>;
}

/** Where a target writes: its connection's credential and its destination. */
export interface TargetPlace {
  credential: Record<string, string> | null;
  destination: Record<string, string>;
}

/**
 * Synchronous object operations on a target, for sinks that store files (S3): reading published
 * files back, writing a graph's versioned copy, withdrawing. Each stays inside the target.
 */
export interface TargetObjects {
  readObject(place: TargetPlace, bucket: string, key: string): Promise<Buffer | null>;
  putObject(
    place: TargetPlace,
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
  deleteObject(place: TargetPlace, bucket: string, key: string): Promise<void>;
  /** Test connection for a target: which step failed, if any. */
  probeTarget(place: TargetPlace): Promise<TargetTestResult>;
}

export const hasObjects = (sink: SinkPort): sink is SinkPort & TargetObjects =>
  'readObject' in sink && 'probeTarget' in sink;

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
  /** Whether the sink answered its last describe (built-in sinks always do). */
  status(id: string): 'available' | 'unavailable';
  /** The sink's last describe, without a call; null when it has none at hand (never described). */
  described(id: string): SinkDescribe | null;
}

export class MapSinkRegistry implements SinkRegistry {
  constructor(private readonly sinks: Record<string, SinkPort>) {}

  get(id: string): SinkPort | null {
    return Object.hasOwn(this.sinks, id) ? (this.sinks[id] ?? null) : null;
  }

  ids(): string[] {
    return Object.keys(this.sinks);
  }

  status(): 'available' {
    return 'available';
  }

  /** A plain map caches nothing: its external sinks read as not described (one lane each). */
  described(): null {
    return null;
  }
}
