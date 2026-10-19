import { HandoffUserSchema, signRequest, type HandoffUser } from '@ih/bridge-contract';

/** Signed calls from the bridge back to its producer (CT Studio's API). */
export interface ProducerClient {
  /** The user a one-time handoff code was minted for; null when it is unknown, used or expired. */
  redeem(code: string): Promise<HandoffUser | null>;
}

export class HttpProducerClient implements ProducerClient {
  constructor(
    /** CT Studio's API base, e.g. `http://api:3000/api`. */
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async redeem(code: string): Promise<HandoffUser | null> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/bridge/handoff/redeem`);
    const body = JSON.stringify({ code });
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...signRequest(this.key, { method: 'POST', path: `${url.pathname}${url.search}`, body }),
        'content-type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the producer answered ${res.status} to a handoff`);
    return HandoffUserSchema.parse(await res.json());
  }
}
