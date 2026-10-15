import { describe, expect, it } from 'vitest';
import {
  ADMIN_LOGIN,
  DISABLE_AFTER,
  LOCK_AFTER,
  ONE_TIME_PASSWORD_DAYS,
  type AccessRepo,
} from '../src/access/repo.js';

const MIN = 60_000;
const DAY = 86_400_000;

export type Clock = { now: () => number; advance: (ms: number) => void };
export type MakeRepo = (clock?: Clock) => Promise<AccessRepo>;

const fakeClock = (): Clock => {
  let t = Date.parse('2026-10-15T09:00:00Z');
  return { now: () => t, advance: (ms) => (t += ms) };
};

/**
 * The AccessRepo contract (ADR 0013), run on MemoryAccessRepo (with a fake clock) and on
 * PgAccessRepo (real clock: the clock-dependent cases are skipped there).
 */
export function accessContract(name: string, make: MakeRepo, opts: { clock: boolean }) {
  const ken = { name: 'Ken Hayward', email: 'Ken@Example.com ', role: 'user' as const };

  async function setup() {
    const clock = opts.clock ? fakeClock() : undefined;
    const repo = await make(clock);
    const adminPassword = await repo.rotateAdminPassword();
    const created = await repo.createUser(ken, 'Admin');
    if (typeof created === 'string') throw new Error(created);
    return { repo, clock, adminPassword, ...created };
  }

  const signIn = async (repo: AccessRepo, login: string, pw: string) => {
    const r = await repo.login(login, pw);
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
    return r;
  };

  const fail = async (repo: AccessRepo, n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await repo.login('ken@example.com', 'wrong guess'));
    return out;
  };

  describe(`${name}: access contract`, () => {
    it('signs the admin in with the password from the log', async () => {
      const { repo, adminPassword } = await setup();
      const r = await signIn(repo, ADMIN_LOGIN, adminPassword);
      expect(r.session).toMatchObject({
        role: 'admin',
        label: 'Admin',
        email: null,
        mustChangePassword: false,
      });
    });

    it('rotating ends the old admin password and its sessions', async () => {
      const { repo, adminPassword } = await setup();
      const { sessionId } = await signIn(repo, ADMIN_LOGIN, adminPassword);
      const next = await repo.rotateAdminPassword();
      expect(next).not.toBe(adminPassword);
      expect((await repo.login(ADMIN_LOGIN, adminPassword)).kind).toBe('invalid');
      expect(await repo.session(sessionId)).toBeNull();
      expect((await repo.listUsers()).filter((u) => u.status === 'admin-from-log')).toHaveLength(1);
      await signIn(repo, ADMIN_LOGIN, next);
    });

    it('stores the email normalised and refuses duplicates by email and by name', async () => {
      const { repo, user } = await setup();
      expect(user.email).toBe('ken@example.com');
      expect(await repo.createUser({ ...ken, name: 'Other', email: 'KEN@example.com' }, null)).toBe(
        'email_taken',
      );
      expect(
        await repo.createUser({ ...ken, name: 'ken hayward', email: 'k2@example.com' }, null),
      ).toBe('name_taken');
      expect(await repo.createUser({ ...ken, name: 'admin', email: 'k3@example.com' }, null)).toBe(
        'name_taken',
      );
    });

    it('lists the admin from the log first, then by name', async () => {
      const { repo } = await setup();
      await repo.createUser({ name: 'Ann', email: 'ann@example.com', role: 'admin' }, null);
      expect((await repo.listUsers()).map((u) => u.name)).toEqual(['Admin', 'Ann', 'Ken Hayward']);
    });

    it('a one-time password opens a restricted session until it is changed', async () => {
      const { repo, user, password } = await setup();
      expect(user.status).toBe('must-change');
      const first = await signIn(repo, ' KEN@example.com', password);
      expect(first.session.mustChangePassword).toBe(true);
      expect(await repo.changePassword(first.sessionId, password, 'short')).toEqual({
        problem: 'passwords need at least 12 characters',
      });
      expect(await repo.changePassword(first.sessionId, password, 'my new long phrase')).toBe('ok');
      expect((await repo.session(first.sessionId))?.mustChangePassword).toBe(false);
      expect((await repo.login('ken@example.com', password)).kind).toBe('invalid');
      await signIn(repo, 'ken@example.com', 'my new long phrase');
      const listed = (await repo.listUsers()).find((u) => u.id === user.id);
      expect(listed).toMatchObject({ status: 'active', oneTimeExpiresAt: null });
    });

    it("changing the password ends the user's other sessions only", async () => {
      const { repo, password } = await setup();
      const a = await signIn(repo, 'ken@example.com', password);
      await repo.changePassword(a.sessionId, password, 'my new long phrase');
      const b = await signIn(repo, 'ken@example.com', 'my new long phrase');
      const c = await signIn(repo, 'ken@example.com', 'my new long phrase');
      expect(
        await repo.changePassword(b.sessionId, 'my new long phrase', 'another long phrase'),
      ).toBe('ok');
      expect(await repo.session(b.sessionId)).not.toBeNull();
      expect(await repo.session(c.sessionId)).toBeNull();
    });

    it(`the ${LOCK_AFTER}th failure in a row locks, without checking passwords meanwhile`, async () => {
      const { repo, user, password } = await setup();
      const open = await signIn(repo, 'ken@example.com', password);
      const results = await fail(repo, LOCK_AFTER);
      expect(results.slice(0, 9).every((r) => r.kind === 'invalid' && r.locked === null)).toBe(
        true,
      );
      const last = results[9]!;
      expect(last.kind === 'invalid' && last.failures).toBe(LOCK_AFTER);
      expect(
        last.kind === 'invalid' && typeof last.locked === 'object' && last.locked !== null,
      ).toBe(true);
      // the right password is refused too, and nothing more is counted
      expect((await repo.login('ken@example.com', password)).kind).toBe('locked');
      expect((await repo.login('ken@example.com', 'wrong guess')).kind).toBe('locked');
      expect((await repo.listUsers()).find((u) => u.id === user.id)).toMatchObject({
        status: 'locked',
        failedSignIns: LOCK_AFTER,
      });
      // a temporary lock keeps open sessions
      expect(await repo.session(open.sessionId)).not.toBeNull();
    });

    it.skipIf(!opts.clock)('the first lock lasts 15 minutes', async () => {
      const { repo, clock, password } = await setup();
      const results = await fail(repo, LOCK_AFTER);
      expect(results[9]).toMatchObject({
        locked: { until: new Date(clock!.now() + 15 * MIN).toISOString() },
      });
      clock!.advance(15 * MIN - 1);
      expect((await repo.login('ken@example.com', password)).kind).toBe('locked');
      clock!.advance(2);
      await signIn(repo, 'ken@example.com', password);
    });

    it.skipIf(!opts.clock)('each failure after a lock runs out doubles the next lock', async () => {
      const { repo, clock, password } = await setup();
      await fail(repo, LOCK_AFTER);
      clock!.advance(15 * MIN + 1);
      const [eleventh] = await fail(repo, 1);
      expect(eleventh).toMatchObject({
        kind: 'invalid',
        failures: 11,
        locked: { until: new Date(clock!.now() + 30 * MIN).toISOString() },
      });
      clock!.advance(30 * MIN - 1);
      expect((await repo.login('ken@example.com', password)).kind).toBe('locked');
      clock!.advance(2);
      await signIn(repo, 'ken@example.com', password); // a success clears it all
      expect((await fail(repo, 1))[0]).toMatchObject({ failures: 1, locked: null });
    });

    it.skipIf(!opts.clock)(
      `the ${DISABLE_AFTER}th failure disables and ends sessions`,
      async () => {
        const { repo, clock, user, password } = await setup();
        const open = await signIn(repo, 'ken@example.com', password);
        await fail(repo, LOCK_AFTER);
        for (let n = LOCK_AFTER + 1; n <= DISABLE_AFTER; n++) {
          clock!.advance(24 * 60 * MIN + 1);
          // keep the session in use, so only the disable can end it (not the 7-day idle rule)
          expect(await repo.session(open.sessionId)).not.toBeNull();
          const [r] = await fail(repo, 1);
          expect(r).toMatchObject({
            failures: n,
            locked: n === DISABLE_AFTER ? 'disabled' : expect.anything(),
          });
        }
        expect(await repo.session(open.sessionId)).toBeNull();
        clock!.advance(24 * 60 * MIN + 1);
        expect(await repo.login('ken@example.com', password)).toEqual({
          kind: 'disabled',
          userId: user.id,
        });
        expect((await repo.listUsers()).find((u) => u.id === user.id)).toMatchObject({
          status: 'disabled',
          disabledReason: 'failed-sign-ins',
          disabledBy: null,
          failedSignIns: DISABLE_AFTER,
        });
      },
    );

    it('a success resets the count and reports what it cleared (D9)', async () => {
      const { repo, password } = await setup();
      await fail(repo, LOCK_AFTER - 1);
      const r = await signIn(repo, 'ken@example.com', password);
      expect(r.failedSinceLastSignIn).toBe(LOCK_AFTER - 1);
      expect(r.lastFailedAt).not.toBeNull();
      await fail(repo, LOCK_AFTER - 1);
      expect((await signIn(repo, 'ken@example.com', password)).failedSinceLastSignIn).toBe(
        LOCK_AFTER - 1,
      );
      expect((await signIn(repo, 'ken@example.com', password)).failedSinceLastSignIn).toBe(0);
    });

    it('never locks the admin from the log (D2)', async () => {
      const { repo, adminPassword } = await setup();
      for (let i = 0; i < DISABLE_AFTER + 5; i++) await repo.login(ADMIN_LOGIN, 'wrong');
      await signIn(repo, ADMIN_LOGIN, adminPassword);
    });

    it('an unknown login is invalid without a user', async () => {
      const { repo } = await setup();
      expect(await repo.login('nobody@example.com', 'x')).toEqual({
        kind: 'invalid',
        userId: null,
        failures: null,
        locked: null,
      });
    });

    it('disable ends sessions; enable clears a disable, a lock and the count', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      expect(await repo.setEnabled(user.id, false, 'Admin')).toMatchObject({
        status: 'disabled',
        disabledReason: 'admin',
        disabledBy: 'Admin',
      });
      expect(await repo.session(s.sessionId)).toBeNull();
      expect(await repo.login('ken@example.com', password)).toEqual({
        kind: 'disabled',
        userId: user.id,
      });
      // a wrong password on a disabled account is not counted
      expect(await repo.login('ken@example.com', 'wrong')).toMatchObject({
        kind: 'invalid',
        failures: null,
      });
      expect(await repo.setEnabled(user.id, true, 'Admin')).toMatchObject({
        status: 'must-change',
        failedSignIns: 0,
        disabledAt: null,
        disabledReason: null,
      });
      await fail(repo, LOCK_AFTER);
      expect(await repo.setEnabled(user.id, true, 'Admin')).toMatchObject({
        status: 'must-change',
        failedSignIns: 0,
        lockedUntil: null,
      });
      await signIn(repo, 'ken@example.com', password);
    });

    it.skipIf(!opts.clock)(
      'sessions end 30 days after sign-in even when used daily (D10)',
      async () => {
        const { repo, clock, password } = await setup();
        const s = await signIn(repo, 'ken@example.com', password);
        for (let day = 1; day < 30; day++) {
          clock!.advance(DAY);
          expect(await repo.session(s.sessionId)).not.toBeNull();
        }
        clock!.advance(DAY);
        expect(await repo.session(s.sessionId)).toBeNull();
      },
    );

    it.skipIf(!opts.clock)('sessions end after 7 idle days', async () => {
      const { repo, clock, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      clock!.advance(7 * DAY + 1);
      expect(await repo.session(s.sessionId)).toBeNull();
    });

    it('records, lists and prunes sign-in events (D11)', async () => {
      const { repo, user } = await setup();
      await repo.recordSignIn({
        userId: user.id,
        result: 'wrong-password',
        failures: 1,
        ip: '10.0.0.1',
        userAgent: 'Firefox',
      });
      await repo.recordSignIn({
        userId: null,
        result: 'unknown-login',
        ip: '10.0.0.2',
        userAgent: null,
      });
      const all = await repo.listSignIns({ limit: 50 });
      expect(all.map((e) => e.result)).toEqual(['unknown-login', 'wrong-password']);
      expect(all[1]).toMatchObject({
        userId: user.id,
        name: 'Ken Hayward',
        failures: 1,
        lockedUntil: null,
        ip: '10.0.0.1',
        userAgent: 'Firefox',
      });
      expect(all[0]).toMatchObject({ userId: null, name: null });
      expect((await repo.listSignIns({ userId: user.id, limit: 50 })).map((e) => e.result)).toEqual(
        ['wrong-password'],
      );
      expect(await repo.listSignIns({ limit: 1 })).toHaveLength(1);
      expect(await repo.pruneSignIns(new Date('2000-01-01'))).toBe(0);
      expect(await repo.pruneSignIns(new Date('2100-01-01'))).toBe(2);
      expect(await repo.listSignIns({ limit: 50 })).toEqual([]);
    });

    it('truncates long user agents to 200 characters', async () => {
      const { repo } = await setup();
      await repo.recordSignIn({
        userId: null,
        result: 'unknown-login',
        ip: '10.0.0.3',
        userAgent: 'x'.repeat(500),
      });
      expect((await repo.listSignIns({ limit: 1 }))[0]?.userAgent).toHaveLength(200);
    });

    it('reissue unlocks, ends sessions and replaces the password', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      await fail(repo, LOCK_AFTER);
      const re = await repo.reissuePassword(user.id);
      if (typeof re === 'string') throw new Error(re);
      expect(re.password).not.toBe(password);
      expect(re.user).toMatchObject({ status: 'must-change', failedSignIns: 0, lockedUntil: null });
      expect(await repo.session(s.sessionId)).toBeNull();
      expect((await repo.login('ken@example.com', password)).kind).toBe('invalid');
      await signIn(repo, 'ken@example.com', re.password);
    });

    it('the admin from the log cannot be edited, disabled, reissued or change its password', async () => {
      const { repo, adminPassword } = await setup();
      const admin = (await repo.listUsers()).find((u) => u.status === 'admin-from-log')!;
      expect(await repo.updateUser(admin.id, { name: 'X' })).toBe('admin-from-log');
      expect(await repo.setEnabled(admin.id, false, null)).toBe('admin-from-log');
      expect(await repo.reissuePassword(admin.id)).toBe('admin-from-log');
      const s = await signIn(repo, ADMIN_LOGIN, adminPassword);
      expect(await repo.changePassword(s.sessionId, adminPassword, 'a whole new phrase')).toBe(
        'admin-from-log',
      );
    });

    it('edits name, email and role; a role change applies to open sessions', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      expect(
        await repo.updateUser(user.id, { role: 'admin', email: ' Ken@New.example' }),
      ).toMatchObject({ role: 'admin', email: 'ken@new.example' });
      expect((await repo.session(s.sessionId))?.role).toBe('admin');
      expect(await repo.updateUser(user.id, { name: 'Kenneth' })).toMatchObject({
        name: 'Kenneth',
      });
      expect((await repo.session(s.sessionId))?.label).toBe('Kenneth');
      await repo.createUser({ name: 'Ann', email: 'ann@example.com', role: 'user' }, null);
      expect(await repo.updateUser(user.id, { email: 'ANN@example.com' })).toBe('email_taken');
      expect(await repo.updateUser(user.id, { name: 'ann' })).toBe('name_taken');
      expect(await repo.updateUser('00000000-0000-4000-8000-000000000000', { name: 'x' })).toBe(
        'not_found',
      );
      expect(await repo.updateUser('not-a-uuid', { name: 'x' })).toBe('not_found');
    });

    it('a wrong current password counts as a failed sign-in', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      expect(await repo.changePassword(s.sessionId, 'not it', 'my new long phrase')).toBe('wrong');
      expect((await repo.listUsers()).find((u) => u.id === user.id)?.failedSignIns).toBe(1);
    });

    it('while locked, a password change is refused without checking the current password', async () => {
      const { repo, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      await fail(repo, LOCK_AFTER);
      expect(await repo.changePassword(s.sessionId, password, 'my new long phrase')).toBe('locked');
    });

    it.skipIf(!opts.clock)(
      `one-time passwords expire after ${ONE_TIME_PASSWORD_DAYS} days`,
      async () => {
        const { repo, clock, user, password } = await setup();
        clock!.advance(ONE_TIME_PASSWORD_DAYS * DAY + 1);
        expect(await repo.login('ken@example.com', password)).toEqual({
          kind: 'expired',
          userId: user.id,
        });
      },
    );
  });
}
