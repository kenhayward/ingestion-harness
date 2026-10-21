import { signRequest, type BridgeEvent } from '@ih/bridge-contract';
import { backoff } from '../deliveries/runner.js';
import type { DeliveryRepo } from '../deliveries/repo.js';

/**
 * How long an event the producer answers 409 (no such delivery there) is offered before it is
 * dropped. A producer answers 409 while it has not yet recorded a delivery the bridge already
 * accepted, which takes seconds; after a day it never will (the job was deleted during the
 * hand-off, or nothing was waiting for it). A delivery the producer does know is not left
 * stranded by a dropped event: the producer's reconcile reads it from the bridge.
 */
export const UNKNOWN_EVENT_GIVE_UP_HOURS = 24;

/** The producer answered, and did not take the event. */
export class EventRefused extends Error {
  constructor(readonly status: number) {
    super(`events endpoint answered ${status}`);
  }
}

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
    if (!res.ok) throw new EventRefused(res.status);
  }
}

/**
 * Keeps what it is sent; refuses the events `refuse` picks (`true`, or the status to answer).
 * For tests.
 */
export class MemoryEventSender implements EventSender {
  readonly sent: BridgeEvent[] = [];

  constructor(private readonly refuse: (e: BridgeEvent) => boolean | number = () => false) {}

  async send(event: BridgeEvent): Promise<void> {
    const refused = this.refuse(event);
    if (refused !== false) throw new EventRefused(refused === true ? 500 : refused);
    this.sent.push(event);
  }
}

/**
 * Sends due outbox events, oldest first. An event the endpoint does not take waits with backoff;
 * the others go on, so one bad event or a long outage never blocks deliveries or later events.
 * One the producer has answered 409 for past UNKNOWN_EVENT_GIVE_UP_HOURS is dropped (marked sent,
 * reported through `onDropped`); any other refusal or outage is retried however long it lasts.
 */
export async function dispatchOnce(
  deps: {
    deliveries: DeliveryRepo;
    sender: EventSender;
    onDropped?: (event: BridgeEvent) => void;
  },
  now: Date,
  limit = 50,
): Promise<number> {
  let sent = 0;
  for (const e of await deps.deliveries.dueEvents(now, limit)) {
    try {
      await deps.sender.send(e.body);
      await deps.deliveries.markSent(e.id, now);
      sent += 1;
    } catch (err) {
      const age = now.getTime() - Date.parse(e.body.at);
      if (
        err instanceof EventRefused &&
        err.status === 409 &&
        age >= UNKNOWN_EVENT_GIVE_UP_HOURS * 3_600_000
      ) {
        await deps.deliveries.markSent(e.id, now);
        deps.onDropped?.(e.body);
        continue;
      }
      await deps.deliveries.retryEvent(
        e.id,
        new Date(now.getTime() + backoff(e.attempts + 1) * 1000),
      );
    }
  }
  return sent;
}
