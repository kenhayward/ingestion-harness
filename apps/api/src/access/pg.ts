import type pg from 'pg';
import { lockFor } from './lockout.js';
import {
  dummyHash,
  hashPassword,
  newOneTimePassword,
  normaliseEmail,
  passwordProblem,
  verifyPassword,
} from './passwords.js';
import {
  ADMIN_LOGIN,
  ADMIN_NAME,
  ONE_TIME_PASSWORD_DAYS,
  USER_AGENT_MAX,
  UUID_RE,
  type AccessRepo,
  type AccessRole,
  type DisabledReason,
  type InvalidLogin,
  type LoginResult,
  type NewSignInEvent,
  type NewUser,
  type PasswordChange,
  type SessionInfo,
  type SignInEvent,
  type SignInResult,
  type User,
  type UserProblem,
  type UserStatus,
} from './repo.js';
import { newSessionId, newToken, sha256 } from './tokens.js';

const LOCKED = `(u.locked_until IS NOT NULL AND u.locked_until > now()
                 AND u.disabled_at IS NULL AND NOT u.bootstrap)`;
const STATUS = `CASE WHEN u.bootstrap THEN 'admin-from-log'
                     WHEN u.disabled_at IS NOT NULL THEN 'disabled'
                     WHEN ${LOCKED} THEN 'locked'
                     WHEN u.must_change_password THEN 'must-change'
                     ELSE 'active' END`;
const USER_COLUMNS = `u.id, u.name, u.email, u.role, u.created_at, u.created_by, u.last_sign_in_at,
  u.failed_sign_ins, u.last_failed_at, u.locked_until, u.disabled_at, u.disabled_reason,
  u.disabled_by, u.one_time_expires_at, ${STATUS} AS status`;

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: AccessRole;
  created_at: Date;
  created_by: string | null;
  last_sign_in_at: Date | null;
  failed_sign_ins: number;
  last_failed_at: Date | null;
  locked_until: Date | null;
  disabled_at: Date | null;
  disabled_reason: DisabledReason | null;
  disabled_by: string | null;
  one_time_expires_at: Date | null;
  status: UserStatus;
}

/** The row read (and, inside a transaction, locked) to decide a sign-in. */
interface AuthRow {
  id: string;
  name: string;
  email: string | null;
  role: AccessRole;
  bootstrap: boolean;
  password_hash: string;
  must_change_password: boolean;
  expired: boolean;
  disabled: boolean;
  locked: boolean;
  locked_until: Date | null;
  failed_sign_ins: number;
  last_failed_at: Date | null;
}
const AUTH_COLUMNS = `u.id, u.name, u.email, u.role, u.bootstrap, u.password_hash,
  u.must_change_password, u.failed_sign_ins, u.last_failed_at, u.locked_until,
  (u.must_change_password AND u.one_time_expires_at IS NOT NULL
     AND u.one_time_expires_at <= now()) AS expired,
  u.disabled_at IS NOT NULL AS disabled, ${LOCKED} AS locked`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
    lastSignInAt: iso(r.last_sign_in_at),
    failedSignIns: r.failed_sign_ins,
    lastFailedAt: iso(r.last_failed_at),
    lockedUntil: iso(r.locked_until),
    disabledAt: iso(r.disabled_at),
    disabledReason: r.disabled_reason,
    disabledBy: r.disabled_by,
    oneTimeExpiresAt: iso(r.one_time_expires_at),
  };
}

const toInfo = (r: {
  id: string;
  role: AccessRole;
  name: string;
  email: string | null;
  must_change_password: boolean;
}): SessionInfo => ({
  userId: r.id,
  role: r.role,
  label: r.name,
  email: r.email,
  mustChangePassword: r.must_change_password,
});

/** A unique violation, by index name: which field is taken. */
function taken(err: unknown): UserProblem | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  if (e.constraint === 'users_email_key') return 'email_taken';
  if (e.constraint === 'users_name_key') return 'name_taken';
  return null;
}

type Client = pg.PoolClient;

/** Users, sessions and the sign-in log in Postgres (migration 0040). Semantics match MemoryAccessRepo. */
export class PgAccessRepo implements AccessRepo {
  constructor(private readonly pool: pg.Pool) {}

  async rotateAdminPassword(): Promise<string> {
    const password = newToken();
    const hash = await hashPassword(password);
    await this.tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE users SET password_hash = $1, failed_sign_ins = 0, locked_until = NULL
          WHERE bootstrap RETURNING id`,
        [hash],
      );
      if (rows[0]) {
        await c.query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0].id]);
      } else {
        await c.query(
          `INSERT INTO users (name, email, role, bootstrap, password_hash, must_change_password)
           VALUES ($1, NULL, 'admin', true, $2, false)`,
          [ADMIN_NAME, hash],
        );
      }
    });
    return password;
  }

  async createUser(input: NewUser, by: string | null) {
    const password = newOneTimePassword();
    try {
      const { rows } = await this.pool.query<UserRow>(
        `WITH u AS (
           INSERT INTO users (name, email, role, password_hash, one_time_expires_at, created_by)
           VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6)
           RETURNING *)
         SELECT ${USER_COLUMNS} FROM u`,
        [
          input.name.trim(),
          normaliseEmail(input.email),
          input.role,
          await hashPassword(password),
          ONE_TIME_PASSWORD_DAYS,
          by,
        ],
      );
      return { user: toUser(rows[0]!), password };
    } catch (err) {
      const problem = taken(err);
      if (problem) return problem;
      throw err;
    }
  }

  async listUsers(): Promise<User[]> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users u ORDER BY u.bootstrap DESC, lower(btrim(u.name))`,
    );
    return rows.map(toUser);
  }

  async updateUser(id: string, patch: Partial<NewUser>): Promise<User | UserProblem> {
    const guard = await this.guard(id);
    if (guard) return guard;
    try {
      const { rows } = await this.pool.query<UserRow>(
        `WITH u AS (
           UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email),
                            role = COALESCE($4, role)
            WHERE id = $1 RETURNING *)
         SELECT ${USER_COLUMNS} FROM u`,
        [
          id,
          patch.name?.trim() ?? null,
          patch.email !== undefined ? normaliseEmail(patch.email) : null,
          patch.role ?? null,
        ],
      );
      return rows[0] ? toUser(rows[0]) : 'not_found';
    } catch (err) {
      const problem = taken(err);
      if (problem) return problem;
      throw err;
    }
  }

  async setEnabled(id: string, enabled: boolean, by: string | null): Promise<User | UserProblem> {
    const guard = await this.guard(id);
    if (guard) return guard;
    await this.tx(async (c) => {
      if (enabled) {
        await c.query(
          `UPDATE users SET failed_sign_ins = 0, locked_until = NULL, disabled_at = NULL,
                            disabled_reason = NULL, disabled_by = NULL
            WHERE id = $1`,
          [id],
        );
      } else {
        await c.query(
          `UPDATE users SET disabled_at = now(), disabled_reason = 'admin', disabled_by = $2
            WHERE id = $1 AND disabled_at IS NULL`,
          [id, by],
        );
        await c.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      }
    });
    return (await this.user(id)) ?? 'not_found';
  }

  async reissuePassword(id: string) {
    const guard = await this.guard(id);
    if (guard) return guard;
    const password = newOneTimePassword();
    const hash = await hashPassword(password);
    await this.tx(async (c) => {
      await c.query(
        `UPDATE users SET password_hash = $2, must_change_password = true,
                          one_time_expires_at = now() + make_interval(days => $3),
                          failed_sign_ins = 0, locked_until = NULL, disabled_at = NULL,
                          disabled_reason = NULL, disabled_by = NULL
          WHERE id = $1`,
        [id, hash, ONE_TIME_PASSWORD_DAYS],
      );
      await c.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    });
    const user = await this.user(id);
    return user ? { user, password } : ('not_found' as const);
  }

  async login(login: string, password: string): Promise<LoginResult> {
    const key = login.trim().toLowerCase();
    const where = key === ADMIN_LOGIN ? 'u.bootstrap' : 'u.email = $1';
    const { rows } = await this.pool.query<AuthRow>(
      `SELECT ${AUTH_COLUMNS} FROM users u WHERE ${where}`,
      key === ADMIN_LOGIN ? [] : [key],
    );
    const found = rows[0];
    // A lock is checked before the password, which is then never verified (D3).
    if (found?.locked) return { kind: 'locked', userId: found.id, until: iso(found.locked_until)! };
    const ok = await verifyPassword(password, found?.password_hash ?? dummyHash());
    if (!found) return { kind: 'invalid', userId: null, failures: null, locked: null };

    return this.tx(async (c): Promise<LoginResult> => {
      // Under the row lock, again: a parallel attempt may have changed it since the read.
      const row = await this.lockRow(c, found.id);
      if (!row) return { kind: 'invalid', userId: null, failures: null, locked: null };
      if (row.locked) return { kind: 'locked', userId: row.id, until: iso(row.locked_until)! };
      // The password changed between the read and the lock: this attempt checked the old one.
      if (row.password_hash !== found.password_hash) {
        return { kind: 'invalid', userId: row.id, failures: null, locked: null };
      }
      if (!ok) {
        if (row.bootstrap || row.disabled) {
          return { kind: 'invalid', userId: row.id, failures: null, locked: null };
        }
        return this.countFailure(c, row);
      }
      if (row.disabled) return { kind: 'disabled', userId: row.id };
      if (row.expired) return { kind: 'expired', userId: row.id };
      await c.query(
        `UPDATE users SET failed_sign_ins = 0, locked_until = NULL, last_sign_in_at = now()
          WHERE id = $1`,
        [row.id],
      );
      const sessionId = newSessionId();
      await c.query(`INSERT INTO sessions (id_hash, user_id) VALUES ($1, $2)`, [
        sha256(sessionId),
        row.id,
      ]);
      return {
        kind: 'ok',
        sessionId,
        session: toInfo(row),
        failedSinceLastSignIn: row.failed_sign_ins,
        lastFailedAt: iso(row.last_failed_at),
      };
    });
  }

  async changePassword(sessionId: string, current: string, next: string): Promise<PasswordChange> {
    const idHash = sha256(sessionId);
    const { rows } = await this.pool.query<AuthRow>(
      `SELECT ${AUTH_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1`,
      [idHash],
    );
    const found = rows[0];
    if (!found) return 'wrong';
    if (found.bootstrap) return 'admin-from-log';
    if (found.locked) return 'locked';
    const ok = await verifyPassword(current, found.password_hash);
    const problem = ok ? passwordProblem(next, { email: found.email, current }) : null;
    const hash = ok && !problem ? await hashPassword(next) : null;
    return this.tx(async (c): Promise<PasswordChange> => {
      const row = await this.lockRow(c, found.id);
      if (!row) return 'wrong';
      if (row.locked) return 'locked';
      if (!ok || row.password_hash !== found.password_hash) {
        if (!ok && !row.disabled) await this.countFailure(c, row);
        return 'wrong';
      }
      if (problem) return { problem };
      await c.query(
        `UPDATE users SET password_hash = $2, must_change_password = false,
                          one_time_expires_at = NULL, password_changed_at = now()
          WHERE id = $1`,
        [row.id, hash],
      );
      await c.query(`DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2`, [row.id, idHash]);
      return 'ok';
    });
  }

  async session(sessionId: string): Promise<SessionInfo | null> {
    const idHash = sha256(sessionId);
    const { rows } = await this.pool.query<{
      id: string;
      role: AccessRole;
      name: string;
      email: string | null;
      must_change_password: boolean;
      stale: boolean;
    }>(
      `SELECT u.id, u.role, u.name, u.email, u.must_change_password,
              s.last_seen_at < now() - interval '5 minutes' AS stale
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND u.disabled_at IS NULL
          AND s.last_seen_at > now() - interval '7 days'
          AND s.created_at   > now() - interval '30 days'`,
      [idHash],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.stale) {
      // Touch at most every 5 minutes: browsing shouldn't write on every request.
      await this.pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1`, [
        idHash,
      ]);
    }
    return toInfo(row);
  }

  async logout(sessionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE id_hash = $1`, [sha256(sessionId)]);
  }

  async recordSignIn(event: NewSignInEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO sign_in_events (user_id, result, failures, locked_until, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.userId,
        event.result,
        event.failures ?? null,
        event.lockedUntil ?? null,
        event.ip,
        event.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
      ],
    );
  }

  async listSignIns(opts: { userId?: string; limit: number }): Promise<SignInEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      at: Date;
      user_id: string | null;
      name: string | null;
      result: SignInResult;
      failures: number | null;
      locked_until: Date | null;
      ip: string;
      user_agent: string | null;
    }>(
      `SELECT e.id::text, e.at, e.user_id, u.name, e.result, e.failures, e.locked_until, e.ip,
              e.user_agent
         FROM sign_in_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE ($1::uuid IS NULL OR e.user_id = $1)
        ORDER BY e.at DESC, e.id DESC
        LIMIT $2`,
      [opts.userId ?? null, opts.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      userId: r.user_id,
      name: r.name,
      result: r.result,
      failures: r.failures,
      lockedUntil: iso(r.locked_until),
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  }

  async pruneSignIns(before: Date): Promise<number> {
    const { rowCount } = await this.pool.query(`DELETE FROM sign_in_events WHERE at < $1`, [
      before,
    ]);
    return rowCount ?? 0;
  }

  /** One counted failure: write what `lockFor` says for the new count (inside the row lock). */
  private async countFailure(c: Client, row: AuthRow): Promise<InvalidLogin> {
    const failures = row.failed_sign_ins + 1;
    const next = lockFor(failures);
    const { rows } = await c.query<{ locked_until: Date | null }>(
      `UPDATE users SET
         failed_sign_ins = $2,
         last_failed_at  = now(),
         locked_until    = CASE WHEN $3::bigint IS NULL THEN locked_until
                                ELSE now() + make_interval(secs => $3::bigint / 1000.0) END,
         disabled_at     = CASE WHEN $4 THEN now() ELSE disabled_at END,
         disabled_reason = CASE WHEN $4 THEN 'failed-sign-ins' ELSE disabled_reason END
       WHERE id = $1
       RETURNING locked_until`,
      [row.id, failures, typeof next === 'number' ? next : null, next === 'disable'],
    );
    if (next === 'disable') {
      await c.query(`DELETE FROM sessions WHERE user_id = $1`, [row.id]);
      return { kind: 'invalid', userId: row.id, failures, locked: 'disabled' };
    }
    const until = typeof next === 'number' ? iso(rows[0]?.locked_until ?? null) : null;
    return { kind: 'invalid', userId: row.id, failures, locked: until ? { until } : null };
  }

  private async lockRow(c: Client, id: string): Promise<AuthRow | undefined> {
    const { rows } = await c.query<AuthRow>(
      `SELECT ${AUTH_COLUMNS} FROM users u WHERE u.id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0];
  }

  private async user(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** not_found for an unknown or malformed id; admin-from-log for the bootstrap user. */
  private async guard(id: string): Promise<'not_found' | 'admin-from-log' | null> {
    if (!UUID_RE.test(id)) return 'not_found';
    const { rows } = await this.pool.query<{ bootstrap: boolean }>(
      `SELECT bootstrap FROM users WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return 'not_found';
    return rows[0].bootstrap ? 'admin-from-log' : null;
  }

  private async tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }
}
