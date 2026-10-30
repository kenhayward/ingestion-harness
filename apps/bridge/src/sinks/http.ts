import {
  adminCallPath,
  adminRoute,
  bridgeError,
  BridgeErrorSchema,
  ERROR_CODES,
  BrowseResultSchema,
  ConnectionTestResultSchema,
  signRequest,
  SinkDeliverResultSchema,
  SinkDescribeSchema,
  SinkJobStatusSchema,
  SOURCE_PATHS,
  SourceListAnswerSchema,
  type AdminCallName,
  type BridgeError,
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
import { SinkError, sourceTooLarge, type SinkPort, type SourcePort } from './port.js';

/** The most an answer may be: sinks answer receipts and statuses, never content. */
const MAX_ANSWER_BYTES = 8 * 2 ** 20;
/** The most of a sink's own error kept: its message, and its details as JSON. */
const MAX_MESSAGE = 500;
const MAX_DETAILS = 4096;

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

/** TLS codes Node gives when the sink's certificate chains to an authority it does not trust. */
const UNTRUSTED_CERT = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);

/**
 * Why a call never reached the sink, as the network error's code (fetch wraps it in `cause`):
 * ` (ECONNREFUSED)`, or blank when there is none. Only a code is named, never a message.
 */
function unreachedBecause(err: unknown): string {
  for (let e = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
      return UNTRUSTED_CERT.has(code)
        ? ` (${code}: the bridge does not trust its certificate)`
        : ` (${code})`;
    }
  }
  return '';
}

/** How much of an answer is read, and the refusal past it. */
interface Limit {
  bytes: number;
  tooLarge: () => SinkError;
}

const ANSWER_LIMIT: Limit = {
  bytes: MAX_ANSWER_BYTES,
  tooLarge: () => refuse('internal', "the sink's answer is too large"),
};

/**
 * A sink's own error as the bridge keeps it (and CT Studio shows it): a known code takes its own
 * class, the message is cut to MAX_MESSAGE characters, and details over MAX_DETAILS are dropped.
 */
function bounded(e: BridgeError): BridgeError {
  const known = Object.hasOwn(ERROR_CODES, e.code)
    ? ERROR_CODES[e.code as keyof typeof ERROR_CODES]
    : e.class;
  const message =
    e.message.length > MAX_MESSAGE ? `${e.message.slice(0, MAX_MESSAGE - 1)}…` : e.message;
  const keep = e.details !== undefined && JSON.stringify(e.details).length <= MAX_DETAILS;
  return { class: known, code: e.code, message, ...(keep ? { details: e.details } : {}) };
}

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

  /**
   * Contract version 4: the watched folder calls. A list is checked like any answer; a read is
   * the file's bytes, counted as they stream and refused past `maxBytes`; a move or a put answers
   * no content.
   */
  readonly sources: SourcePort = {
    list: async (req) =>
      (await this.call('POST', SOURCE_PATHS.list, req, SourceListAnswerSchema, this.timeouts.short))
        .files,
    read: async (req, maxBytes) =>
      (
        await this.exchange('POST', SOURCE_PATHS.read, req, this.timeouts.long, {
          bytes: maxBytes,
          tooLarge: () => sourceTooLarge(maxBytes),
        })
      ).bytes,
    move: async (req) => {
      await this.exchange('POST', SOURCE_PATHS.move, req, this.timeouts.long);
    },
    put: async (req) => {
      await this.exchange('POST', SOURCE_PATHS.put, req, this.timeouts.short);
    },
  };

  admin(call: AdminCallName, id: string | null, request: unknown): Promise<unknown> {
    const route = adminRoute(call);
    return this.call(
      'POST',
      adminCallPath(call, id),
      request,
      route.response as z.ZodType<unknown>,
      this.timeouts.short,
    );
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    const { bytes } = await this.exchange(method, path, body, timeoutMs);
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw refuse('internal', "the sink's answer is not valid");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw refuse('internal', "the sink's answer is not valid");
    return parsed.data;
  }

  /**
   * One signed call: the answer's bytes when it succeeded (read up to `limit`), else the sink's
   * refusal as a SinkError. An error answer is always read up to MAX_ANSWER_BYTES.
   */
  private async exchange(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    limit: Limit = ANSWER_LIMIT,
  ): Promise<{ bytes: Buffer }> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = signRequest(this.opts.key, {
      method,
      path,
      body: payload,
    });
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    let bytes: Buffer;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The same timeout covers the body: a sink that stalls or drops mid-answer is caught here.
      bytes = await this.read(res, res.status >= 400 ? ANSWER_LIMIT : limit);
    } catch (err) {
      if (err instanceof SinkError) throw err;
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw refuse('timeout', `the sink ${this.opts.id} did not answer in time`);
      }
      throw refuse(
        'sink_unavailable',
        `the sink ${this.opts.id} could not be reached${unreachedBecause(err)}`,
      );
    }
    if (res.status === 401) {
      throw refuse('internal', "the sink refused the bridge's signature: check its key");
    }
    if (res.status >= 400) throw this.errorOf(res.status, bytes.toString('utf8'));
    return { bytes };
  }

  /** The answer's bytes, refused past `limit` (by its length, or as it streams). */
  private async read(res: Response, limit: Limit): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > limit.bytes) {
      await res.body?.cancel().catch(() => undefined);
      throw limit.tooLarge();
    }
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit.bytes) {
        await reader.cancel().catch(() => undefined);
        throw limit.tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
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
    if (parsed.success) return new SinkError(bounded(parsed.data));
    if (status >= 500) {
      return refuse('sink_unavailable', `the sink ${this.opts.id} failed (${status})`);
    }
    return refuse('internal', `the sink answered ${status}`);
  }
}
