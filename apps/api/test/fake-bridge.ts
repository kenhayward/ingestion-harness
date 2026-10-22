import type {
  ConnectionSummary,
  DeliveryView,
  TargetPutRequest,
  TargetTestResult,
  TargetView,
} from '@ih/bridge-contract';
import type { BridgeApi, SentConnectionSummary, SharedConnection } from '../src/bridge/client.js';
import { BridgeApiError, ReadConnectionSummary } from '../src/bridge/client.js';

/** The destination fields each sink declares, as the bridge's sinks describe them. */
const DESTINATION_FIELDS: Record<string, string[]> = {
  s3: ['bucket', 'prefix', 'sse', 'kmsKeyId', 'storageClass', 'layout'],
  rdf: ['dataset'],
};

/** The credential fields each sink declares `secret: false` (what a summary may show). */
const PUBLIC_FIELDS: Record<string, string[]> = {
  s3: ['endpoint', 'region', 'accessKeyId', 'forcePathStyle'],
  rdf: ['endpoint', 'user'],
};

/**
 * The delivery bridge in memory, as CT Studio's API sees it: mirrored targets, connections,
 * the objects targets hold (`bucket/key`, per target), deliveries, and scripted failures.
 */
export class FakeBridgeApi implements BridgeApi {
  readonly targets = new Map<string, TargetPutRequest>();
  readonly connections = new Map<string, SharedConnection>();
  /**
   * Connection summaries listConnections answers (the internal one by default), followed by
   * those of the connections written here that are not listed in it.
   */
  summaries: SentConnectionSummary[] = [
    {
      id: 'internal',
      name: 'This deployment',
      sinkId: 's3',
      status: 'ok',
      statusReason: null,
      fields: {},
    },
  ];
  /** Objects by target id, then `bucket/key`. */
  readonly objects = new Map<string, Map<string, Buffer>>();
  readonly deliveries = new Map<string, DeliveryView>();
  /** Targets deliveries name: deleteTarget answers in_use. */
  readonly inUse = new Set<string>();
  /** Removed targets: their ids are not taken again (as on the bridge). */
  readonly removed = new Set<string>();
  /** What testTarget and testSettings answer. */
  testResult: TargetTestResult = {
    ok: true,
    step: null,
    message: 'Connected: wrote, read and deleted a test file',
  };
  readonly tests: unknown[] = [];
  connectionPuts = 0;
  targetPuts = 0;
  /** Thrown by the next call (then cleared). */
  failNext: Error | null = null;
  /** Thrown by every read (a bridge that is down for reads). */
  failReads: Error | null = null;
  /**
   * Where the bridge finds what `objects` does not hold: the deployment's own storage, which
   * internal targets (the seeded `default`) deliver to.
   */
  fallback: { get(bucket: string, key: string): Promise<Buffer | null> } | null = null;

  private fail(): void {
    const err = this.failNext;
    this.failNext = null;
    if (err) throw err;
  }

  /** A refusal as the HTTP client raises it. */
  static refusal(message: string, code = 'content_rejected'): BridgeApiError {
    return new BridgeApiError(422, { class: 'needs_user', code, message }, message);
  }

  put(targetId: string, bucket: string, key: string, body: Buffer | string): void {
    const objects = this.objects.get(targetId) ?? new Map<string, Buffer>();
    objects.set(`${bucket}/${key}`, Buffer.from(body));
    this.objects.set(targetId, objects);
  }

  async listTargets(): Promise<TargetView[]> {
    this.fail();
    return [...this.targets].map(([id, t]) => ({ id, ...structuredClone(t) }));
  }

  async putTarget(id: string, t: TargetPutRequest): Promise<TargetView> {
    this.fail();
    if (this.removed.has(id)) {
      const message = `target ${id} was removed, and its id is not used again: pick another`;
      throw new BridgeApiError(
        409,
        { class: 'needs_user', code: 'name_conflict', message },
        message,
      );
    }
    this.targetPuts += 1;
    const undeclared = Object.keys(t.destination).find(
      (k) => !(DESTINATION_FIELDS[t.sinkId] ?? []).includes(k),
    );
    if (undeclared) {
      throw FakeBridgeApi.refusal(`${undeclared} is not a destination field of ${t.sinkId}`);
    }
    this.targets.set(id, structuredClone(t));
    return { id, ...structuredClone(t) };
  }

  async deleteTarget(id: string): Promise<'deleted' | 'in_use'> {
    this.fail();
    if (this.inUse.has(id)) return 'in_use';
    if (this.targets.delete(id)) this.removed.add(id);
    return 'deleted';
  }

  async putSharedConnection(c: SharedConnection): Promise<void> {
    this.fail();
    this.connectionPuts += 1;
    this.connections.set(c.id, structuredClone(c));
  }

  /** The summaries given, then every connection put (as the bridge lists what it holds). */
  async listConnections(): Promise<ConnectionSummary[]> {
    this.fail();
    const written = [...this.connections.values()]
      .filter((c) => !this.summaries.some((s) => s.id === c.id))
      .map((c): ConnectionSummary => {
        const sinkId = c.sinkId ?? 's3';
        const shown = PUBLIC_FIELDS[sinkId] ?? [];
        return {
          id: c.id,
          name: c.name,
          sinkId,
          kind: 'shared',
          instanceId: null,
          status: 'untested',
          statusReason: null,
          lastUsedAt: null,
          fields: Object.fromEntries(Object.entries(c.fields).filter(([k]) => shown.includes(k))),
        };
      });
    return structuredClone([
      ...this.summaries.map((c) => ReadConnectionSummary.parse(c)),
      ...written,
    ]);
  }

  async testTarget(id: string): Promise<TargetTestResult> {
    this.fail();
    this.tests.push({ id });
    return this.testResult;
  }

  async testSettings(s: {
    connectionId: string;
    destination: Record<string, string>;
  }): Promise<TargetTestResult> {
    this.fail();
    this.tests.push(s);
    return this.testResult;
  }

  async readObject(targetId: string, bucket: string, key: string): Promise<Buffer | null> {
    this.fail();
    if (this.failReads) throw this.failReads;
    const target = this.targets.get(targetId);
    if (!target) {
      const message = `no target ${targetId}`;
      throw new BridgeApiError(
        404,
        { class: 'needs_user', code: 'target_missing', message },
        message,
      );
    }
    const prefix = target.destination.prefix ?? '';
    if (bucket !== target.destination.bucket || !key.startsWith(prefix)) {
      throw FakeBridgeApi.refusal('the object is outside the target');
    }
    const held = this.objects.get(targetId)?.get(`${bucket}/${key}`);
    if (held) return held;
    return this.fallback ? this.fallback.get(bucket, key) : null;
  }

  async getDelivery(id: string): Promise<DeliveryView | null> {
    this.fail();
    return this.deliveries.get(id) ?? null;
  }
}
