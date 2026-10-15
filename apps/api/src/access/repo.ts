import { randomUUID } from 'node:crypto';
import { DISABLE_AFTER, LOCK_AFTER, lockFor } from './lockout.js';
import {
  DUMMY_HASH,
  hashPassword,
  newOneTimePassword,
  normaliseEmail,
  passwordProblem,
  verifyPassword,
} from './passwords.js';
import { newSessionId, newToken, sha256 } from './tokens.js';

export { DISABLE_AFTER, LOCK_AFTER };

export type AccessRole = 'admin' | 'user';
/** The reserved sign-in name of the admin from the log (ADR 0013, D1). */
export const ADMIN_LOGIN = 'admin';
export const ADMIN_NAME = 'Admin';
export const ONE_TIME_PASSWORD_DAYS = 7;
/** Sessions end after this long without use. */
export const SESSION_IDLE_MS = 7 * 86_400_000;
/** ... and this long after sign-in, however much they are used (D10). */
export const SESSION_MAX_MS = 30 * 86_400_000;
/** last_seen_at is written at most this often (not on every request). */
export const TOUCH_INTERVAL_MS = 5 * 60_000;
export const SIGN_IN_RETENTION_DAYS = 90;
/** User agents are stored up to this many characters. */
export const USER_AGENT_MAX = 200;

/** 'locked' = temporarily (lockedUntil in the future); a disable after 20 failures is 'disabled'. */
export type UserStatus = 'admin-from-log' | 'active' | 'must-change' | 'locked' | 'disabled';
export type DisabledReason = 'admin' | 'failed-sign-ins';

/** A user as listed to admins: never a hash. */
export interface User {
  id: string;
  name: string;
  /** null only for the admin from the log. */
  email: string | null;
  role: AccessRole;
  status: UserStatus;
  createdAt: string;
  createdBy: string | null;
  lastSignInAt: string | null;
  /** Consecutive failed sign-ins since the last success. */
  failedSignIns: number;
  lastFailedAt: string | null;
  /** In the future while temporarily locked (D3). */
  lockedUntil: string | null;
  disabledAt: string | null;
  disabledReason: DisabledReason | null;
  /** The admin's name; null when the 20th failure disabled it. */
  disabledBy: string | null;
  /** When the current one-time password stops working; null once the user has changed it. */
  oneTimeExpiresAt: string | null;
}

/** Who a valid session belongs to (`req.auth`). `label` = the user's name (D4). */
export interface SessionInfo {
  userId: string;
  role: AccessRole;
  label: string;
  email: string | null;
  mustChangePassword: boolean;
}

export type LoginResult =
  | {
      kind: 'ok';
      sessionId: string;
      session: SessionInfo;
      /** D9: the failures this success cleared, and when the last one was. */
      failedSinceLastSignIn: number;
      lastFailedAt: string | null;
    }
  /**
   * Unknown login (userId null), wrong password, or wrong password on a disabled account.
   * `failures` is the count after this one (null when nothing was counted); `locked` says what
   * this failure did: started a temporary lock, disabled the account, or neither.
   */
  | {
      kind: 'invalid';
      userId: string | null;
      failures: number | null;
      locked: { until: string } | 'disabled' | null;
    }
  /** Temporarily locked: refused without checking the password. */
  | { kind: 'locked'; userId: string; until: string }
  /** Right password, disabled account (by an admin or by DISABLE_AFTER failures). */
  | { kind: 'disabled'; userId: string }
  /** Right one-time password, but older than ONE_TIME_PASSWORD_DAYS. */
  | { kind: 'expired'; userId: string };

export type InvalidLogin = Extract<LoginResult, { kind: 'invalid' }>;

export type SignInResult =
  | 'ok'
  | 'wrong-password'
  | 'unknown-login'
  | 'locked'
  | 'disabled'
  | 'expired-one-time'
  | 'password-changed'
  | 'password-change-refused';

export interface SignInEvent {
  id: string;
  at: string;
  userId: string | null;
  /** The user's current name; null for an unknown login or a deleted user. */
  name: string | null;
  result: SignInResult;
  /** For 'wrong-password': the account's count after this failure; for 'ok', the count it cleared. */
  failures: number | null;
  /** When a lock this attempt started or met ends. */
  lockedUntil: string | null;
  ip: string;
  userAgent: string | null;
}

export interface NewSignInEvent {
  userId: string | null;
  result: SignInResult;
  failures?: number | null;
  lockedUntil?: string | null;
  ip: string;
  userAgent: string | null;
}

export interface NewUser {
  name: string;
  email: string;
  role: AccessRole;
}
export type UserProblem = 'not_found' | 'admin-from-log' | 'email_taken' | 'name_taken';
export type PasswordChange = 'ok' | 'wrong' | 'locked' | 'admin-from-log' | { problem: string };

/** Users, their browser sessions and the sign-in log (ADR 0013). `PgAccessRepo` / `MemoryAccessRepo`. */
export interface AccessRepo {
  /**
   * Set a new random password on the admin from the log (creating it the first time), unlock it
   * and end its sessions. Returns the password.
   */
  rotateAdminPassword(): Promise<string>;
  createUser(
    input: NewUser,
    by: string | null,
  ): Promise<{ user: User; password: string } | UserProblem>;
  /** The admin from the log first, then by name. */
  listUsers(): Promise<User[]>;
  updateUser(id: string, patch: Partial<NewUser>): Promise<User | UserProblem>;
  /** Enabling (the UI's Unlock too) clears a disable, a temporary lock and the failure count. Disabling ends every session. */
  setEnabled(id: string, enabled: boolean, by: string | null): Promise<User | UserProblem>;
  /** A new one-time password: must change, re-enabled, unlocked, count reset, every session ended. */
  reissuePassword(id: string): Promise<{ user: User; password: string } | UserProblem>;
  /** `login` = an email address (any case) or ADMIN_LOGIN. */
  login(login: string, password: string): Promise<LoginResult>;
  /**
   * For the session's user: current must verify (a wrong one counts as a failed sign-in and may
   * lock, exactly as in `login`; while locked it is 'locked' without checking), new must pass
   * `passwordProblem`. Ends the user's other sessions.
   */
  changePassword(sessionId: string, current: string, next: string): Promise<PasswordChange>;
  /** Null after SESSION_IDLE_MS without use, SESSION_MAX_MS after sign-in, or once the user is disabled. */
  session(sessionId: string): Promise<SessionInfo | null>;
  logout(sessionId: string): Promise<void>;
  /** D11. Callers make sure a failed write never fails a sign-in. */
  recordSignIn(event: NewSignInEvent): Promise<void>;
  /** Newest first; `limit` 1-200. */
  listSignIns(opts: { userId?: string; limit: number }): Promise<SignInEvent[]>;
  /** Deletes events before `before`; returns how many. */
  pruneSignIns(before: Date): Promise<number>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const nameKey = (name: string) => name.trim().toLowerCase();
export const oneTimeExpiry = (now: number) => now + ONE_TIME_PASSWORD_DAYS * 86_400_000;

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: AccessRole;
  bootstrap: boolean;
  hash: string;
  mustChange: boolean;
  oneTimeExpiresAt: number | null;
  failed: number;
  lastFailedAt: number | null;
  lockedUntil: number | null;
  disabledAt: number | null;
  disabledReason: DisabledReason | null;
  disabledBy: string | null;
  createdAt: number;
  createdBy: string | null;
  lastSignInAt: number | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** In-memory access repo for unit tests (injectable clock). */
export class MemoryAccessRepo implements AccessRepo {
  private readonly users = new Map<string, UserRow>();
  private readonly sessions = new Map<
    string,
    { userId: string; createdAt: number; lastSeen: number }
  >();
  private events: (SignInEvent & { seq: number })[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async rotateAdminPassword(): Promise<string> {
    const password = newToken();
    const hash = await hashPassword(password);
    let row = [...this.users.values()].find((u) => u.bootstrap);
    if (!row) {
      row = this.newRow(ADMIN_NAME, null, 'admin', hash, null);
      row.bootstrap = true;
      row.mustChange = false;
      row.oneTimeExpiresAt = null;
    }
    row.hash = hash;
    row.failed = 0;
    row.lockedUntil = null;
    this.endSessions(row.id);
    return password;
  }

  async createUser(input: NewUser, by: string | null) {
    const email = normaliseEmail(input.email);
    const name = input.name.trim();
    const clash = this.clash(null, name, email);
    if (clash) return clash;
    const password = newOneTimePassword();
    const row = this.newRow(name, email, input.role, await hashPassword(password), by);
    return { user: this.view(row), password };
  }

  async listUsers(): Promise<User[]> {
    return [...this.users.values()]
      .sort((a, b) =>
        a.bootstrap !== b.bootstrap
          ? a.bootstrap
            ? -1
            : 1
          : nameKey(a.name).localeCompare(nameKey(b.name)),
      )
      .map((r) => this.view(r));
  }

  async updateUser(id: string, patch: Partial<NewUser>): Promise<User | UserProblem> {
    const row = this.users.get(id);
    if (!row) return 'not_found';
    if (row.bootstrap) return 'admin-from-log';
    const name = patch.name?.trim() ?? row.name;
    const email = patch.email !== undefined ? normaliseEmail(patch.email) : row.email;
    const clash = this.clash(id, name, email);
    if (clash) return clash;
    row.name = name;
    row.email = email;
    row.role = patch.role ?? row.role;
    return this.view(row);
  }

  async setEnabled(id: string, enabled: boolean, by: string | null): Promise<User | UserProblem> {
    const row = this.users.get(id);
    if (!row) return 'not_found';
    if (row.bootstrap) return 'admin-from-log';
    if (enabled) this.clearLock(row);
    else if (row.disabledAt === null) this.disable(row, 'admin', by);
    return this.view(row);
  }

  async reissuePassword(id: string) {
    const row = this.users.get(id);
    if (!row) return 'not_found' as const;
    if (row.bootstrap) return 'admin-from-log' as const;
    const password = newOneTimePassword();
    row.hash = await hashPassword(password);
    row.mustChange = true;
    row.oneTimeExpiresAt = oneTimeExpiry(this.now());
    this.clearLock(row);
    this.endSessions(row.id);
    return { user: this.view(row), password };
  }

  async login(login: string, password: string): Promise<LoginResult> {
    const key = login.trim().toLowerCase();
    const row = [...this.users.values()].find((u) =>
      key === ADMIN_LOGIN ? u.bootstrap : u.email === key,
    );
    // A lock is checked before the password, which is then never verified (D3).
    if (row && this.lockedNow(row)) {
      return { kind: 'locked', userId: row.id, until: iso(row.lockedUntil)! };
    }
    const ok = await verifyPassword(password, row?.hash ?? DUMMY_HASH);
    if (!row) return { kind: 'invalid', userId: null, failures: null, locked: null };
    // Again after the await: a parallel guess may have locked it meanwhile (Pg: under FOR UPDATE).
    if (this.lockedNow(row)) {
      return { kind: 'locked', userId: row.id, until: iso(row.lockedUntil)! };
    }
    if (!ok) {
      if (row.bootstrap || row.disabledAt !== null) {
        return { kind: 'invalid', userId: row.id, failures: null, locked: null };
      }
      return this.countFailure(row);
    }
    if (row.disabledAt !== null) return { kind: 'disabled', userId: row.id };
    if (row.mustChange && row.oneTimeExpiresAt !== null && row.oneTimeExpiresAt <= this.now()) {
      return { kind: 'expired', userId: row.id };
    }
    const failedSinceLastSignIn = row.failed;
    const lastFailedAt = iso(row.lastFailedAt);
    row.failed = 0;
    row.lockedUntil = null;
    row.lastSignInAt = this.now();
    const sessionId = newSessionId();
    this.sessions.set(sha256(sessionId), {
      userId: row.id,
      createdAt: this.now(),
      lastSeen: this.now(),
    });
    return { kind: 'ok', sessionId, session: this.info(row), failedSinceLastSignIn, lastFailedAt };
  }

  async changePassword(sessionId: string, current: string, next: string): Promise<PasswordChange> {
    const key = sha256(sessionId);
    const s = this.sessions.get(key);
    const row = s && this.users.get(s.userId);
    if (!row) return 'wrong';
    if (row.bootstrap) return 'admin-from-log';
    if (this.lockedNow(row)) return 'locked';
    const ok = await verifyPassword(current, row.hash);
    if (this.lockedNow(row)) return 'locked';
    if (!ok) {
      this.countFailure(row);
      return 'wrong';
    }
    const problem = passwordProblem(next, { email: row.email, current });
    if (problem) return { problem };
    row.hash = await hashPassword(next);
    row.mustChange = false;
    row.oneTimeExpiresAt = null;
    for (const [k, other] of this.sessions) {
      if (other.userId === row.id && k !== key) this.sessions.delete(k);
    }
    return 'ok';
  }

  async session(sessionId: string): Promise<SessionInfo | null> {
    const s = this.sessions.get(sha256(sessionId));
    const row = s && this.users.get(s.userId);
    const now = this.now();
    if (!s || !row || row.disabledAt !== null) return null;
    if (s.lastSeen + SESSION_IDLE_MS < now || s.createdAt + SESSION_MAX_MS <= now) return null;
    if (now - s.lastSeen >= TOUCH_INTERVAL_MS) s.lastSeen = now;
    return this.info(row);
  }

  async logout(sessionId: string): Promise<void> {
    this.sessions.delete(sha256(sessionId));
  }

  async recordSignIn(event: NewSignInEvent): Promise<void> {
    this.seq += 1;
    this.events.push({
      id: String(this.seq),
      seq: this.seq,
      at: new Date(this.now()).toISOString(),
      userId: event.userId,
      name: null,
      result: event.result,
      failures: event.failures ?? null,
      lockedUntil: event.lockedUntil ?? null,
      ip: event.ip,
      userAgent: event.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    });
  }

  async listSignIns(opts: { userId?: string; limit: number }): Promise<SignInEvent[]> {
    return this.events
      .filter((e) => opts.userId === undefined || e.userId === opts.userId)
      .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
      .slice(0, opts.limit)
      .map(({ seq: _seq, ...e }) => ({
        ...e,
        name: (e.userId && this.users.get(e.userId)?.name) || null,
      }));
  }

  async pruneSignIns(before: Date): Promise<number> {
    const keep = this.events.filter((e) => Date.parse(e.at) >= before.getTime());
    const removed = this.events.length - keep.length;
    this.events = keep;
    return removed;
  }

  private newRow(
    name: string,
    email: string | null,
    role: AccessRole,
    hash: string,
    by: string | null,
  ): UserRow {
    const row: UserRow = {
      id: randomUUID(),
      name,
      email,
      role,
      bootstrap: false,
      hash,
      mustChange: true,
      oneTimeExpiresAt: oneTimeExpiry(this.now()),
      failed: 0,
      lastFailedAt: null,
      lockedUntil: null,
      disabledAt: null,
      disabledReason: null,
      disabledBy: null,
      createdAt: this.now(),
      createdBy: by,
      lastSignInAt: null,
    };
    this.users.set(row.id, row);
    return row;
  }

  private clash(id: string | null, name: string, email: string | null): UserProblem | null {
    for (const u of this.users.values()) {
      if (u.id === id) continue;
      if (email !== null && u.email === email) return 'email_taken';
      if (nameKey(u.name) === nameKey(name)) return 'name_taken';
    }
    return null;
  }

  private lockedNow(row: UserRow): boolean {
    return (
      !row.bootstrap &&
      row.disabledAt === null &&
      row.lockedUntil !== null &&
      row.lockedUntil > this.now()
    );
  }

  /** One counted failure (login and changePassword share it). */
  private countFailure(row: UserRow): InvalidLogin {
    row.failed += 1;
    row.lastFailedAt = this.now();
    const next = lockFor(row.failed);
    if (next === 'disable') {
      this.disable(row, 'failed-sign-ins', null);
      return { kind: 'invalid', userId: row.id, failures: row.failed, locked: 'disabled' };
    }
    if (next !== null) {
      row.lockedUntil = this.now() + next;
      return {
        kind: 'invalid',
        userId: row.id,
        failures: row.failed,
        locked: { until: iso(row.lockedUntil)! },
      };
    }
    return { kind: 'invalid', userId: row.id, failures: row.failed, locked: null };
  }

  private clearLock(row: UserRow) {
    row.failed = 0;
    row.lockedUntil = null;
    row.disabledAt = null;
    row.disabledReason = null;
    row.disabledBy = null;
  }

  private disable(row: UserRow, reason: DisabledReason, by: string | null) {
    row.disabledAt = this.now();
    row.disabledReason = reason;
    row.disabledBy = by;
    this.endSessions(row.id);
  }

  private endSessions(userId: string) {
    for (const [key, s] of this.sessions) if (s.userId === userId) this.sessions.delete(key);
  }

  private info(row: UserRow): SessionInfo {
    return {
      userId: row.id,
      role: row.role,
      label: row.name,
      email: row.email,
      mustChangePassword: row.mustChange,
    };
  }

  private view(row: UserRow): User {
    const status: UserStatus = row.bootstrap
      ? 'admin-from-log'
      : row.disabledAt !== null
        ? 'disabled'
        : this.lockedNow(row)
          ? 'locked'
          : row.mustChange
            ? 'must-change'
            : 'active';
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      status,
      createdAt: new Date(row.createdAt).toISOString(),
      createdBy: row.createdBy,
      lastSignInAt: iso(row.lastSignInAt),
      failedSignIns: row.failed,
      lastFailedAt: iso(row.lastFailedAt),
      lockedUntil: iso(row.lockedUntil),
      disabledAt: iso(row.disabledAt),
      disabledReason: row.disabledReason,
      disabledBy: row.disabledBy,
      oneTimeExpiresAt: iso(row.oneTimeExpiresAt),
    };
  }
}
