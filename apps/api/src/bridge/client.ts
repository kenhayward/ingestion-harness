import {
  BridgeErrorSchema,
  ConnectionSummarySchema,
  DeliveryViewSchema,
  ObjectReadResultSchema,
  signRequest,
  TargetTestResultSchema,
  type BridgeError,
  type ConnectionSummary,
  type DeliveryView,
  type TargetTestResult,
} from '@ih/bridge-contract';
import { z } from 'zod';

/** A target as CT Studio mirrors it to the bridge: an S3 target, or the triple store. */
export interface TargetMirror {
  label: string;
  sinkId: 's3' | 'rdf';
  instanceId: null;
  /** Null: no connection yet; deliveries to the target then fail visibly. */
  connectionId: string | null;
  destination: Record<string, string>;
}

/** A shared connection written once, by the move of a target's keys to the bridge. */
export interface SharedConnection {
  id: string;
  name: string;
  /** The sink it is for; `s3` when left out. */
  sinkId?: string;
  fields: Record<string, string>;
  secret: string | null;
  secretEnv: string | null;
}

/** CT Studio's API's calls to the delivery bridge, every one signed with BRIDGE_CLIENT_KEY. */
export interface BridgeApi {
  putTarget(id: string, t: TargetMirror): Promise<void>;
  deleteTarget(id: string): Promise<'deleted' | 'in_use'>;
  putSharedConnection(c: SharedConnection): Promise<void>;
  listConnections(kind: 'shared'): Promise<ConnectionSummary[]>;
  testTarget(id: string): Promise<TargetTestResult>;
  testSettings(s: {
    connectionId: string;
    destination: Record<string, string>;
  }): Promise<TargetTestResult>;
  /** Null when there is no such object; throws (404 `target_missing`) when the bridge lacks the target. */
  readObject(targetId: string, bucket: string, key: string): Promise<Buffer | null>;
  getDelivery(id: string): Promise<DeliveryView | null>;
}

/** The bridge answered with an error (or could not be reached: `status` 0). */
export class BridgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: BridgeError | null,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeApiError';
  }

  /** A refusal a person must act on (a missing connection, a bad setting). */
  get needsUser(): boolean {
    return this.status >= 400 && this.status < 500 && this.error?.class === 'needs_user';
  }
}

export class HttpBridgeApi implements BridgeApi {
  constructor(
    /** e.g. http://bridge:3100 */
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}${path}`);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = signRequest(this.key, {
      method,
      path: `${url.pathname}${url.search}`,
      body: payload,
    });
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new BridgeApiError(
        0,
        null,
        `the bridge could not be reached: ${(err as Error).message}`,
      );
    }
  }

  /** The response when it is one of `ok`; a BridgeApiError otherwise. */
  private async expect(res: Response, ok: number[], what: string): Promise<Response> {
    if (ok.includes(res.status)) return res;
    const parsed = BridgeErrorSchema.safeParse(await res.json().catch(() => null));
    const error = parsed.success ? parsed.data : null;
    throw new BridgeApiError(
      res.status,
      error,
      `the bridge refused ${what} (${res.status})${error ? `: ${error.message}` : ''}`,
    );
  }

  async putTarget(id: string, t: TargetMirror): Promise<void> {
    await this.expect(
      await this.call('PUT', `/v1/targets/${encodeURIComponent(id)}`, t),
      [200],
      `target ${id}`,
    );
  }

  async deleteTarget(id: string): Promise<'deleted' | 'in_use'> {
    const res = await this.call('DELETE', `/v1/targets/${encodeURIComponent(id)}`);
    if (res.status === 409) return 'in_use';
    await this.expect(res, [204], `the removal of target ${id}`);
    return 'deleted';
  }

  async putSharedConnection(c: SharedConnection): Promise<void> {
    const { id, ...body } = c;
    await this.expect(
      await this.call('PUT', `/v1/connections/${encodeURIComponent(id)}`, {
        ...body,
        sinkId: body.sinkId ?? 's3',
      }),
      [204],
      `connection ${id}`,
    );
  }

  async listConnections(kind: 'shared'): Promise<ConnectionSummary[]> {
    const res = await this.expect(
      await this.call('GET', `/v1/connections?kind=${kind}`),
      [200],
      'the connection list',
    );
    return z.strictObject({ connections: z.array(ConnectionSummarySchema) }).parse(await res.json())
      .connections;
  }

  async testTarget(id: string): Promise<TargetTestResult> {
    const res = await this.expect(
      await this.call('POST', `/v1/targets/${encodeURIComponent(id)}:test`),
      [200],
      `the test of target ${id}`,
    );
    return TargetTestResultSchema.parse(await res.json());
  }

  async testSettings(s: {
    connectionId: string;
    destination: Record<string, string>;
  }): Promise<TargetTestResult> {
    const res = await this.expect(
      await this.call('POST', '/v1/targets:test', s),
      [200],
      'the test of target settings',
    );
    return TargetTestResultSchema.parse(await res.json());
  }

  async readObject(targetId: string, bucket: string, key: string): Promise<Buffer | null> {
    const res = await this.call(
      'POST',
      `/v1/targets/${encodeURIComponent(targetId)}/objects:read`,
      { bucket, key },
    );
    if (res.status === 404) {
      // A 404 is a missing object, unless it is the target the bridge lacks (not mirrored yet).
      const parsed = BridgeErrorSchema.safeParse(
        await res
          .clone()
          .json()
          .catch(() => null),
      );
      if (!(parsed.success && parsed.data.code === 'target_missing')) return null;
    }
    await this.expect(res, [200], `a read from target ${targetId}`);
    return Buffer.from(ObjectReadResultSchema.parse(await res.json()).content, 'base64');
  }

  async getDelivery(id: string): Promise<DeliveryView | null> {
    const res = await this.call('GET', `/v1/deliveries/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    await this.expect(res, [200], `delivery ${id}`);
    return DeliveryViewSchema.parse(await res.json());
  }
}
