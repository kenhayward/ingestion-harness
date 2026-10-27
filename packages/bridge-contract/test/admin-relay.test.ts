import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  adminCallPath,
  adminErrorStatus,
  adminRoute,
  bridgeError,
  SinkAdminCallSchema,
} from '../src/index.js';

const admin = { id: 'u1', name: 'Ada Admin' };

describe('the bridge relaying an administration call (producer API)', () => {
  it('names each call, with an id only where its path takes one', () => {
    expect(adminCallPath('listInstances', null)).toBe('/admin/instances:list');
    expect(adminCallPath('renameInstance', 'north')).toBe('/admin/instances/north:rename');
    expect(adminCallPath('revokeClient', 'c_1')).toBe('/admin/clients/c_1:revoke');
    expect(() => adminCallPath('renameInstance', null)).toThrow(/needs an id/);
    expect(() => adminCallPath('listClients', 'x')).toThrow(/takes no id/);
  });

  it('finds every route by its name', () => {
    for (const r of ADMIN_ROUTES) expect(adminRoute(r.name)).toBe(r);
  });

  it('takes a call, its id and its request as the sink takes it', () => {
    const call = {
      call: 'renameInstance',
      id: 'north',
      request: { actingAdmin: admin, label: 'North' },
    };
    expect(SinkAdminCallSchema.parse(call)).toEqual(call);
    expect(SinkAdminCallSchema.safeParse({ ...call, call: 'dropTables' }).success).toBe(false);
    expect(SinkAdminCallSchema.safeParse({ ...call, id: '../x' }).success).toBe(false);
  });

  it("keeps a sink's administration refusals' statuses; others are 422 or 503", () => {
    expect(adminErrorStatus(bridgeError('not_found', 'x'))).toBe(404);
    expect(adminErrorStatus(bridgeError('locked', 'x'))).toBe(409);
    expect(adminErrorStatus(bridgeError('name_conflict', 'x'))).toBe(409);
    expect(adminErrorStatus(bridgeError('not_configured', 'x'))).toBe(409);
    expect(adminErrorStatus(bridgeError('content_rejected', 'x'))).toBe(422);
    expect(adminErrorStatus(bridgeError('credential_rejected', 'x'))).toBe(422);
    expect(adminErrorStatus(bridgeError('sink_unavailable', 'x'))).toBe(503);
  });
});
