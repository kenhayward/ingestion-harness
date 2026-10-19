import type { ConnectionSummary, DeliveryView, TargetTestResult } from '@ih/bridge-contract';
import type { BridgeApi, SharedConnection, TargetMirror } from '../src/bridge/client.js';
import { BridgeApiError } from '../src/bridge/client.js';

/**
 * The delivery bridge in memory, as CT Studio's API sees it: mirrored targets, connections,
 * the objects targets hold (`bucket/key`, per target), deliveries, and scripted failures.
 */
export class FakeBridgeApi implements BridgeApi {
  readonly targets = new Map<string, TargetMirror>();
  readonly connections = new Map<string, SharedConnection>();
  /** Connection summaries listConnections answers (the internal one by default). */
  summaries: ConnectionSummary[] = [
    { id: 'internal', name: 'This deployment', sinkId: 's3', status: 'ok', statusReason: null },
  ];
  /** Objects by target id, then `bucket/key`. */
  readonly objects = new Map<string, Map<string, Buffer>>();
  readonly deliveries = new Map<string, DeliveryView>();
  /** Targets deliveries name: deleteTarget answers in_use. */
  readonly inUse = new Set<string>();
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

  async putTarget(id: string, t: TargetMirror): Promise<void> {
    this.fail();
    this.targetPuts += 1;
    this.targets.set(id, structuredClone(t));
  }

  async deleteTarget(id: string): Promise<'deleted' | 'in_use'> {
    this.fail();
    if (this.inUse.has(id)) return 'in_use';
    this.targets.delete(id);
    return 'deleted';
  }

  async putSharedConnection(c: SharedConnection): Promise<void> {
    this.fail();
    this.connectionPuts += 1;
    this.connections.set(c.id, structuredClone(c));
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    this.fail();
    return structuredClone(this.summaries);
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
    return this.objects.get(targetId)?.get(`${bucket}/${key}`) ?? null;
  }

  async getDelivery(id: string): Promise<DeliveryView | null> {
    this.fail();
    return this.deliveries.get(id) ?? null;
  }
}
