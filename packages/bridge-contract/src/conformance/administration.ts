import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  AdminAuditPageSchema,
  AdminClientListSchema,
  AdminClientSchema,
  AdminInstanceListSchema,
  AdminInstanceSchema,
  AdminIssuedClientSchema,
  AdminRemovedSchema,
  adminPath,
  type ActingAdmin,
  type Administration,
} from '../administration.js';
import { BridgeErrorSchema } from '../errors.js';
import { signRequest } from '../signing.js';
import { administrationOf, SinkDescribeSchema } from '../sink-api.js';

export interface AdministrationOptions {
  url: string;
  key: string;
  /** The settings of the throwaway instance the checks add (and remove), e.g. its address. */
  instanceFields: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** The names of the administration checks, in the order they run. */
export const ADMIN_CHECKS = {
  unsigned: 'admin: unsigned refused',
  noActor: 'admin: a call without actingAdmin is refused',
  listInstances: 'admin: list instances',
  addInstance: 'admin: add an instance',
  duplicate: 'admin: adding a taken id is refused',
  renameInstance: 'admin: rename changes the label only',
  lockedInstance: 'admin: a locked instance is not renamed or removed',
  listClients: 'admin: list clients',
  issueClient: 'admin: issue a client',
  secretOnce: 'admin: the secret is never listed',
  revokeClient: 'admin: revoke a client',
  lockedClient: 'admin: a locked client is not revoked',
  removeInstance: 'admin: remove an instance',
  removeAgain: 'admin: removing it again is not_found',
  audit: 'admin: the audit log names the acting administrator',
  errors: 'admin: every error is a contract error',
} as const;

const issues = (r: z.ZodSafeParseResult<unknown>) =>
  r.success ? undefined : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

/**
 * Drives a sink's administration calls (contract version 3) and reports each check. Each run adds
 * its own instance and client (ids from a fresh uuid), and removes and revokes them again, so it
 * runs against a live sink. A sink that doesn't declare administration has every check skipped.
 */
export async function administrationSuite(
  opts: AdministrationOptions,
): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, '');
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const badErrors: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) =>
    results.push({ name, ok, ...(detail ? { detail } : {}) });
  const run = randomUUID().slice(0, 8);
  const actingAdmin: ActingAdmin = { id: `conformance-${run}`, name: 'Conformance suite' };

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, signed = true) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = signed
      ? signRequest(opts.key, { method, path, body: payload })
      : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: payload }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (res.status >= 400 && res.status !== 401 && !BridgeErrorSchema.safeParse(json).success) {
      badErrors.push(`${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, json, text };
  }
  const post = (path: string, body: Record<string, unknown> = {}) =>
    call('POST', path, { actingAdmin, ...body });
  const errorCode = (json: unknown) => {
    const e = BridgeErrorSchema.safeParse(json);
    return e.success ? e.data.code : null;
  };
  const attempt = async (name: string, body: () => Promise<string | undefined>) => {
    try {
      const problem = await body();
      check(name, !problem, problem);
    } catch (err) {
      check(name, false, String(err));
    }
  };
  const skipAll = (detail: string) => {
    for (const name of Object.values(ADMIN_CHECKS)) check(name, true, `skipped: ${detail}`);
    return results;
  };

  let admin: Administration | null = null;
  try {
    const d = SinkDescribeSchema.safeParse((await call('GET', '/describe')).json);
    admin = d.success ? administrationOf(d.data) : null;
  } catch {
    admin = null;
  }
  if (!admin) return skipAll('the sink does not declare administration');

  await attempt(ADMIN_CHECKS.unsigned, async () => {
    const res = await call('POST', adminPath.listInstances, { actingAdmin }, false);
    return res.status === 401 ? undefined : `status ${res.status}`;
  });
  await attempt(ADMIN_CHECKS.noActor, async () => {
    const res = await call('POST', adminPath.listInstances, {});
    return res.status >= 400 && res.status < 500 && errorCode(res.json)
      ? undefined
      : `status ${res.status}`;
  });

  const instanceId = `conformance-${run}`;
  let lockedInstance: string | null = null;
  if (admin.instances) {
    await attempt(ADMIN_CHECKS.listInstances, async () => {
      const res = await post(adminPath.listInstances);
      const parsed = AdminInstanceListSchema.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      lockedInstance = parsed.data.instances.find((i) => i.locked)?.id ?? null;
      return undefined;
    });
    await attempt(ADMIN_CHECKS.addInstance, async () => {
      const res = await post(adminPath.instances, {
        id: instanceId,
        label: 'Conformance',
        fields: opts.instanceFields,
      });
      const parsed = AdminInstanceSchema.safeParse(res.json);
      if (res.status !== 201 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      if (parsed.data.id !== instanceId || parsed.data.locked) return 'not the instance added';
      const list = AdminInstanceListSchema.parse((await post(adminPath.listInstances)).json);
      return list.instances.some((i) => i.id === instanceId) ? undefined : 'not listed';
    });
    await attempt(ADMIN_CHECKS.duplicate, async () => {
      const res = await post(adminPath.instances, {
        id: instanceId,
        label: 'Again',
        fields: opts.instanceFields,
      });
      const code = errorCode(res.json);
      return code === 'name_conflict' ? undefined : `answered ${res.status} ${code ?? ''}`;
    });
    await attempt(ADMIN_CHECKS.renameInstance, async () => {
      const res = await post(adminPath.renameInstance(instanceId), {
        label: 'Conformance renamed',
      });
      const parsed = AdminInstanceSchema.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      return parsed.data.id === instanceId && parsed.data.label === 'Conformance renamed'
        ? undefined
        : `got ${parsed.data.id} “${parsed.data.label}”`;
    });
    if (lockedInstance) {
      const id: string = lockedInstance;
      await attempt(ADMIN_CHECKS.lockedInstance, async () => {
        const renamed = await post(adminPath.renameInstance(id), { label: 'Not allowed' });
        const removed = await post(adminPath.removeInstance(id));
        const codes = [errorCode(renamed.json), errorCode(removed.json)];
        return codes.every((c) => c === 'locked') ? undefined : `answered ${codes.join(', ')}`;
      });
    } else {
      check(ADMIN_CHECKS.lockedInstance, true, 'skipped: no locked instance listed');
    }
  } else {
    for (const name of [
      ADMIN_CHECKS.listInstances,
      ADMIN_CHECKS.addInstance,
      ADMIN_CHECKS.duplicate,
      ADMIN_CHECKS.renameInstance,
      ADMIN_CHECKS.lockedInstance,
    ]) {
      check(name, true, 'skipped: the sink does not administer instances');
    }
  }

  let lockedClient: string | null = null;
  let issued: { id: string; token: string } | null = null;
  if (admin.clients) {
    await attempt(ADMIN_CHECKS.listClients, async () => {
      const res = await post(adminPath.listClients);
      const parsed = AdminClientListSchema.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      lockedClient = parsed.data.clients.find((c) => c.locked)?.id ?? null;
      return undefined;
    });
    await attempt(ADMIN_CHECKS.issueClient, async () => {
      const res = await post(adminPath.clients, {
        name: `Conformance ${run}`,
        instances: admin.instances ? [instanceId] : 'all',
        access: 'read',
        expiresInDays: 7,
      });
      const parsed = AdminIssuedClientSchema.safeParse(res.json);
      if (res.status !== 201 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      const { client, token } = parsed.data;
      issued = { id: client.id, token };
      if (client.access !== 'read' || client.locked) return 'not the client issued';
      return client.expiresAt ? undefined : 'no expiry for a 7-day client';
    });
    const got = issued as { id: string; token: string } | null;
    await attempt(ADMIN_CHECKS.secretOnce, async () => {
      if (!got) return 'no client was issued';
      const res = await post(adminPath.listClients);
      if (res.text.includes(got.token)) return 'the list shows the secret';
      const parsed = AdminClientListSchema.safeParse(res.json);
      if (!parsed.success) return issues(parsed);
      return parsed.data.clients.some((c) => c.id === got.id) ? undefined : 'not listed';
    });
    await attempt(ADMIN_CHECKS.revokeClient, async () => {
      if (!got) return 'no client was issued';
      const res = await post(adminPath.revokeClient(got.id));
      const parsed = AdminClientSchema.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      if (res.text.includes(got.token)) return 'the answer shows the secret';
      return parsed.data.revokedAt ? undefined : 'revokedAt is not set';
    });
    if (lockedClient) {
      const id: string = lockedClient;
      await attempt(ADMIN_CHECKS.lockedClient, async () => {
        const code = errorCode((await post(adminPath.revokeClient(id))).json);
        return code === 'locked' ? undefined : `answered ${code ?? 'no error'}`;
      });
    } else {
      check(ADMIN_CHECKS.lockedClient, true, 'skipped: no locked client listed');
    }
  } else {
    for (const name of [
      ADMIN_CHECKS.listClients,
      ADMIN_CHECKS.issueClient,
      ADMIN_CHECKS.secretOnce,
      ADMIN_CHECKS.revokeClient,
      ADMIN_CHECKS.lockedClient,
    ]) {
      check(name, true, 'skipped: the sink does not administer clients');
    }
  }

  if (admin.instances) {
    await attempt(ADMIN_CHECKS.removeInstance, async () => {
      const res = await post(adminPath.removeInstance(instanceId));
      const parsed = AdminRemovedSchema.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
      const list = AdminInstanceListSchema.parse((await post(adminPath.listInstances)).json);
      return list.instances.some((i) => i.id === instanceId) ? 'still listed' : undefined;
    });
    await attempt(ADMIN_CHECKS.removeAgain, async () => {
      const res = await post(adminPath.removeInstance(instanceId));
      const code = errorCode(res.json);
      return res.status === 404 && code === 'not_found'
        ? undefined
        : `answered ${res.status} ${code ?? ''}`;
    });
  } else {
    check(ADMIN_CHECKS.removeInstance, true, 'skipped: the sink does not administer instances');
    check(ADMIN_CHECKS.removeAgain, true, 'skipped: the sink does not administer instances');
  }

  await attempt(ADMIN_CHECKS.audit, async () => {
    const res = await post(adminPath.audit, { cursor: null, limit: 50 });
    const parsed = AdminAuditPageSchema.safeParse(res.json);
    if (res.status !== 200 || !parsed.success) return issues(parsed) ?? `status ${res.status}`;
    const mine = parsed.data.entries.filter((e) => e.actor.id === actingAdmin.id);
    const want = [
      ...(admin.instances ? ['instance_added', 'instance_renamed', 'instance_removed'] : []),
      ...(admin.clients ? ['client_issued', 'client_revoked'] : []),
    ];
    const missing = want.filter((a) => !mine.some((e) => e.action === a));
    if (missing.length) return `no entry for ${missing.join(', ')}`;
    const token = (issued as { token: string } | null)?.token;
    return token && res.text.includes(token) ? 'the log shows a secret' : undefined;
  });

  check(ADMIN_CHECKS.errors, badErrors.length === 0, badErrors.join(' | ') || undefined);
  return results;
}
