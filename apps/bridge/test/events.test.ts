import { randomUUID } from 'node:crypto';
import { MemoryNonceStore, verifyRequest, type BridgeEvent } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import {
  dispatchOnce,
  EventRefused,
  HttpEventSender,
  MemoryEventSender,
  UNKNOWN_EVENT_GIVE_UP_HOURS,
} from '../src/events/dispatch.js';
import { KEY } from './helpers.js';

const T0 = new Date('2026-10-19T12:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

async function twoEvents() {
  const deliveries = new MemoryDeliveryRepo();
  const pkg = {
    id: randomUUID(),
    kind: 'document' as const,
    idempotencyKey: 'c'.repeat(64),
    manifest: {},
    stagedKey: 'k',
    expiresAt: null,
  };
  const d = () => ({ id: randomUUID(), targetId: 't1', actingUser: null, overrides: {} });
  await deliveries.create(pkg, [d()], T0);
  await deliveries.create({ ...pkg, id: randomUUID() }, [d()], at(1));
  return deliveries;
}

describe('dispatchOnce', () => {
  it('sends due events in order and marks them sent', async () => {
    const deliveries = await twoEvents();
    const sender = new MemoryEventSender();
    expect(await dispatchOnce({ deliveries, sender }, at(2))).toBe(2);
    expect(sender.sent.map((e) => e.status)).toEqual(['queued', 'queued']);
    expect(await dispatchOnce({ deliveries, sender }, at(3))).toBe(0);
  });

  it('keeps an event the endpoint refused, with backoff, and carries on with later ones', async () => {
    const deliveries = await twoEvents();
    const [first] = await deliveries.dueEvents(at(2), 10);
    const sender = new MemoryEventSender((e) => e.eventId === first!.id);
    expect(await dispatchOnce({ deliveries, sender }, at(2))).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(await deliveries.dueEvents(at(31), 10)).toEqual([]);
    const retried = await deliveries.dueEvents(at(32), 10);
    expect(retried.map((e) => [e.id, e.attempts])).toEqual([[first!.id, 1]]);
  });

  it('gives up an event the producer has not known for a day (409), and says so', async () => {
    const deliveries = await twoEvents();
    const [first] = await deliveries.dueEvents(at(2), 10);
    const sender = new MemoryEventSender((e) => (e.eventId === first!.id ? 409 : false));
    const dropped: string[] = [];
    const deps = {
      deliveries,
      sender,
      onDropped: (e: BridgeEvent) => void dropped.push(e.eventId),
    };
    expect(await dispatchOnce(deps, at(2))).toBe(1);
    expect(dropped).toEqual([]);
    const aDayOn = at(UNKNOWN_EVENT_GIVE_UP_HOURS * 3600);
    expect(await dispatchOnce(deps, aDayOn)).toBe(0);
    expect(dropped).toEqual([first!.id]);
    expect(await deliveries.dueEvents(at(30 * 86_400), 10)).toEqual([]);
  });

  it('keeps retrying an event any other refusal or outage holds back, however old', async () => {
    const deliveries = await twoEvents();
    const sender = new MemoryEventSender(() => 503);
    const dropped: BridgeEvent[] = [];
    const deps = { deliveries, sender, onDropped: (e: BridgeEvent) => void dropped.push(e) };
    expect(await dispatchOnce(deps, at(3 * 86_400))).toBe(0);
    expect(dropped).toEqual([]);
    expect(await deliveries.dueEvents(at(30 * 86_400), 10)).toHaveLength(2);
  });
});

describe('HttpEventSender', () => {
  it('signs what it sends, and throws on a non-2xx answer', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let status = 204;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status });
    }) as typeof fetch;
    const sender = new HttpEventSender('http://api:3000/api/bridge/events', KEY, fetchImpl);
    const event: BridgeEvent = {
      eventId: randomUUID(),
      deliveryId: randomUUID(),
      sequence: 1,
      status: 'queued',
      error: null,
      receipt: null,
      at: T0.toISOString(),
    };
    await sender.send(event);
    const { init } = seen[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(
      verifyRequest(
        KEY,
        { method: 'POST', path: '/api/bridge/events', body: init.body as string, headers },
        new MemoryNonceStore(),
      ),
    ).toEqual({ ok: true });
    status = 500;
    await expect(sender.send(event)).rejects.toThrow(/500/);
    status = 409;
    await expect(sender.send(event)).rejects.toBeInstanceOf(EventRefused);
    await expect(sender.send(event)).rejects.toMatchObject({ status: 409 });
  });
});
