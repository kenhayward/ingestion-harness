import { randomUUID } from 'node:crypto';
import { MemoryNonceStore, verifyRequest, type BridgeEvent } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { dispatchOnce, HttpEventSender, MemoryEventSender } from '../src/events/dispatch.js';
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
  });
});
