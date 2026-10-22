import { describe, expect, it } from 'vitest';
import { reconcileUsersOnce } from '../src/bridge/users-reconcile.js';
import { FakeBridgeApi } from './fake-bridge.js';

const user = (id: string, disabledReason: 'admin' | 'failed-sign-ins' | null = null) => ({
  id,
  disabledReason,
});
const log = () => {
  const warned: unknown[] = [];
  return { warned, warn: (o: unknown) => void warned.push(o), info: () => undefined };
};

describe('reconcileUsersOnce', () => {
  it('sends every user but those an admin disabled', async () => {
    const bridge = new FakeBridgeApi();
    const users = [user('a'), user('b', 'admin'), user('c', 'failed-sign-ins')];
    await reconcileUsersOnce({ users: { listUsers: async () => users }, bridge, log: log() });
    expect(bridge.reconciles).toEqual([['a', 'c']]);
  });

  it('never sends an empty list', async () => {
    const bridge = new FakeBridgeApi();
    await reconcileUsersOnce({
      users: { listUsers: async () => [user('b', 'admin')] },
      bridge,
      log: log(),
    });
    expect(bridge.reconciles).toEqual([]);
  });

  it('logs a bridge failure and does not throw', async () => {
    const bridge = new FakeBridgeApi();
    bridge.failNext = new Error('connect ECONNREFUSED');
    const l = log();
    await reconcileUsersOnce({ users: { listUsers: async () => [user('a')] }, bridge, log: l });
    expect(l.warned).toHaveLength(1);
  });
});
