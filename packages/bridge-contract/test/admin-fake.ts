import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  AdminAddInstanceRequestSchema,
  AdminAuditRequestSchema,
  AdminIssueClientRequestSchema,
  AdminRenameInstanceRequestSchema,
  AdminRequestSchema,
  bridgeError,
  MemoryNonceStore,
  verifyRequest,
  type ActingAdmin,
  type AdminClient,
  type AdminInstance,
  type AuditEntry,
  type BridgeError,
} from '../src/index.js';

export const FAKE_KEY = 'admin-fake-key';

/** Ways the fake can break the contract, so the suite's checks are seen to fail. */
export interface Faults {
  leakToken?: boolean;
  renameLocked?: boolean;
  noAudit?: boolean;
  allowDuplicate?: boolean;
}

const status: Record<string, number> = {
  not_found: 404,
  locked: 409,
  name_conflict: 409,
  content_rejected: 422,
};

/** A minimal administered sink, as a `fetch`: the shape a real sink serves, in memory. */
export function adminFake(faults: Faults = {}): typeof fetch {
  const nonces = new MemoryNonceStore();
  const describe = JSON.parse(
    readFileSync(new URL('./fixtures/describe-v3.json', import.meta.url), 'utf8'),
  ) as unknown;
  const instances = new Map<string, AdminInstance>([
    [
      'sandbox',
      {
        id: 'sandbox',
        label: 'Sandbox',
        fields: {},
        locked: true,
        createdAt: null,
        createdBy: null,
      },
    ],
  ]);
  const clients = new Map<string, AdminClient & { token?: string }>([
    [
      'env-1',
      {
        id: 'env-1',
        name: 'Token 1 from the environment',
        prefix: null,
        instances: 'all',
        access: 'read_write',
        locked: true,
        createdAt: null,
        createdBy: null,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      },
    ],
  ]);
  const audit: AuditEntry[] = [];
  const now = () => new Date().toISOString();
  const log = (actor: ActingAdmin, action: AuditEntry['action'], subject: string) => {
    if (!faults.noAudit) audit.unshift({ at: now(), actor, action, subject, detail: null });
  };
  const json = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  const fail = (e: BridgeError) => json(status[e.code] ?? 400, e);
  const listed = (c: AdminClient & { token?: string }) => {
    if (faults.leakToken) return c;
    const rest: AdminClient & { token?: string } = { ...c };
    delete rest.token;
    return rest;
  };

  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const path = url.pathname + url.search;
    if (!verifyRequest(FAKE_KEY, { method, path, body, headers }, nonces).ok) {
      return json(401, { error: 'unsigned' });
    }
    if (method === 'GET' && path === '/describe') return json(200, describe);
    const raw: unknown = body ? JSON.parse(body) : undefined;
    const rejected = (msg: string) => fail(bridgeError('content_rejected', msg));
    const p = decodeURIComponent(url.pathname);

    if (p === '/admin/instances:list' || p === '/admin/clients:list') {
      if (!AdminRequestSchema.safeParse(raw).success) return rejected('bad body');
      return p.includes('instances')
        ? json(200, { instances: [...instances.values()] })
        : json(200, { clients: [...clients.values()].map(listed) });
    }
    if (p === '/admin/instances') {
      const r = AdminAddInstanceRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      if (instances.has(r.data.id) && !faults.allowDuplicate) {
        return fail(bridgeError('name_conflict', `${r.data.id} exists`));
      }
      const inst: AdminInstance = {
        id: r.data.id,
        label: r.data.label,
        fields: r.data.fields,
        locked: false,
        createdAt: now(),
        createdBy: r.data.actingAdmin,
      };
      instances.set(inst.id, inst);
      log(r.data.actingAdmin, 'instance_added', inst.id);
      return json(201, inst);
    }
    const inst = /^\/admin\/instances\/(.+):(rename|remove)$/.exec(p);
    if (inst) {
      const [, id, action] = inst;
      const found = instances.get(id!);
      if (!found) return fail(bridgeError('not_found', `no instance ${id}`));
      if (action === 'rename') {
        const r = AdminRenameInstanceRequestSchema.safeParse(raw);
        if (!r.success) return rejected('bad body');
        if (found.locked && !faults.renameLocked) return fail(bridgeError('locked', 'locked'));
        found.label = r.data.label;
        log(r.data.actingAdmin, 'instance_renamed', found.id);
        return json(200, found);
      }
      const r = AdminRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      if (found.locked) return fail(bridgeError('locked', 'locked'));
      instances.delete(found.id);
      log(r.data.actingAdmin, 'instance_removed', found.id);
      return json(200, { id: found.id, removed: true });
    }
    if (p === '/admin/clients') {
      const r = AdminIssueClientRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      const token = `snk_${randomBytes(24).toString('hex')}`;
      const id = `c_${randomBytes(4).toString('hex')}`;
      const days = r.data.expiresInDays;
      const client = {
        id,
        name: r.data.name,
        prefix: token.slice(0, 8),
        instances: r.data.instances,
        access: r.data.access,
        locked: false,
        createdAt: now(),
        createdBy: r.data.actingAdmin,
        expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
        revokedAt: null,
        lastUsedAt: null,
        token,
      };
      clients.set(id, client);
      log(r.data.actingAdmin, 'client_issued', id);
      return json(201, { client: listed({ ...client, token: undefined }), token });
    }
    const rev = /^\/admin\/clients\/(.+):revoke$/.exec(p);
    if (rev) {
      const r = AdminRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      const c = clients.get(rev[1]!);
      if (!c) return fail(bridgeError('not_found', 'no client'));
      if (c.locked) return fail(bridgeError('locked', 'locked'));
      if (!c.revokedAt) {
        c.revokedAt = now();
        log(r.data.actingAdmin, 'client_revoked', c.id);
      }
      return json(200, listed(c));
    }
    if (p === '/admin/audit:list') {
      const r = AdminAuditRequestSchema.safeParse(raw);
      if (!r.success) return rejected('bad body');
      return json(200, { entries: audit.slice(0, r.data.limit), nextCursor: null });
    }
    return fail(bridgeError('not_found', `no route ${p}`));
  };
}
