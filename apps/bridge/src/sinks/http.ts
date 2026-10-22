import {
  bridgeError,
  BridgeErrorSchema,
  BrowseResultSchema,
  ConnectionTestResultSchema,
  signRequest,
  SinkDeliverResultSchema,
  SinkDescribeSchema,
  SinkJobStatusSchema,
  type BrowseRequest,
  type BrowseResult,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type SinkDeliverRequest,
  type SinkDeliverResult,
  type SinkDescribe,
  type SinkJobStatus,
} from '@ih/bridge-contract';
import type { z } from 'zod';
import { SinkError, type SinkPort } from './port.js';

/** The most an answer may be: sinks answer receipts and statuses, never content. */
const MAX_ANSWER_BYTES = 8 * 2 ** 20;

export interface HttpSinkOptions {
  id: string;
  /** The sink's base URL, from BRIDGE_SINKS. */
  url: string;
  /** The key this bridge signs its calls to that sink with. */
  key: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds: describe, test and browse (`short`); deliver and status (`long`). */
  timeouts?: { short: number; long: number };
}

const refuse = (code: 'internal' | 'timeout' | 'sink_unavailable', message: string) =>
  new SinkError(bridgeError(code, message));

/**
 * An external sink, reached over the sink contract's HTTP routes (as `serveSink` serves them),
 * every call signed with its registered key. Whatever the sink answers is checked against the
 * contract before the bridge uses it, and every failure is a SinkError of the right class: a
 * sink's own `needs_user` refusal stands, an outage or a timeout is retryable, and anything the
 * bridge cannot trust is `internal`.
 */
export class HttpSink implements SinkPort {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeouts: { short: number; long: number };

  constructor(private readonly opts: HttpSinkOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeouts = opts.timeouts ?? { short: 15_000, long: 120_000 };
  }

  describe(): Promise<SinkDescribe> {
    return this.call('GET', '/describe', undefined, SinkDescribeSchema, this.timeouts.short);
  }

  testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult> {
    return this.call(
      'POST',
      '/connections:test',
      req,
      ConnectionTestResultSchema,
      this.timeouts.short,
    );
  }

  browse(req: BrowseRequest): Promise<BrowseResult> {
    return this.call('POST', '/browse', req, BrowseResultSchema, this.timeouts.short);
  }

  deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult> {
    return this.call('POST', '/deliveries', req, SinkDeliverResultSchema, this.timeouts.long);
  }

  deliveryStatus(sinkJobId: string): Promise<SinkJobStatus> {
    return this.call(
      'GET',
      `/deliveries/${encodeURIComponent(sinkJobId)}`,
      undefined,
      SinkJobStatusSchema,
      this.timeouts.long,
    );
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = signRequest(this.opts.key, {
      method,
      path,
      body: payload,
    });
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw refuse('timeout', `the sink ${this.opts.id} did not answer in time`);
      }
      throw refuse('sink_unavailable', `the sink ${this.opts.id} could not be reached`);
    }
    const text = await this.read(res);
    if (res.status === 401) {
      throw refuse('internal', "the sink refused the bridge's signature: check its key");
    }
    if (res.status >= 400) throw this.errorOf(res.status, text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw refuse('internal', "the sink's answer is not valid");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw refuse('internal', "the sink's answer is not valid");
    return parsed.data;
  }

  /** The answer's text, refused past MAX_ANSWER_BYTES (by its length, or as it streams). */
  private async read(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_ANSWER_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw refuse('internal', "the sink's answer is too large");
    }
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw refuse('internal', "the sink's answer is too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** A refusal as the sink sent it when it is a contract error; otherwise classed by status. */
  private errorOf(status: number, text: string): SinkError {
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: classed by its status below.
    }
    const parsed = BridgeErrorSchema.safeParse(json);
    if (parsed.success) return new SinkError(parsed.data);
    if (status >= 500) {
      return refuse('sink_unavailable', `the sink ${this.opts.id} failed (${status})`);
    }
    return refuse('internal', `the sink answered ${status}`);
  }
}
