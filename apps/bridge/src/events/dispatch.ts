import { signRequest, type BridgeEvent } from '@ih/bridge-contract';
import { backoff } from '../deliveries/runner.js';
import type { DeliveryRepo } from '../deliveries/repo.js';

/** Where delivery events go. Throws when the event was not taken. */
export interface EventSender {
  send(event: BridgeEvent): Promise<void>;
}

/** Posts each event to the producer, signed with the shared key. */
export class HttpEventSender implements EventSender {
  private readonly path: string;

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const u = new URL(url);
    this.path = `${u.pathname}${u.search}`;
  }

  async send(event: BridgeEvent): Promise<void> {
    const body = JSON.stringify(event);
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        ...signRequest(this.key, { method: 'POST', path: this.path, body }),
        'content-type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`events endpoint answered ${res.status}`);
  }
}

/** Keeps what it is sent; refuses the events `refuse` picks. For tests. */
export class MemoryEventSender implements EventSender {
  readonly sent: BridgeEvent[] = [];

  constructor(private readonly refuse: (e: BridgeEvent) => boolean = () => false) {}

  async send(event: BridgeEvent): Promise<void> {
    if (this.refuse(event)) throw new Error('refused');
    this.sent.push(event);
  }
}

/**
 * Sends due outbox events, oldest first. An event the endpoint does not take waits with backoff;
 * the others go on, so one bad event or a long outage never blocks deliveries or later events.
 */
export async function dispatchOnce(
  deps: { deliveries: DeliveryRepo; sender: EventSender },
  now: Date,
  limit = 50,
): Promise<number> {
  let sent = 0;
  for (const e of await deps.deliveries.dueEvents(now, limit)) {
    try {
      await deps.sender.send(e.body);
      await deps.deliveries.markSent(e.id, now);
      sent += 1;
    } catch {
      await deps.deliveries.retryEvent(
        e.id,
        new Date(now.getTime() + backoff(e.attempts + 1) * 1000),
      );
    }
  }
  return sent;
}
