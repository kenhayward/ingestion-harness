import { describe, expect, it } from 'vitest';
import type { ConnectionRepo, NewConnection } from '../src/connections/repo.js';
import type { TargetRepo } from '../src/targets/repo.js';

export const connection = (id: string, over: Partial<NewConnection> = {}): NewConnection => ({
  id,
  kind: 'shared',
  owner: null,
  sinkId: 's3',
  instanceId: null,
  name: `Connection ${id}`,
  fields: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIA1' },
  secretEnv: null,
  status: 'untested',
  statusReason: null,
  ...over,
});

/** The behaviour every ConnectionRepo shares; `make` gives empty repos over the same store. */
export function connectionsContract(
  name: string,
  make: () => Promise<{ connections: ConnectionRepo; targets: TargetRepo }>,
): void {
  describe(`ConnectionRepo (${name})`, () => {
    it('put then get hides the secret (secretSet only)', async () => {
      const { connections } = await make();
      await connections.put({ ...connection('c1'), secretEnc: 'v1:abc' });
      const got = await connections.get('c1');
      expect(got).toMatchObject({ id: 'c1', secretSet: true, lastUsedAt: null });
      expect(JSON.stringify(got)).not.toContain('v1:abc');
      expect(await connections.secretOf('c1')).toEqual({ secretEnc: 'v1:abc', secretEnv: null });
      expect(await connections.get('missing')).toBeNull();
      expect(await connections.secretOf('missing')).toBeNull();
    });

    it('put without secretEnc keeps the stored secret', async () => {
      const { connections } = await make();
      await connections.put({ ...connection('c1'), secretEnc: 'v1:abc' });
      await connections.put(connection('c1', { name: 'Renamed' }));
      expect(await connections.get('c1')).toMatchObject({ name: 'Renamed', secretSet: true });
      expect((await connections.secretOf('c1'))?.secretEnc).toBe('v1:abc');
      await connections.put({ ...connection('c1'), secretEnc: null });
      expect(await connections.get('c1')).toMatchObject({ secretSet: false });
    });

    it('lists by kind and owner', async () => {
      const { connections } = await make();
      await connections.put(connection('b'));
      await connections.put(connection('a'));
      await connections.put(connection('p', { kind: 'personal', owner: 'u1' }));
      expect((await connections.list({ kind: 'shared' })).map((c) => c.id)).toEqual(['a', 'b']);
      expect((await connections.list({ owner: 'u1' })).map((c) => c.id)).toEqual(['p']);
      expect(await connections.list({})).toHaveLength(3);
    });

    it('remove refuses a connection a target names', async () => {
      const { connections, targets } = await make();
      await connections.put(connection('c1'));
      await connections.put(connection('c2'));
      await targets.put({
        id: 't1',
        label: 'T1',
        sinkId: 's3',
        instanceId: null,
        connectionId: 'c1',
        destination: { bucket: 'b', prefix: '' },
      });
      expect(await connections.remove('c1')).toBe('in_use');
      expect(await connections.get('c1')).not.toBeNull();
      expect(await connections.remove('c2')).toBe('deleted');
      expect(await connections.remove('c2')).toBe('missing');
    });

    it('a removed target no longer holds its connection', async () => {
      const { connections, targets } = await make();
      await connections.put(connection('c1'));
      await targets.put({
        id: 't1',
        label: 'T1',
        sinkId: 's3',
        instanceId: null,
        connectionId: 'c1',
        destination: { bucket: 'b', prefix: '' },
      });
      await targets.remove('t1');
      expect(await connections.remove('c1')).toBe('deleted');
    });

    it('personal needs an owner, shared refuses one', async () => {
      const { connections } = await make();
      await expect(connections.put(connection('p', { kind: 'personal' }))).rejects.toThrow();
      await expect(connections.put(connection('s', { owner: 'u1' }))).rejects.toThrow();
      expect(await connections.list({})).toEqual([]);
    });

    it('refuses an id outside [a-z0-9_-], 64 characters at most', async () => {
      const { connections } = await make();
      await expect(connections.put(connection('Bad Id'))).rejects.toThrow();
      await expect(connections.put(connection('x'.repeat(65)))).rejects.toThrow();
    });

    it('mark records status, reason and last used', async () => {
      const { connections } = await make();
      await connections.put(connection('c1'));
      const used = new Date('2026-10-20T10:00:00.000Z');
      await connections.mark('c1', 'needs_attention', 'access denied');
      expect(await connections.get('c1')).toMatchObject({
        status: 'needs_attention',
        statusReason: 'access denied',
        lastUsedAt: null,
      });
      await connections.mark('c1', 'ok', null, used);
      expect(await connections.get('c1')).toMatchObject({
        status: 'ok',
        statusReason: null,
        lastUsedAt: used,
      });
    });
  });
}
