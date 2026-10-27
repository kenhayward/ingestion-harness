import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROUTES,
  AdminAddInstanceRequestSchema,
  AdminAuditPageSchema,
  AdminClientListSchema,
  AdminInstanceListSchema,
  AdminIssueClientRequestSchema,
  AdminIssuedClientSchema,
  adminPath,
  administrationOf,
  bridgeError,
  CLIENT_EXPIRY_DAYS,
  clientState,
  ContractVersion,
  packageVersionFor,
  SinkDescribeSchema,
  type AdminClient,
} from '../src/index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const admin = { id: 'u1', name: 'Ada Admin' };

describe('contract version 3: administration', () => {
  it('a version 3 describe declares administration and its instance fields', () => {
    const d = SinkDescribeSchema.parse(fixture('describe-v3.json'));
    expect(d.contractVersion).toBe(3);
    expect(administrationOf(d)).toEqual({
      instances: true,
      clients: true,
      instanceFields: expect.arrayContaining([
        expect.objectContaining({ id: 'address', required: true }),
      ]),
    });
  });

  it('a v1 or v2 describe offers no administration', () => {
    expect(administrationOf(SinkDescribeSchema.parse(fixture('describe.json')))).toBeNull();
    expect(administrationOf(SinkDescribeSchema.parse(fixture('describe-v2.json')))).toBeNull();
  });

  it('administration needs contract version 3 and at least one part', () => {
    const v3 = fixture('describe-v3.json') as { capabilities: { administration: unknown } };
    expect(SinkDescribeSchema.safeParse({ ...v3, contractVersion: 2 }).success).toBe(false);
    const none = {
      ...v3,
      capabilities: {
        ...v3.capabilities,
        administration: { instances: false, clients: false, instanceFields: [] },
      },
    };
    expect(SinkDescribeSchema.safeParse(none).success).toBe(false);
  });

  it('a version 3 sink still takes documents', () => {
    const v2 = fixture('describe-v2.json') as Record<string, unknown>;
    expect(SinkDescribeSchema.safeParse({ ...v2, contractVersion: 3 }).success).toBe(true);
  });

  it('packages never go above version 2', () => {
    expect(packageVersionFor(1)).toBe(1);
    expect(packageVersionFor(2)).toBe(2);
    expect(packageVersionFor(3)).toBe(2);
    expect(ContractVersion.safeParse(3).success).toBe(false);
  });

  it('every call carries the acting administrator', () => {
    expect(
      AdminAddInstanceRequestSchema.safeParse({ id: 'acme', label: 'Acme', fields: {} }).success,
    ).toBe(false);
    expect(
      AdminAddInstanceRequestSchema.safeParse({
        actingAdmin: admin,
        id: 'acme',
        label: 'Acme',
        fields: { address: 'https://example.test' },
      }).success,
    ).toBe(true);
  });

  it('instance ids are path safe', () => {
    for (const id of ['Acme', 'a/b', '', '-a', 'a'.repeat(65)]) {
      expect(
        AdminAddInstanceRequestSchema.safeParse({ actingAdmin: admin, id, label: 'x', fields: {} })
          .success,
      ).toBe(false);
    }
  });

  it.each(CLIENT_EXPIRY_DAYS)('a client may expire in %s days', (days) => {
    expect(
      AdminIssueClientRequestSchema.safeParse({
        actingAdmin: admin,
        name: 'Reporting app',
        instances: ['acme'],
        access: 'read',
        expiresInDays: days,
      }).success,
    ).toBe(true);
  });

  it('refuses other expiries, an empty tenant list and unknown access', () => {
    const base = {
      actingAdmin: admin,
      name: 'x',
      instances: 'all',
      access: 'read_write',
      expiresInDays: null,
    };
    expect(AdminIssueClientRequestSchema.safeParse(base).success).toBe(true);
    expect(AdminIssueClientRequestSchema.safeParse({ ...base, expiresInDays: 14 }).success).toBe(
      false,
    );
    expect(AdminIssueClientRequestSchema.safeParse({ ...base, instances: [] }).success).toBe(false);
    expect(AdminIssueClientRequestSchema.safeParse({ ...base, access: 'admin' }).success).toBe(
      false,
    );
  });

  it('the fixtures parse unchanged', () => {
    for (const [file, schema] of [
      ['admin-instances.json', AdminInstanceListSchema],
      ['admin-clients.json', AdminClientListSchema],
      ['admin-issued-client.json', AdminIssuedClientSchema],
      ['admin-audit.json', AdminAuditPageSchema],
    ] as const) {
      const json = fixture(file);
      expect(schema.parse(json)).toEqual(json);
    }
  });

  it('a listed client never carries a secret', () => {
    const listed = (fixture('admin-clients.json') as { clients: object[] }).clients[0]!;
    expect(AdminClientListSchema.safeParse({ clients: [{ ...listed, token: 's' }] }).success).toBe(
      false,
    );
  });

  it("a client's state follows revocation and expiry", () => {
    const c = (over: Partial<AdminClient>): AdminClient => ({
      ...(fixture('admin-clients.json') as { clients: AdminClient[] }).clients[1]!,
      ...over,
    });
    const now = new Date('2026-10-27T12:00:00Z');
    expect(clientState(c({ revokedAt: null, expiresAt: null }), now)).toBe('active');
    expect(clientState(c({ revokedAt: null, expiresAt: '2026-10-27T11:59:59Z' }), now)).toBe(
      'expired',
    );
    expect(
      clientState(c({ revokedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' }), now),
    ).toBe('revoked');
  });

  it('names its routes', () => {
    expect(adminPath.instances).toBe('/admin/instances');
    expect(adminPath.renameInstance('acme')).toBe('/admin/instances/acme:rename');
    expect(adminPath.revokeClient('c 1')).toBe('/admin/clients/c%201:revoke');
    expect(ADMIN_ROUTES.every((r) => r.method === 'POST')).toBe(true);
  });

  it('new error codes and their classes', () => {
    expect(bridgeError('locked', 'from the environment').class).toBe('needs_user');
    expect(bridgeError('forbidden', 'read-only').class).toBe('needs_user');
    expect(bridgeError('not_configured', 'no state').class).toBe('needs_user');
  });
});
