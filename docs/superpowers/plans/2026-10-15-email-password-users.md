# Email and password users: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace user access tokens with persistent users who sign in with an email address and a password, all inside the stack. The admin token from the API log stays as the password of a reserved `admin` user. S3 keys are unchanged.

**Architecture:** A `users` table replaces `access_tokens` (migration 0039). Sessions point at a user instead of a token. The `AccessRepo` port keeps its name and its two adapters (`MemoryAccessRepo` for unit tests, `PgAccessRepo`), and gets a user-shaped contract that one shared test suite runs against both. Passwords are hashed with `node:crypto` scrypt, so there is no new dependency. A one-time password opens a *restricted* session that can only change the password. Ten failed sign-ins in a row lock the account for 15 minutes; each further failure doubles the lock (capped at 24 hours), and twenty disable it until an admin unlocks it. The per-IP limiter stays as a second, independent defence. Every sign-in attempt is recorded in `sign_in_events` (kept 90 days) for an admin's *Recent sign-ins* panel, and a user who signs in after failed attempts is told how many there were. Sessions end after 7 idle days or 30 days in all.

**Tech stack:** Fastify + Zod (API), `node:crypto` (`scrypt`, `randomInt`, `timingSafeEqual`), Postgres, React + Testing Library (web), bash smoke test.

**Spec:** this document, written from the request of 2026-10-15 (the request is quoted under *Requirements*). The design decisions are under *Decisions*. The ADR written in Task 8 becomes the lasting record.

---

## Requirements (from the request)

1. Email address and password authentication entirely within the stack: no external providers.
2. Keep the admin seed token from the log, as the password of an **Admin** user with a reserved name.
3. An admin registers each user with a Name, an Email address and a generated one-time password.
4. The user must change the one-time password at their first sign-in.
5. Retire and remove user access tokens.
6. S3 keys (ADR 0008) unchanged.
7. The Access screen lists users, not tokens, with icon actions on each row: enable/disable, edit, reissue the one-time password.
8. Defence against password guessing: an account is disabled after at most 10 failed attempts.

## Decisions (confirmed 2026-10-15, with suggestions S1, S2, S4 and S6 adopted)

| # | Decision | Default in this plan | Why |
| --- | --- | --- | --- |
| D1 | How the admin signs in | Sign-in name `admin` (the reserved name; the display name is **Admin**), password = the `ADMIN TOKEN` line from the log. It still rotates on every start. The account can't be edited, disabled or locked, and its password can't be changed. | The deploy and smoke scripts keep working with only the login body changed. |
| D2 | Lockout for `admin` | **Exempt** from the 10-strike lockout. The per-IP limit still applies. | Its password is 256-bit, so the lockout adds no protection. Anyone who could reach the sign-in page could lock out the only account that can unlock others, until the next restart. |
| D3 | What a lockout means (S1) | Counted per account over **consecutive** failures; a successful sign-in resets the count. The **10th** failure locks sign-in for **15 minutes**. Every further failure (possible only once a lock has run out) locks again for twice as long: 30 m, 1 h, 2 h… capped at **24 h**. The **20th** failure disables the account (`disabled_reason = 'failed-sign-ins'`) and ends its sessions. A temporary lock keeps existing sessions. While locked, the password is **not checked**, and any password gets 429 `too many failed sign-ins for this account: try again after <time>`. An admin's *Unlock* (Enable) or *Reissue one-time password* clears the count, the lock and a disable. | Ten attempts are the most anyone gets before sign-in stops, as asked. Someone who knows an email address can delay that person, but not shut them out for good, and it clears without an admin. Checking the password during a lock would leak whether a guess was right. |
| D9 | Failed attempts since the last visit (S2) | A successful sign-in answers `failedSinceLastSignIn` (the count before it is reset) and `lastFailedAt`. The web shows them once, as a dismissible notice: *3 failed sign-ins since your last visit, the last one today at 10:42. If that wasn't you, tell an admin.* | The person being guessed at is the first to notice. |
| D10 | Session lifetime (S4) | A session ends after **7 idle days** (as today) **or 30 days** after sign-in, whichever comes first. The cookie's `maxAge` is 30 days. | It limits how long a stolen cookie stays useful. People sign in about once a month. |
| D11 | Sign-in audit (S6) | Each attempt at `POST /api/auth/login`, and each password change, adds a `sign_in_events` row: time, user (null for an unknown login), result, client IP, user agent (first 200 characters). The login an unknown user typed is **not** stored. Rate-limited (429 by IP) attempts are only logged, not stored, which bounds the table under a scan. Rows older than **90 days** are deleted at API start and hourly. Admins read them with `GET /api/sign-ins` and in the Access page's *Recent sign-ins* panel. | Admins can see guessing, and which devices people use, without reading container logs. Not storing typed logins keeps mistyped passwords pasted into the email field out of the database. |
| D4 | Name in the audit trail | `req.auth.label` = the user's **name** (as `created_by`, `retired_by`, `updated_by` etc. use today). Names are unique, case-insensitively. | Every `req.auth?.label` call site keeps working unchanged. Unique names keep "My jobs" (`?mine=1`, matched by label) unambiguous. |
| D5 | Existing tokens | Migration 0039 drops `access_tokens` and their sessions, and empties `workbench_pins` (its owners were token ids). Everyone signs in again, and the admin creates users. | There is no meaningful way to map a token to an email address. |
| D6 | Admin users | `role` is on the user (`admin` / `user`), set when the user is added or edited. This replaces issued admin tokens. | Full admins, as today; every check stays on the role. |
| D7 | One-time password lifetime | Valid for **7 days**; after that, signing in with it says to ask an admin to reissue it. | A password sent by chat or email shouldn't stay usable for ever. |
| D8 | Password policy | 12 to 200 characters. It must differ from the current password and must not contain the part of the email address before the `@` (when that part is 4 or more characters). | Long passphrases, no complexity rules (NIST 800-63B). |

## Global constraints

- Hash: scrypt `N=32768, r=8, p=1`, 16-byte salt, 32-byte key, stored as `scrypt$32768$8$1$<salt b64url>$<key b64url>`, `maxmem` 64 MiB. Compare with `timingSafeEqual`.
- One-time password: 16 characters from `abcdefghjkmnpqrstuvwxyz23456789`, shown as `xxxx-xxxx-xxxx-xxxx` (about 79 bits). Its plaintext appears only in the response that creates it; only its hash is stored.
- `LOCK_AFTER = 10`, `DISABLE_AFTER = 20`, `FIRST_LOCK_MS = 15 * 60_000`, `MAX_LOCK_MS = 24 * 3_600_000`. A failure that brings the count to `n` (with `LOCK_AFTER <= n < DISABLE_AFTER`) locks for `min(FIRST_LOCK_MS * 2 ** (n - LOCK_AFTER), MAX_LOCK_MS)`. The per-IP `LoginLimiter` stays as it is: 10 failures per client per 15 minutes.
- Unknown email, wrong password and a disabled account with a wrong password all answer **401 `invalid email or password`**. Only someone who presents the correct password learns that the account is disabled (403) or that the one-time password has expired (403). A locked account answers **429** whatever the password, without checking it. This tells a guesser that the email exists, but only after they have spent 10 guesses on it; ADR 0013 records the trade-off.
- `SESSION_MAX_MS = 30 * 86_400_000` alongside `SESSION_IDLE_MS`. `SIGN_IN_RETENTION_DAYS = 90`.
- When the user is unknown, still verify against a dummy hash, so response time doesn't reveal which emails exist.
- Sessions: as today (`ih_session` cookie, hash stored, 7-day idle end, touched every 5 minutes, `cookieSite` unchanged, cross-site guard unchanged), plus the 30-day limit (D10). The cookie's `maxAge` is always 30 days.
- A restricted session (`mustChangePassword`) may call only `GET /api/auth/me`, `PUT /api/auth/password` and `POST /api/auth/logout`. Anything else is a **403 `change your one-time password first`**.
- Admin-only routes keep `'x-admin': true` and the OpenAPI checks. Every new route is documented.
- Words in the UI: "one-time password", "Disable", "Enable", "Reissue one-time password". No more "token" anywhere on the Access page except under S3 keys.
- No S3 key code changes (`apps/api/src/s3keys/`, `routes/s3-keys.ts`, `S3KeysSection.tsx`).

## Review focus

1. **Parallel wrong guesses**: 15 concurrent wrong passwords must count to exactly 10 and lock exactly once (the 5 that lose the race are refused as locked, not counted), and a correct guess sent alongside must not get in. Pg checks the lock in the same `UPDATE` (Task 3 test).
2. **A disabled user's existing session**: disabling (by an admin or by the 20th failure) and reissuing end every session at once, so the next request is a 401. A temporary lock does not (Task 2 tests).
3. **Email case and whitespace**: `Ken@X.com ` signs in as `ken@x.com`, and adding `KEN@x.com` next to `ken@x.com` is a 409 (Task 2 test).
4. **A restricted session calling the API directly**: `GET /api/specs` with a one-time-password session is a 403, not data (Task 4 sweep test).
5. **The admin editing themselves**: an admin can't disable themselves or demote themselves (409), so they can't drop their own access by mistake mid-session (Task 4 test).

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `apps/api/src/access/passwords.ts` | create | `hashPassword`, `verifyPassword`, `DUMMY_HASH`, `newOneTimePassword`, `passwordProblem` |
| `apps/api/src/access/tokens.ts` | modify | keep `newToken` (the admin password), `newSessionId`, `sha256` |
| `apps/api/src/access/repo.ts` | rewrite | `AccessRepo` user contract, `MemoryAccessRepo` |
| `apps/api/src/access/pg.ts` | rewrite | `PgAccessRepo` |
| `apps/api/src/access/routes.ts` | rewrite | auth routes, the restricted-session hook, user admin routes |
| `apps/api/src/access/users-routes.ts` | create | `/api/users*` and `/api/sign-ins` admin routes (keeps `routes.ts` focused on sessions) |
| `apps/api/src/access/lockout.ts` | create | `lockFor(failures)`: the pure lock schedule (D3), shared by both adapters |
| `apps/api/test/lockout.test.ts` | create | table-driven schedule test |
| `apps/web/src/access/SignInsPanel.tsx` | create | *Recent sign-ins* (D11) |
| `apps/web/src/access/FailedSignInsNotice.tsx` | create | the once-only notice after sign-in (D9) |
| `apps/api/src/routes/workbench-pins.ts` | modify | owner = `req.auth.userId` |
| `apps/api/src/server.ts` | modify | `rotateAdminPassword`, the log line text unchanged |
| `apps/api/src/openapi/document.ts` | modify | tag `Users` replaces `Access tokens` |
| `db/migrations/0039_users.sql` | create | `users`, new `sessions`, drop tokens, empty pins |
| `apps/api/test/access-contract.ts` | create | the shared repo contract (Memory + Pg) |
| `apps/api/test/access-repo.test.ts` | rewrite | runs the contract on Memory |
| `apps/api/test/integration/access-pg.test.ts` | rewrite | runs the contract on Pg, plus the concurrency test |
| `apps/api/test/passwords.test.ts` | create | hashing and policy |
| `apps/api/test/access.test.ts` | rewrite | routes, the sweep, restricted sessions |
| `apps/web/src/api/client.ts` | modify | `Me`, `login(login, password)`, `changePassword`, `User` + user calls; token calls removed |
| `apps/web/src/access/SignIn.tsx` | modify | email + password form |
| `apps/web/src/access/ChangePassword.tsx` | create | first sign-in screen, also used from the account menu |
| `apps/web/src/access/AccessPage.tsx` | rewrite | Users list with icon actions; S3 keys section kept |
| `apps/web/src/access/UserDialog.tsx` | create | add / edit dialog |
| `apps/web/src/access/derive.ts` | rewrite | `userStatus`, `userCounts`, `userMatches` |
| `apps/web/src/ui/Icon.tsx` | modify | add `pencil`, `user-off`, `user-check`, `key` if missing |
| `apps/web/src/App.tsx`, `shell/AppShell.tsx` | modify | must-change gate; *Change password* in the account menu |
| `apps/web/test/fake-api.ts` | modify | fake user calls |
| `deploy/scripts/smoke-test.sh` | modify | user flow instead of token flow |
| `docs/adr/0013-email-password-users.md` | create | supersedes the token parts of ADR 0006 |
| `docs/adr/0006-token-access.md` | modify | status line: superseded in part by 0013 |
| `CLAUDE.md` | modify | **Access** bullet |
| `docs/openapi.json` | regenerate | `npm run openapi` |

---

### Task 1: Password primitives

**Files:**
- Create: `apps/api/src/access/passwords.ts`
- Test: `apps/api/test/passwords.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, stored: string): Promise<boolean>`, `DUMMY_HASH: string`, `newOneTimePassword(): string`, `passwordProblem(plain: string, ctx: { email: string | null; current?: string }): string | null`, `normaliseEmail(email: string): string`, `MIN_PASSWORD = 12`, `MAX_PASSWORD = 200`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/passwords.test.ts
import { describe, expect, it } from 'vitest';
import {
  DUMMY_HASH,
  hashPassword,
  newOneTimePassword,
  normaliseEmail,
  passwordProblem,
  verifyPassword,
} from '../src/access/passwords.js';

describe('passwords', () => {
  it('hashes with a fresh salt and verifies', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
  });

  it('refuses malformed stored hashes instead of throwing', async () => {
    for (const bad of ['', 'scrypt$1$2', 'bcrypt$x', 'scrypt$32768$8$1$!!$!!']) {
      expect(await verifyPassword('x', bad)).toBe(false);
    }
  });

  it('has a dummy hash that verifies nothing', async () => {
    expect(await verifyPassword('', DUMMY_HASH)).toBe(false);
  });

  it('makes readable one-time passwords', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = newOneTimePassword();
      expect(p).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it.each([
    ['short', 'a'.repeat(11), null, 'passwords need at least 12 characters'],
    ['long', 'a'.repeat(201), null, 'passwords can have at most 200 characters'],
    ['email', 'kenhayward-2026!', 'kenhayward@x.com', 'the password must not contain your email address'],
    ['ok', 'a perfectly fine phrase', 'ken@x.com', null],
    ['short local part is ignored', 'bob is my uncle ok', 'bob@x.com', null],
  ])('policy: %s', (_case, pw, email, problem) => {
    expect(passwordProblem(pw, { email })).toBe(problem);
  });

  it('policy: must differ from the current password', () => {
    expect(passwordProblem('same old phrase!', { email: null, current: 'same old phrase!' })).toBe(
      'choose a password different from the current one',
    );
  });

  it('normalises emails', () => {
    expect(normaliseEmail('  Ken@Stocks-Hayward.COM ')).toBe('ken@stocks-hayward.com');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run apps/api/test/passwords.test.ts`
Expected: FAIL, `Cannot find module '../src/access/passwords.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/access/passwords.ts
import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** scrypt parameters (ADR 0013). Stored in each hash, so they can be raised later. */
const N = 32768;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;

function derive(plain: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(plain.normalize('NFKC'), salt, KEY_BYTES, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** False for a wrong password and for anything that is not one of our hashes. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  if (expected.length !== KEY_BYTES) return false;
  try {
    const actual = await derive(plain, Buffer.from(salt, 'base64url'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Verified against when the email is unknown, so timing does not reveal which emails exist. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

const OTP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 16 characters in groups of 4 (about 79 bits): easy to read out, nothing ambiguous. */
export function newOneTimePassword(): string {
  const chars = Array.from({ length: 16 }, () => OTP_ALPHABET[randomInt(OTP_ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Why a new password is refused, or null (ADR 0013, D8). */
export function passwordProblem(
  plain: string,
  ctx: { email: string | null; current?: string },
): string | null {
  if (plain.length < MIN_PASSWORD) return `passwords need at least ${MIN_PASSWORD} characters`;
  if (plain.length > MAX_PASSWORD) return `passwords can have at most ${MAX_PASSWORD} characters`;
  if (ctx.current !== undefined && plain === ctx.current) {
    return 'choose a password different from the current one';
  }
  const local = ctx.email?.split('@')[0] ?? '';
  if (local.length >= 4 && plain.toLowerCase().includes(local.toLowerCase())) {
    return 'the password must not contain your email address';
  }
  return null;
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run apps/api/test/passwords.test.ts`
Expected: PASS (the hashing tests take about 0.1 s per hash).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/access/passwords.ts apps/api/test/passwords.test.ts
git commit -m "API: scrypt password hashing, one-time passwords and the password policy"
```

---

### Task 2: The user contract and `MemoryAccessRepo`

**Files:**
- Rewrite: `apps/api/src/access/repo.ts`
- Create: `apps/api/test/access-contract.ts` (exported `accessContract(make)`, shared with Task 3)
- Rewrite: `apps/api/test/access-repo.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces (exact; Tasks 3, 4 and 6 rely on these):

```ts
export type AccessRole = 'admin' | 'user';
/** The reserved sign-in name of the admin from the log (D1). */
export const ADMIN_LOGIN = 'admin';
export const ADMIN_NAME = 'Admin';
export { LOCK_AFTER, DISABLE_AFTER } from './lockout.js';
export const ONE_TIME_PASSWORD_DAYS = 7;
export const SESSION_IDLE_MS = 7 * 86_400_000;
export const SESSION_MAX_MS = 30 * 86_400_000;
export const TOUCH_INTERVAL_MS = 5 * 60_000;
export const SIGN_IN_RETENTION_DAYS = 90;

/** 'locked' = temporarily (lockedUntil in the future); a disable after 20 failures is 'disabled'. */
export type UserStatus = 'admin-from-log' | 'active' | 'must-change' | 'locked' | 'disabled';
export type DisabledReason = 'admin' | 'failed-sign-ins';

export type SignInResult =
  | 'ok'
  | 'wrong-password'
  | 'unknown-login'
  | 'locked'            // refused: the account was locked when the attempt came
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
  /** For 'wrong-password': the account's count after this failure; for a lock, when it ends. */
  failures: number | null;
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

/** Who a valid session belongs to (`req.auth`). `label` = the name (D4). */
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

export interface NewUser { name: string; email: string; role: AccessRole }
export type UserProblem = 'not_found' | 'admin-from-log' | 'email_taken' | 'name_taken';

export interface AccessRepo {
  /** Set a new random password on the admin from the log (creating it the first time), unlock it, end its sessions. Returns the password. */
  rotateAdminPassword(): Promise<string>;
  createUser(input: NewUser, by: string | null): Promise<{ user: User; password: string } | UserProblem>;
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
  changePassword(
    sessionId: string,
    current: string,
    next: string,
  ): Promise<'ok' | 'wrong' | 'locked' | 'admin-from-log' | { problem: string }>;
  /** Null after SESSION_IDLE_MS without use, SESSION_MAX_MS after sign-in, or once the user is disabled. */
  session(sessionId: string): Promise<SessionInfo | null>;
  logout(sessionId: string): Promise<void>;
  /** D11. Writes never fail a sign-in: the route catches and logs. */
  recordSignIn(event: NewSignInEvent): Promise<void>;
  /** Newest first; `limit` 1-200. */
  listSignIns(opts: { userId?: string; limit: number }): Promise<SignInEvent[]>;
  /** Deletes events before `before`; returns how many. */
  pruneSignIns(before: Date): Promise<number>;
}
```

- [ ] **Step 0: The lock schedule, test first**

```ts
// apps/api/test/lockout.test.ts
import { describe, expect, it } from 'vitest';
import { lockFor } from '../src/access/lockout.js';

const M = 60_000;
describe('lockFor', () => {
  it.each([
    [1, null], [9, null],
    [10, 15 * M], [11, 30 * M], [12, 60 * M], [13, 120 * M], [14, 240 * M],
    [15, 480 * M], [16, 960 * M], [17, 1440 * M], [18, 1440 * M], [19, 1440 * M],
    [20, 'disable'], [25, 'disable'],
  ] as const)('%i failures -> %s', (n, expected) => {
    expect(lockFor(n)).toBe(expected);
  });
});
```

```ts
// apps/api/src/access/lockout.ts
/** ADR 0013, D3: the 10th consecutive failure locks for 15 minutes, each one after doubles it (at most 24 h), the 20th disables. */
export const LOCK_AFTER = 10;
export const DISABLE_AFTER = 20;
export const FIRST_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 24 * 3_600_000;

/** What a failure that brings the count to `failures` does: nothing, lock for N ms, or disable. */
export function lockFor(failures: number): number | 'disable' | null {
  if (failures >= DISABLE_AFTER) return 'disable';
  if (failures < LOCK_AFTER) return null;
  return Math.min(FIRST_LOCK_MS * 2 ** (failures - LOCK_AFTER), MAX_LOCK_MS);
}
```

Run `npx vitest run apps/api/test/lockout.test.ts`: it fails (no module), then passes once the file exists.

- [ ] **Step 1: Write the contract (the failing tests)**

`accessContract` takes a factory `(now: () => number) => Promise<AccessRepo>`, so the Memory adapter gets an injectable clock and Pg uses the real one (its clock-dependent cases are skipped with `it.skipIf(!clock)`).

```ts
// apps/api/test/access-contract.ts
import { describe, expect, it } from 'vitest';
import {
  ADMIN_LOGIN,
  DISABLE_AFTER,
  LOCK_AFTER,
  ONE_TIME_PASSWORD_DAYS,
  type AccessRepo,
} from '../src/access/repo.js';

const MIN = 60_000;

type Clock = { now: () => number; advance: (ms: number) => void };
export type MakeRepo = (clock?: Clock) => Promise<AccessRepo>;

const fakeClock = (): Clock => {
  let t = Date.parse('2026-10-15T09:00:00Z');
  return { now: () => t, advance: (ms) => (t += ms) };
};

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

  describe(`${name}: access contract`, () => {
    it('signs the admin in with the password from the log', async () => {
      const { repo, adminPassword } = await setup();
      const r = await signIn(repo, ADMIN_LOGIN, adminPassword);
      expect(r.session).toMatchObject({ role: 'admin', label: 'Admin', email: null, mustChangePassword: false });
    });

    it('rotating ends the old admin password and its sessions', async () => {
      const { repo, adminPassword } = await setup();
      const { sessionId } = await signIn(repo, ADMIN_LOGIN, adminPassword);
      const next = await repo.rotateAdminPassword();
      expect(next).not.toBe(adminPassword);
      expect((await repo.login(ADMIN_LOGIN, adminPassword)).kind).toBe('invalid');
      expect(await repo.session(sessionId)).toBeNull();
      expect((await repo.listUsers()).filter((u) => u.status === 'admin-from-log')).toHaveLength(1);
    });

    it('stores the email normalised and refuses duplicates by email and by name', async () => {
      const { repo, user } = await setup();
      expect(user.email).toBe('ken@example.com');
      expect(await repo.createUser({ ...ken, name: 'Other', email: 'KEN@example.com' }, null)).toBe('email_taken');
      expect(await repo.createUser({ ...ken, name: 'ken hayward', email: 'k2@example.com' }, null)).toBe('name_taken');
      expect(await repo.createUser({ ...ken, name: 'admin', email: 'k3@example.com' }, null)).toBe('name_taken');
    });

    it('a one-time password opens a restricted session until it is changed', async () => {
      const { repo, user, password } = await setup();
      expect(user.status).toBe('must-change');
      const first = await signIn(repo, ' KEN@example.com', password);
      expect(first.session.mustChangePassword).toBe(true);
      expect(await repo.changePassword(first.sessionId, password, 'short')).toEqual({ problem: 'passwords need at least 12 characters' });
      expect(await repo.changePassword(first.sessionId, password, 'my new long phrase')).toBe('ok');
      expect((await repo.session(first.sessionId))?.mustChangePassword).toBe(false);
      expect((await repo.login('ken@example.com', password)).kind).toBe('invalid');
      await signIn(repo, 'ken@example.com', 'my new long phrase');
    });

    it('changing the password ends the user\'s other sessions only', async () => {
      const { repo, password } = await setup();
      const a = await signIn(repo, 'ken@example.com', password);
      await repo.changePassword(a.sessionId, password, 'my new long phrase');
      const b = await signIn(repo, 'ken@example.com', 'my new long phrase');
      const c = await signIn(repo, 'ken@example.com', 'my new long phrase');
      expect(await repo.changePassword(b.sessionId, 'my new long phrase', 'another long phrase')).toBe('ok');
      expect(await repo.session(b.sessionId)).not.toBeNull();
      expect(await repo.session(c.sessionId)).toBeNull();
    });

    const fail = async (repo: AccessRepo, n: number) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(await repo.login('ken@example.com', 'wrong guess'));
      return out;
    };

    it(`the ${LOCK_AFTER}th failure in a row locks for 15 minutes, without checking passwords meanwhile`, async () => {
      const { repo, user, password } = await setup();
      const open = await signIn(repo, 'ken@example.com', password);
      const results = await fail(repo, LOCK_AFTER);
      expect(results.slice(0, 9).every((r) => r.kind === 'invalid' && r.locked === null)).toBe(true);
      const last = results[9]!;
      expect(last.kind === 'invalid' && last.failures).toBe(LOCK_AFTER);
      expect(last.kind === 'invalid' && typeof last.locked === 'object' && last.locked !== null).toBe(true);
      // the right password is refused too, and nothing more is counted
      expect((await repo.login('ken@example.com', password)).kind).toBe('locked');
      expect((await repo.login('ken@example.com', 'wrong guess')).kind).toBe('locked');
      expect((await repo.listUsers()).find((u) => u.id === user.id)).toMatchObject({ status: 'locked', failedSignIns: LOCK_AFTER });
      // a temporary lock keeps open sessions
      expect(await repo.session(open.sessionId)).not.toBeNull();
    });

    it.skipIf(!opts.clock)('each failure after a lock runs out doubles the next lock', async () => {
      const { repo, clock, password } = await setup();
      await fail(repo, LOCK_AFTER);
      clock!.advance(15 * MIN + 1);
      const [eleventh] = await fail(repo, 1);
      expect(eleventh).toMatchObject({ kind: 'invalid', failures: 11, locked: { until: new Date(clock!.now() + 30 * MIN).toISOString() } });
      clock!.advance(30 * MIN - 1);
      expect((await repo.login('ken@example.com', password)).kind).toBe('locked');
      clock!.advance(2);
      await signIn(repo, 'ken@example.com', password); // a success clears it all
      expect((await fail(repo, 1))[0]).toMatchObject({ failures: 1, locked: null });
    });

    it.skipIf(!opts.clock)(`the ${DISABLE_AFTER}th failure disables and ends sessions`, async () => {
      const { repo, clock, user, password } = await setup();
      const open = await signIn(repo, 'ken@example.com', password);
      await fail(repo, LOCK_AFTER);
      for (let n = LOCK_AFTER + 1; n <= DISABLE_AFTER; n++) {
        clock!.advance(24 * 60 * MIN + 1);
        // keep the session in use, so only the disable can end it (not the 7-day idle rule)
        expect(await repo.session(open.sessionId)).not.toBeNull();
        await fail(repo, 1);
      }
      expect(await repo.session(open.sessionId)).toBeNull();
      clock!.advance(24 * 60 * MIN + 1);
      expect(await repo.login('ken@example.com', password)).toEqual({ kind: 'disabled', userId: user.id });
      expect((await repo.listUsers()).find((u) => u.id === user.id)).toMatchObject({
        status: 'disabled', disabledReason: 'failed-sign-ins', disabledBy: null, failedSignIns: DISABLE_AFTER,
      });
    });

    it('a success resets the count and reports what it cleared (D9)', async () => {
      const { repo, password } = await setup();
      await fail(repo, LOCK_AFTER - 1);
      const r = await signIn(repo, 'ken@example.com', password);
      expect(r.failedSinceLastSignIn).toBe(LOCK_AFTER - 1);
      expect(r.lastFailedAt).not.toBeNull();
      await fail(repo, LOCK_AFTER - 1);
      expect((await signIn(repo, 'ken@example.com', password)).failedSinceLastSignIn).toBe(LOCK_AFTER - 1);
      expect((await signIn(repo, 'ken@example.com', password)).failedSinceLastSignIn).toBe(0);
    });

    it('never locks the admin from the log (D2)', async () => {
      const { repo, adminPassword } = await setup();
      for (let i = 0; i < DISABLE_AFTER + 5; i++) await repo.login(ADMIN_LOGIN, 'wrong');
      await signIn(repo, ADMIN_LOGIN, adminPassword);
    });

    it('an unknown login is invalid without a user', async () => {
      const { repo } = await setup();
      expect(await repo.login('nobody@example.com', 'x')).toEqual({ kind: 'invalid', userId: null, failures: null, locked: null });
    });

    it('disable ends sessions; enable clears a disable, a lock and the count', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      expect(await repo.setEnabled(user.id, false, 'Admin')).toMatchObject({ status: 'disabled', disabledReason: 'admin', disabledBy: 'Admin' });
      expect(await repo.session(s.sessionId)).toBeNull();
      expect(await repo.login('ken@example.com', password)).toEqual({ kind: 'disabled', userId: user.id });
      expect(await repo.setEnabled(user.id, true, 'Admin')).toMatchObject({ status: 'must-change', failedSignIns: 0, disabledAt: null });
      await fail(repo, LOCK_AFTER);
      expect(await repo.setEnabled(user.id, true, 'Admin')).toMatchObject({ status: 'must-change', failedSignIns: 0, lockedUntil: null });
      await signIn(repo, 'ken@example.com', password);
    });

    it.skipIf(!opts.clock)('sessions end 30 days after sign-in even when used daily (D10)', async () => {
      const { repo, clock, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      for (let day = 1; day < 30; day++) {
        clock!.advance(86_400_000);
        expect(await repo.session(s.sessionId)).not.toBeNull();
      }
      clock!.advance(86_400_000);
      expect(await repo.session(s.sessionId)).toBeNull();
    });

    it('records, lists and prunes sign-in events (D11)', async () => {
      const { repo, user } = await setup();
      await repo.recordSignIn({ userId: user.id, result: 'wrong-password', failures: 1, ip: '10.0.0.1', userAgent: 'Firefox' });
      await repo.recordSignIn({ userId: null, result: 'unknown-login', ip: '10.0.0.2', userAgent: null });
      const all = await repo.listSignIns({ limit: 50 });
      expect(all.map((e) => e.result)).toEqual(['unknown-login', 'wrong-password']);
      expect(all[1]).toMatchObject({ userId: user.id, name: 'Ken Hayward', failures: 1, ip: '10.0.0.1', userAgent: 'Firefox' });
      expect((await repo.listSignIns({ userId: user.id, limit: 50 })).map((e) => e.result)).toEqual(['wrong-password']);
      expect(await repo.listSignIns({ limit: 1 })).toHaveLength(1);
      expect(await repo.pruneSignIns(new Date('2000-01-01'))).toBe(0);
      expect(await repo.pruneSignIns(new Date('2100-01-01'))).toBe(2);
      expect(await repo.listSignIns({ limit: 50 })).toEqual([]);
    });

    it('reissue unlocks, ends sessions and replaces the password', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      await fail(repo, LOCK_AFTER);
      const re = await repo.reissuePassword(user.id);
      if (typeof re === 'string') throw new Error(re);
      expect(re.password).not.toBe(password);
      expect(re.user).toMatchObject({ status: 'must-change', failedSignIns: 0 });
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
      expect(await repo.changePassword(s.sessionId, adminPassword, 'a whole new phrase')).toBe('admin-from-log');
    });

    it('edits name, email and role; a role change applies to open sessions', async () => {
      const { repo, user, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      expect(await repo.updateUser(user.id, { role: 'admin', email: 'ken@new.example' })).toMatchObject({ role: 'admin', email: 'ken@new.example' });
      expect((await repo.session(s.sessionId))?.role).toBe('admin');
      expect(await repo.updateUser('00000000-0000-4000-8000-000000000000', { name: 'x' })).toBe('not_found');
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

    it.skipIf(!opts.clock)(`one-time passwords expire after ${ONE_TIME_PASSWORD_DAYS} days`, async () => {
      const { repo, clock, user, password } = await setup();
      clock!.advance(ONE_TIME_PASSWORD_DAYS * 86_400_000 + 1);
      expect(await repo.login('ken@example.com', password)).toEqual({ kind: 'expired', userId: user.id });
    });

    it.skipIf(!opts.clock)('sessions end after 7 idle days', async () => {
      const { repo, clock, password } = await setup();
      const s = await signIn(repo, 'ken@example.com', password);
      clock!.advance(7 * 86_400_000 + 1);
      expect(await repo.session(s.sessionId)).toBeNull();
    });
  });
}
```

```ts
// apps/api/test/access-repo.test.ts
import { MemoryAccessRepo } from '../src/access/repo.js';
import { accessContract } from './access-contract.js';

accessContract('memory', async (clock) => new MemoryAccessRepo(clock?.now), { clock: true });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run apps/api/test/access-repo.test.ts`
Expected: FAIL: `rotateAdminPassword is not a function` (and type errors on the new names).

- [ ] **Step 3: Implement `repo.ts`**

Replace the file with the interface block above plus `MemoryAccessRepo`. Points that must hold (the tests pin them):

```ts
interface UserRow {
  id: string; name: string; email: string | null; role: AccessRole; bootstrap: boolean;
  hash: string; mustChange: boolean; oneTimeExpiresAt: number | null;
  failed: number; lastFailedAt: number | null; lockedUntil: number | null;
  disabledAt: number | null; disabledReason: DisabledReason | null;
  disabledBy: string | null; createdAt: number; createdBy: string | null;
  lastSignInAt: number | null;
}
// sessions: Map<sha256(id), { userId: string; createdAt: number; lastSeen: number }>
// events: SignInEvent rows plus an insertion sequence, so equal times list newest-inserted first

private lockedNow(row: UserRow) {
  return row.lockedUntil !== null && row.lockedUntil > this.now();
}

/** One counted failure (login and changePassword share it). */
private countFailure(row: UserRow): Extract<LoginResult, { kind: 'invalid' }> {
  row.failed += 1;
  row.lastFailedAt = this.now();
  const next = lockFor(row.failed);
  if (next === 'disable') {
    this.disable(row, 'failed-sign-ins', null); // also ends every session
    return { kind: 'invalid', userId: row.id, failures: row.failed, locked: 'disabled' };
  }
  if (next !== null) {
    row.lockedUntil = this.now() + next;
    return { kind: 'invalid', userId: row.id, failures: row.failed, locked: { until: iso(row.lockedUntil)! } };
  }
  return { kind: 'invalid', userId: row.id, failures: row.failed, locked: null };
}

// login(): the order matters for timing and for what leaks.
async login(login: string, password: string): Promise<LoginResult> {
  const key = login.trim().toLowerCase();
  const row = [...this.users.values()].find((u) =>
    key === ADMIN_LOGIN ? u.bootstrap : u.email === key,
  );
  // A lock is checked before the password, which is then never verified (D3).
  if (row && !row.bootstrap && row.disabledAt === null && this.lockedNow(row)) {
    return { kind: 'locked', userId: row.id, until: iso(row.lockedUntil)! };
  }
  const ok = await verifyPassword(password, row?.hash ?? DUMMY_HASH);
  if (!row) return { kind: 'invalid', userId: null, failures: null, locked: null };
  // Check again after the await: a parallel guess may have locked it meanwhile (Pg does this under FOR UPDATE).
  if (!row.bootstrap && row.disabledAt === null && this.lockedNow(row)) {
    return { kind: 'locked', userId: row.id, until: iso(row.lockedUntil)! };
  }
  if (!ok) {
    if (row.bootstrap || row.disabledAt !== null) return { kind: 'invalid', userId: row.id, failures: null, locked: null };
    return this.countFailure(row);
  }
  if (row.disabledAt !== null) return { kind: 'disabled', userId: row.id };
  if (row.mustChange && row.oneTimeExpiresAt !== null && row.oneTimeExpiresAt <= this.now()) return { kind: 'expired', userId: row.id };
  const failedSinceLastSignIn = row.failed;
  const lastFailedAt = iso(row.lastFailedAt);
  row.failed = 0;
  row.lockedUntil = null;
  row.lastSignInAt = this.now();
  const sessionId = newSessionId();
  this.sessions.set(sha256(sessionId), { userId: row.id, createdAt: this.now(), lastSeen: this.now() });
  return { kind: 'ok', sessionId, session: this.info(row), failedSinceLastSignIn, lastFailedAt };
}
```

- `lastFailedAt` is kept after a success (the list shows it) but `failedSinceLastSignIn` is computed from the count, so a second success reports 0.
- `status`: `bootstrap` → `admin-from-log`; `disabledAt` → `disabled`; `lockedNow(row)` → `locked`; `mustChange` → `must-change`; else `active`. A lock that has run out reads as the status underneath, while `failedSignIns` still shows the count.
- `setEnabled(id, true)` and `reissuePassword` set `failed = 0`, `lockedUntil = null`, `disabledAt/Reason/By = null`.
- `session()` returns null when `lastSeen + SESSION_IDLE_MS < now` **or** `createdAt + SESSION_MAX_MS <= now`.
- Name uniqueness compares `name.trim().toLowerCase()` and includes the bootstrap row's `Admin`, so `admin` is reserved. Names are trimmed and 1 to 100 characters (the route checks the length).
- `rotateAdminPassword` uses `newToken()` from `tokens.ts` (the same `ih_…` format, so `admin-token.sh` and the log line don't change) and stores `await hashPassword(token)`.
- `createUser` / `reissuePassword`: `mustChange = true`, `oneTimeExpiresAt = now + ONE_TIME_PASSWORD_DAYS days`.
- `changePassword` returns `'locked'` while `lockedNow(row)` (no verify); a wrong `current` goes through `countFailure` and returns `'wrong'`. It checks `passwordProblem(next, { email, current })` *after* verifying `current`, then sets `mustChange = false`, `oneTimeExpiresAt = null`, and deletes every session of the user except `sha256(sessionId)`.
- `session()` re-reads the row on every call (role, name and must-change are live), returns null for a disabled user, and applies the idle and touch rules as today.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run apps/api/test/access-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/access/repo.ts apps/api/src/access/lockout.ts apps/api/test/lockout.test.ts apps/api/test/access-contract.ts apps/api/test/access-repo.test.ts
git commit -m "API: users replace access tokens in the access repo (memory adapter)"
```

(`npm run typecheck` fails until Task 4 rewrites the routes. That's expected; don't commit `--no-verify` if a hook runs it. Tasks 2 to 4 can land as one commit if the hook insists.)

---

### Task 3: Migration 0039 and `PgAccessRepo`

**Files:**
- Create: `db/migrations/0039_users.sql`
- Rewrite: `apps/api/src/access/pg.ts`
- Rewrite: `apps/api/test/integration/access-pg.test.ts`

**Interfaces:**
- Consumes: the `AccessRepo` contract (Task 2), `accessContract` (Task 2), Task 1.
- Produces: `new PgAccessRepo(pool: pg.Pool)`.

- [ ] **Step 1: Write the migration**

```sql
-- Email and password users replace access tokens (ADR 0013, superseding the token parts of ADR
-- 0006). Everyone signs in again: tokens cannot be mapped to people. The admin from the log
-- (bootstrap) signs in as "admin" with the password the API prints on every start.
DELETE FROM workbench_pins;   -- owners were access token ids; now user ids
DROP TABLE sessions;
DROP TABLE access_tokens;

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email                 text        CHECK (email = lower(btrim(email))),
  role                  text        NOT NULL CHECK (role IN ('admin', 'user')),
  bootstrap             boolean     NOT NULL DEFAULT false,
  password_hash         text        NOT NULL,
  must_change_password  boolean     NOT NULL DEFAULT true,
  one_time_expires_at   timestamptz,
  failed_sign_ins       integer     NOT NULL DEFAULT 0 CHECK (failed_sign_ins >= 0),
  last_failed_at        timestamptz,
  locked_until          timestamptz,
  disabled_at           timestamptz,
  disabled_reason       text        CHECK (disabled_reason IN ('admin', 'failed-sign-ins')),
  disabled_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  last_sign_in_at       timestamptz,
  password_changed_at   timestamptz,
  CONSTRAINT users_email_unless_bootstrap CHECK (bootstrap = (email IS NULL)),
  CONSTRAINT users_bootstrap_is_admin CHECK (NOT bootstrap OR role = 'admin'),
  CONSTRAINT users_disabled_has_reason CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_name_key ON users (lower(btrim(name)));
CREATE UNIQUE INDEX users_one_bootstrap ON users (bootstrap) WHERE bootstrap;

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Sign-in attempts and password changes (ADR 0013, D11), kept 90 days. user_id is null for a
-- login that matches nobody; what was typed is never stored.
CREATE TABLE sign_in_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      uuid        REFERENCES users (id) ON DELETE SET NULL,
  result       text        NOT NULL CHECK (result IN ('ok', 'wrong-password', 'unknown-login',
                 'locked', 'disabled', 'expired-one-time', 'password-changed',
                 'password-change-refused')),
  failures     integer,
  locked_until timestamptz,
  ip           text        NOT NULL,
  user_agent   text        CHECK (length(user_agent) <= 200)
);
CREATE INDEX sign_in_events_at_idx ON sign_in_events (at DESC, id DESC);
CREATE INDEX sign_in_events_user_idx ON sign_in_events (user_id, at DESC);

COMMENT ON TABLE users IS 'People who sign in (ADR 0013). Hashes are scrypt; the plaintext one-time password is shown once.';
```

Also update the `workbench_pins` comment in a `COMMENT ON COLUMN workbench_pins.owner IS 'user id, or ''local'' without access control'`.

- [ ] **Step 2: Rewrite the integration test (failing)**

```ts
// apps/api/test/integration/access-pg.test.ts
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgAccessRepo } from '../../src/access/pg.js';
import { LOCK_AFTER } from '../../src/access/repo.js';
import { accessContract } from '../access-contract.js';
import { migratedPool } from './pg-helpers.js'; // existing helper the other *-pg tests use; reuse its name

const url = process.env.IH_TEST_DATABASE_URL;
describe.skipIf(!url)('PgAccessRepo', () => {
  let pool: pg.Pool;
  const make = async () => {
    pool ??= await migratedPool(url!);
    await pool.query('TRUNCATE users CASCADE');
    return new PgAccessRepo(pool);
  };
  afterAll(() => pool?.end());

  accessContract('pg', make, { clock: false });

  it('parallel wrong guesses count to exactly 10, lock once, and a parallel right one gets nothing', async () => {
    const repo = await make();
    await repo.rotateAdminPassword();
    const created = await repo.createUser({ name: 'P', email: 'p@example.com', role: 'user' }, null);
    if (typeof created === 'string') throw new Error(created);
    const tries = await Promise.all([
      ...Array.from({ length: LOCK_AFTER + 5 }, () => repo.login('p@example.com', 'wrong')),
    ]);
    const locks = tries.filter((r) => r.kind === 'invalid' && r.locked !== null);
    expect(locks).toHaveLength(1);
    expect(tries.filter((r) => r.kind === 'invalid' && r.failures !== null)).toHaveLength(LOCK_AFTER);
    expect((await repo.listUsers()).find((u) => u.email === 'p@example.com')?.failedSignIns).toBe(LOCK_AFTER);
    expect((await repo.login('p@example.com', created.password)).kind).toBe('locked');
  });

  it('a right password racing the 10th wrong one never opens a session after the lock', async () => {
    const repo = await make();
    await repo.rotateAdminPassword();
    const created = await repo.createUser({ name: 'Q', email: 'q@example.com', role: 'user' }, null);
    if (typeof created === 'string') throw new Error(created);
    for (let i = 0; i < LOCK_AFTER - 1; i++) await repo.login('q@example.com', 'wrong');
    const [wrong, right] = await Promise.all([
      repo.login('q@example.com', 'wrong'),
      repo.login('q@example.com', created.password),
    ]);
    // Either the right one won (count reset, the wrong one counted 1) or the lock won (refused).
    if (right.kind === 'ok') expect(wrong).toMatchObject({ kind: 'invalid', locked: null });
    else expect(right.kind).toBe('locked');
  });
});
```

(If the existing access-pg test sets up its pool differently, copy that set-up verbatim instead of `migratedPool`. Check the top of the current file before replacing it.)

Run: `docker run --rm -d --name ih-test-pg-users -e POSTGRES_PASSWORD=test -p 55444:5432 ih-postgres:pgvector`, then
`IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55444/postgres npx vitest run --config apps/api/vitest.integration.config.ts access-pg`
Expected: FAIL (the old `PgAccessRepo` has no `rotateAdminPassword`).

- [ ] **Step 3: Implement `PgAccessRepo`**

The same rules as Memory. The SQL that matters:

The lock schedule is computed in TypeScript (`lockFor`, Task 2), never duplicated in SQL. A failure is two statements in one transaction: lock the row, then write what `lockFor` says. The `FOR UPDATE` serialises parallel guesses on one account, and the lock check repeats under it, so a guess that lost the race is refused rather than counted.

```ts
// login(): read without a lock first, to refuse a locked account without verifying.
const FIND = `SELECT id, bootstrap, password_hash, must_change_password, one_time_expires_at,
                     disabled_at, locked_until, locked_until > now() AS locked
                FROM users WHERE ${byLogin}`; // byLogin: bootstrap for 'admin', else email = $1

// A wrong password (inside BEGIN … COMMIT):
const LOCK_ROW = `SELECT failed_sign_ins, locked_until > now() AS locked, disabled_at IS NOT NULL AS disabled
                    FROM users WHERE id = $1 AND NOT bootstrap FOR UPDATE`;
// locked or disabled now -> ROLLBACK and answer { kind: 'locked' } / invalid without counting.
// else n = failed_sign_ins + 1, next = lockFor(n):
const COUNT = `UPDATE users SET
                 failed_sign_ins = $2,
                 last_failed_at  = now(),
                 locked_until    = CASE WHEN $3::bigint IS NULL THEN locked_until
                                        ELSE now() + make_interval(secs => $3::bigint / 1000.0) END,
                 disabled_at     = CASE WHEN $4 THEN now() ELSE disabled_at END,
                 disabled_reason = CASE WHEN $4 THEN 'failed-sign-ins' ELSE disabled_reason END
               WHERE id = $1
               RETURNING locked_until`;
// params: [id, n, typeof next === 'number' ? next : null, next === 'disable']
// when next === 'disable': DELETE FROM sessions WHERE user_id = $1 (same transaction)

// A right password (inside BEGIN … COMMIT): the same LOCK_ROW first. If it is locked or disabled
// now (a parallel wrong guess won), ROLLBACK and answer 'locked' / 'disabled'. Otherwise keep
// failed_sign_ins and last_failed_at from LOCK_ROW for D9, then:
const SUCCESS = `UPDATE users SET failed_sign_ins = 0, locked_until = NULL, last_sign_in_at = now()
                  WHERE id = $1`;
// and INSERT INTO sessions (id_hash, user_id) in the same transaction.

const SESSION = `
  SELECT u.id, u.role, u.name, u.email, u.must_change_password, s.last_seen_at
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.id_hash = $1 AND u.disabled_at IS NULL
     AND s.last_seen_at > now() - interval '7 days'
     AND s.created_at   > now() - interval '30 days'`;

const SIGN_INS = `
  SELECT e.id::text, e.at, e.user_id, u.name, e.result, e.failures, e.locked_until, e.ip, e.user_agent
    FROM sign_in_events e LEFT JOIN users u ON u.id = e.user_id
   WHERE ($1::uuid IS NULL OR e.user_id = $1)
   ORDER BY e.at DESC, e.id DESC
   LIMIT $2`;
```

- `changePassword` uses the same `LOCK_ROW` / `COUNT` path for a wrong current password.
- `recordSignIn` truncates `userAgent` to 200 characters before the insert.

- Unique violations (`23505`) map to `email_taken` / `name_taken` by `constraint` name (`users_email_key` / `users_name_key`).
- `rotateAdminPassword`: in one transaction, `UPDATE users SET password_hash=$1, failed_sign_ins=0 WHERE bootstrap RETURNING id`, else `INSERT (name, email, role, bootstrap, password_hash, must_change_password) VALUES ('Admin', NULL, 'admin', true, $1, false)`, then `DELETE FROM sessions WHERE user_id = <id>`.
- A non-UUID id in `updateUser`/`setEnabled`/`reissuePassword` is `not_found` (check with a UUID regex before the query, as `change()` in today's routes does).
- `status` is computed in SQL with a `CASE` like today's `STATUS`.

- [ ] **Step 4: Run it and see it pass**

Run the command from Step 2. Expected: PASS, including the concurrency test.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0039_users.sql apps/api/src/access/pg.ts apps/api/test/integration/access-pg.test.ts
git commit -m "API: users table (migration 0039) and PgAccessRepo with atomic lockout"
```

---

### Task 4: Routes: sign-in, the password change, restricted sessions, user admin

**Files:**
- Rewrite: `apps/api/src/access/routes.ts` (login, logout, me, password, hook)
- Create: `apps/api/src/access/users-routes.ts` (`registerUserRoutes(app, access)`, called from `registerAccess`)
- Modify: `apps/api/src/routes/workbench-pins.ts:11` → `req.auth?.userId ?? 'local'`
- Modify: `apps/api/src/server.ts:120-125` → the sign-in event pruning timer (see *Events* below), and `await access.rotateAdminPassword()`; keep the stdout line `ADMIN TOKEN (valid until the next restart): ${adminPassword}` **exactly** (scripts match it). Add a second line: `Sign in as "admin" with that token as the password.`
- Modify: `apps/api/src/openapi/document.ts` → replace the `'Access tokens'` tag with `'Users'` (description: *Admins register people with a name, an email address and a one-time password…*), and in the tag group list.
- Rewrite: `apps/api/test/access.test.ts`
- Grep and fix: `grep -rn "tokenId\|createToken\|listTokens\|AccessTokenSchema" apps/api` must return nothing outside history.

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces the HTTP API (Task 5 builds the web client on it):

| Method + path | Who | Body | Answers |
| --- | --- | --- | --- |
| `POST /api/auth/login` (public) | anyone | `{ login: string(1..254), password: string(1..200) }` | 200 `SignedIn` + cookie · 401 `invalid email or password` · 403 `this account is disabled: ask an admin` · 403 `this one-time password has expired: ask an admin for a new one` · 429 `too many failed sign-ins for this account: try again after <ISO time>` (with `lockedUntil` in the body) · 429 by IP as today |
| `POST /api/auth/logout` (public) | anyone | none | 204 as today |
| `GET /api/auth/me` | any session, restricted included | none | 200 `Me` |
| `PUT /api/auth/password` | any session, restricted included | `{ currentPassword, newPassword }` | 204 · 400 `{problem}` · 400 `the current password is wrong` · 409 `the admin password rotates on restart and cannot be changed` |
| `GET /api/users` | admin | none | 200 `User[]`: the admin from the log first, then by name |
| `POST /api/users` | admin | `{ name: 1..100 trimmed, email: z.string().email().max(254), role: 'admin'\|'user' = 'user' }` | 201 `{ user, password }` · 400 · 409 `a user with this email already exists` / `a user with this name already exists` |
| `PATCH /api/users/:id` | admin | any of `{ name, email, role }` (at least one) | 200 `User` · 404 · 409 (taken, `the admin from the log cannot be changed`, `you cannot remove your own admin role`) |
| `POST /api/users/:id/disable` | admin | none | 200 `User` · 404 · 409 (`…admin from the log…`, `you cannot disable yourself`) |
| `POST /api/users/:id/enable` | admin | none | 200 `User` · 404 · 409 |
| `POST /api/users/:id/one-time-password` | admin | none | 200 `{ user, password }` · 404 · 409 |
| `GET /api/sign-ins` | admin | query `userId?` (uuid), `limit?` (1-200, default 50) | 200 `SignInEvent[]`, newest first · 400 |

`PUT /api/auth/password` also answers 429 `too many failed sign-ins for this account: try again after <time>` while the account is locked.

`Me` = `{ role, label, email: string | null, mustChangePassword: boolean }` (`expiresAt` is gone). `SignedIn` = `Me & { failedSinceLastSignIn: number, lastFailedAt: string | null }` (D9; only the login response carries them).

**Events written by the routes (D11).** The route records them because it knows the IP and the user agent; a failed write is logged at warn and never changes the answer.

| Outcome | `result` | `failures` / `lockedUntil` |
| --- | --- | --- |
| login `ok` | `ok` | `failedSinceLastSignIn` |
| login `invalid`, `userId` null | `unknown-login` | none |
| login `invalid` with a user | `wrong-password` | the count after it; `lockedUntil` when this failure locked |
| login `locked` | `locked` | `lockedUntil` |
| login `disabled` | `disabled` | none |
| login `expired` | `expired-one-time` | none |
| password changed | `password-changed` | none |
| password change: wrong current, or locked | `password-change-refused` | the count, `lockedUntil` |
| per-IP 429, body not valid | not recorded (logged only) | |

Pruning: `server.ts` calls `access.pruneSignIns(new Date(Date.now() - SIGN_IN_RETENTION_DAYS * 86_400_000))` once after the API starts listening and then every hour (`setInterval(...).unref()`), logging the count at debug and an error at warn.

- [ ] **Step 1: Write the failing route tests**

Rewrite `access.test.ts`. Keep the existing tests that still apply: the 401 gate, the cross-site guard, the cookie attributes (`cookieSite`, framed and not), logout, and the per-IP 429 tests, with `login()` changed to send `{ login, password }`. Add:

```ts
async function setup() {
  const access = new MemoryAccessRepo();
  const ctx = await testApp({ access });
  const adminPassword = await access.rotateAdminPassword();
  return { ...ctx, access, adminPassword };
}
async function login(app: FastifyInstance, loginName: string, password: string, headers = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: loginName, password }, headers });
  return { res, cookie: `ih_session=${cookieOf(res).value}` };
}
async function addUser(app: FastifyInstance, admin: string, body: object) {
  const res = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: body });
  expect(res.statusCode).toBe(201);
  return res.json() as { user: { id: string }; password: string };
}

it('the admin signs in as "admin" with the password from the log', async () => {
  const { app, adminPassword } = await setup();
  const { res } = await login(app, 'admin', adminPassword);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ role: 'admin', label: 'Admin', email: null, mustChangePassword: false });
});

it('answers the same 401 for an unknown email and a wrong password', async () => {
  const { app, adminPassword } = await setup();
  const { cookie } = await login(app, 'admin', adminPassword);
  await addUser(app, cookie, { name: 'Ken', email: 'ken@example.com' });
  const a = await login(app, 'nobody@example.com', 'whatever');
  const b = await login(app, 'ken@example.com', 'whatever');
  expect([a.res.statusCode, b.res.statusCode]).toEqual([401, 401]);
  expect(a.res.json()).toEqual(b.res.json());
  expect(a.res.json()).toEqual({ error: 'invalid email or password' });
});

it('a one-time-password session can only read me, change the password and sign out', async () => {
  const { app, adminPassword } = await setup();
  const admin = (await login(app, 'admin', adminPassword)).cookie;
  const { password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
  const { res, cookie } = await login(app, 'ken@example.com', password);
  expect(res.json().mustChangePassword).toBe(true);
  expect((await app.inject({ url: '/api/specs', headers: { cookie } })).json()).toEqual({ error: 'change your one-time password first' });
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
  const changed = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie }, payload: { currentPassword: password, newPassword: 'a long new phrase' } });
  expect(changed.statusCode).toBe(204);
  expect((await app.inject({ url: '/api/specs', headers: { cookie } })).statusCode).toBe(200);
});

it('a restricted session is refused by every other /api route', async () => {
  // Same sweep as 'guards every /api route…', with a restricted cookie: every route except
  // GET /api/auth/me, PUT /api/auth/password and the public ones answers 403 with
  // 'change your one-time password first'.
});

it('locks after 10 wrong passwords: 429 with the time, logged and recorded', async () => {
  const { app, adminPassword, logs } = await setup(); // capture warn logs the way the existing 'admin token issued' test does
  const admin = (await login(app, 'admin', adminPassword)).cookie;
  const { user, password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
  // Use distinct X-Forwarded-For addresses from a private range so the per-IP limiter does not answer 429 first.
  for (let i = 0; i < 10; i++) await login(app, 'ken@example.com', 'wrong', { 'x-forwarded-for': `10.0.0.${i + 1}`, 'user-agent': 'Guesser/1.0' });
  const r = await login(app, 'ken@example.com', password, { 'x-forwarded-for': '10.0.1.1' });
  expect(r.res.statusCode).toBe(429);
  const body = r.res.json();
  expect(body.error).toMatch(/^too many failed sign-ins for this account: try again after \d{4}-/);
  expect(Date.parse(body.lockedUntil)).toBeGreaterThan(Date.now() + 14 * 60_000);
  // a warn log 'user locked' with { userId, failures: 10, lockedUntil }, never the email or password
  const events = (await app.inject({ url: `/api/sign-ins?userId=${user.id}`, headers: { cookie: admin } })).json();
  expect(events[0]).toMatchObject({ result: 'locked', ip: '10.0.1.1' });
  expect(events[1]).toMatchObject({ result: 'wrong-password', failures: 10, userAgent: 'Guesser/1.0', ip: '10.0.0.10' });
  expect(events).toHaveLength(11);
});

it('records unknown logins without what was typed', async () => {
  const { app, adminPassword, access } = await setup();
  const admin = (await login(app, 'admin', adminPassword)).cookie;
  await login(app, 'someone@example.com', 'hunter2hunter2');
  const [e] = (await app.inject({ url: '/api/sign-ins?limit=1', headers: { cookie: admin } })).json();
  expect(e).toMatchObject({ result: 'unknown-login', userId: null, name: null });
  expect(JSON.stringify(e)).not.toMatch(/someone|hunter2/);
});

it('a sign-in after failures says how many (D9)', async () => {
  const { app, adminPassword } = await setup();
  const admin = (await login(app, 'admin', adminPassword)).cookie;
  const { password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
  for (let i = 0; i < 3; i++) await login(app, 'ken@example.com', 'wrong', { 'x-forwarded-for': `10.0.2.${i + 1}` });
  const r = await login(app, 'ken@example.com', password, { 'x-forwarded-for': '10.0.3.1' });
  expect(r.res.json()).toMatchObject({ failedSinceLastSignIn: 3, lastFailedAt: expect.any(String) });
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: r.cookie } })).json()).not.toHaveProperty('failedSinceLastSignIn');
});

it('the session cookie lasts 30 days (D10)', async () => {
  const { app, adminPassword } = await setup();
  const { res } = await login(app, 'admin', adminPassword);
  expect(cookieOf(res).header).toMatch(/Max-Age=2592000/);
});

it('users get 403 on /api/sign-ins; a bad limit is 400', async () => { /* user cookie → 403; admin ?limit=0 → 400 */ });

it('a failing event write does not fail the sign-in', async () => {
  // access.recordSignIn = vi.fn().mockRejectedValue(new Error('db down')) → login still 200, a warn log 'sign-in event not recorded'
});

it('a password-change attempt while locked is 429 and recorded as refused', async () => {});
});

it('admins cannot disable or demote themselves', async () => {
  const { app, adminPassword } = await setup();
  const root = (await login(app, 'admin', adminPassword)).cookie;
  const { user, password } = await addUser(app, root, { name: 'Ann', email: 'ann@example.com', role: 'admin' });
  const first = (await login(app, 'ann@example.com', password)).cookie;
  await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: first }, payload: { currentPassword: password, newPassword: 'anns long phrase' } });
  const ann = first; // still valid: the change kept the current session
  expect((await app.inject({ method: 'POST', url: `/api/users/${user.id}/disable`, headers: { cookie: ann } })).json()).toEqual({ error: 'you cannot disable yourself' });
  expect((await app.inject({ method: 'PATCH', url: `/api/users/${user.id}`, headers: { cookie: ann }, payload: { role: 'user' } })).json()).toEqual({ error: 'you cannot remove your own admin role' });
});

it('users get 403 on /api/users', async () => { /* as today's 'users can't list tokens' */ });
it('the token routes are gone', async () => {
  const { app, adminPassword } = await setup();
  const { cookie } = await login(app, 'admin', adminPassword);
  expect((await app.inject({ url: '/api/auth/tokens', headers: { cookie } })).statusCode).toBe(404);
});
it('pins belong to the user, across sessions', async () => { /* pin with one session, list with another session of the same user */ });
```

Write the restricted sweep in full by copying the existing sweep's loop and changing only the cookie and the expected body. Update the public-route set assertion only if it named the token routes.

Run: `npx vitest run --project api apps/api/test/access.test.ts`
Expected: FAIL (the routes don't exist yet).

- [ ] **Step 2: Implement the hook change**

In the `onRequest` hook, after `req.auth = session`:

```ts
/** What a session opened with a one-time password may call (ADR 0013). */
const WHILE_CHANGING = new Set(['GET /api/auth/me', 'PUT /api/auth/password']);
// ...
if (session.mustChangePassword && !WHILE_CHANGING.has(`${req.method} ${route}`)) {
  return reply.code(403).send({ error: 'change your one-time password first' });
}
```

- [ ] **Step 3: Implement login, me and password**

```ts
async (req, reply) => {
  if (!limiter.allowed(req.ip)) return reply.code(429).send({ error: 'too many attempts, try again later' });
  const body = LoginBody.safeParse(req.body ?? {});
  if (!body.success) {
    limiter.fail(req.ip);
    return reply.code(401).send({ error: 'invalid email or password' }); // not recorded: nothing to attribute
  }
  const result = await access.login(body.data.login, body.data.password);
  const ua = req.headers['user-agent']?.slice(0, 200) ?? null;
  const record = (e: Omit<NewSignInEvent, 'ip' | 'userAgent'>) =>
    access.recordSignIn({ ...e, ip: req.ip, userAgent: ua }).catch((err: unknown) =>
      req.log.warn({ err }, 'sign-in event not recorded'),
    );
  switch (result.kind) {
    case 'invalid': {
      limiter.fail(req.ip);
      const lockedUntil = typeof result.locked === 'object' && result.locked ? result.locked.until : null;
      await record({
        userId: result.userId,
        result: result.userId ? 'wrong-password' : 'unknown-login',
        failures: result.failures,
        lockedUntil,
      });
      req.log.warn({ ip: req.ip, userId: result.userId }, 'failed sign-in');
      if (lockedUntil) req.log.warn({ userId: result.userId, failures: result.failures, lockedUntil }, 'user locked');
      if (result.locked === 'disabled') req.log.warn({ userId: result.userId, failures: result.failures }, 'user disabled after failed sign-ins');
      if (limiter.surge()) req.log.warn('many failed sign-ins from many clients (scan?)');
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    case 'locked':
      // Not limiter.fail: the password was not checked, so this is not a guess.
      await record({ userId: result.userId, result: 'locked', lockedUntil: result.until });
      return reply.code(429).send({
        error: `too many failed sign-ins for this account: try again after ${result.until}`,
        lockedUntil: result.until,
      });
    case 'disabled':
      await record({ userId: result.userId, result: 'disabled' });
      return reply.code(403).send({ error: 'this account is disabled: ask an admin' });
    case 'expired':
      await record({ userId: result.userId, result: 'expired-one-time' });
      return reply.code(403).send({ error: 'this one-time password has expired: ask an admin for a new one' });
    case 'ok':
      await record({ userId: result.session.userId, result: 'ok', failures: result.failedSinceLastSignIn });
      setSession(req, reply, result.sessionId);
      return {
        ...meView(result.session),
        failedSinceLastSignIn: result.failedSinceLastSignIn,
        lastFailedAt: result.lastFailedAt,
      };
  }
}
```

`setSession` drops its `expiresAt` parameter and always sets `maxAge: SESSION_MAX_MS / 1000` (30 days, D10); `MAX_COOKIE_AGE_S` goes. The web shows the web client's `lockedUntil` as a local time (the error text keeps the ISO time for API callers). `PUT /api/auth/password` calls `access.changePassword(cookie, …)`: `'wrong'` → `limiter.fail(req.ip)`, record `password-change-refused` with the count, 400 `the current password is wrong`; `'locked'` → record `password-change-refused`, 429 as for login; `{ problem }` → 400 `{ error: problem }` (not recorded: the current password was right); `'admin-from-log'` → 409; `'ok'` → record `password-changed`, 204 and `req.log.info({ userId }, 'password changed')`. Document every route (tags `Auth & sessions` / `Users`, summaries, `md` descriptions stating the lockout and the restricted session, `'x-admin': true` on `/api/users*`).

- [ ] **Step 4: Implement `users-routes.ts`**

Each handler: parse with Zod (400 `name (1-100 chars) and a valid email are required` on failure), call the repo, and map problems:

```ts
const PROBLEM: Record<UserProblem, [number, string]> = {
  not_found: [404, 'not found'],
  'admin-from-log': [409, 'the admin from the log cannot be changed: it rotates on every API start'],
  email_taken: [409, 'a user with this email already exists'],
  name_taken: [409, 'a user with this name already exists'],
};
```

Self-protection lives in the route, not the repo: `req.params.id === req.auth!.userId` with `disable` → 409 `you cannot disable yourself`; with `PATCH` and `role: 'user'` → 409 `you cannot remove your own admin role`. Logs: `user added` (`{ userId, role, by }`), `user disabled` / `user enabled` / `one-time password reissued` / `user changed` (`{ userId, fields, by }`), at warn level for `role: 'admin'` adds and promotions, otherwise info. Never log an email address or a password.

`GET /api/sign-ins` parses `userId` (uuid) and `limit` (int 1-200, default 50) with Zod (400 `limit is 1-200 and userId a user id`) and returns `access.listSignIns(...)`. Its description says what is kept (D11), for how long, and that typed logins are never stored.

- [ ] **Step 5: Run the API project, then the docs checks**

Run: `npx vitest run --project api`
Expected: PASS, including `openapi.test.ts` (every route documented, `x-admin` matches what a user session gets) and the conformance checks.

- [ ] **Step 6: Commit**

```bash
git add apps/api db/migrations
git commit -m "API: email and password sign-in, one-time password change, user admin routes; token routes removed"
```

---

### Task 5: Web: sign-in and the first-sign-in password change

**Files:**
- Modify: `apps/web/src/api/client.ts` (`Me`; `SignedIn = Me & { failedSinceLastSignIn: number; lastFailedAt: string | null }`; `login(login, password): Promise<SignedIn>`; `changePassword(current, next)`; remove `AccessToken`, `listTokens`, `createToken`, `revokeToken`, `deleteToken`; add the `User` and `SignInEvent` types and `listUsers`, `addUser`, `updateUser`, `setUserEnabled`, `reissuePassword`, `listSignIns({ userId?, limit? })`; `ApiError` keeps the body, so a 429's `lockedUntil` is readable; keep `SIGN_IN_CALLS` = `['/auth/login', '/auth/me']`)
- Create: `apps/web/src/access/FailedSignInsNotice.tsx` (D9)
- Modify: `apps/web/test/fake-api.ts` (in-memory users, plus `fakeApi({ me: { mustChangePassword: true } })`)
- Modify: `apps/web/src/access/SignIn.tsx`
- Create: `apps/web/src/access/ChangePassword.tsx`
- Modify: `apps/web/src/App.tsx` (render `ChangePassword` instead of the shell while `me.mustChangePassword`)
- Test: `apps/web/test/sign-in.test.tsx` (extend the existing SignIn test file if there is one: `grep -rl "SignIn" apps/web/test`), `apps/web/test/change-password.test.tsx`, `apps/web/test/client.test.ts`

**Interfaces:**
- Consumes: the Task 4 HTTP API.
- Produces: `ChangePassword({ api, me, mode: 'first' | 'account', onDone })`. Task 7 reuses it with `mode: 'account'`.

- [ ] **Step 1: Failing tests**

```tsx
it('signs in with an email address and a password', async () => {
  const api = fakeApi();
  const onSignedIn = vi.fn();
  render(<SignIn api={api} onSignedIn={onSignedIn} />);
  await user.type(screen.getByLabelText('Email address'), 'ken@example.com');
  await user.type(screen.getByLabelText('Password'), 'a long phrase here');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(api.login).toHaveBeenCalledWith('ken@example.com', 'a long phrase here');
});

it('shows the server refusal', async () => {
  const api = fakeApi({ login: vi.fn().mockRejectedValue(new ApiError(401, 'invalid email or password')) });
  // … the alert reads 'invalid email or password'
});

it('first sign-in: new password twice, then into the app', async () => {
  const api = fakeApi();
  const onDone = vi.fn();
  render(<ChangePassword api={api} me={{ role: 'user', label: 'Ken', email: 'ken@example.com', mustChangePassword: true }} mode="first" onDone={onDone} />);
  expect(screen.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await user.type(screen.getByLabelText('One-time password'), 'abcd-efgh-jkmn-pqrs');
  await user.type(screen.getByLabelText('New password'), 'my long new phrase');
  await user.type(screen.getByLabelText('Repeat the new password'), 'my long new phrase!');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(screen.getByRole('alert')).toHaveTextContent('the two passwords differ');
  expect(api.changePassword).not.toHaveBeenCalled();
  // fix the repeat, submit: changePassword('abcd-efgh-jkmn-pqrs', 'my long new phrase'), then onDone()
});

it('a locked account reads the time it unlocks, in local time', async () => {
  const until = '2026-10-15T10:42:00.000Z';
  const api = fakeApi({ login: vi.fn().mockRejectedValue(new ApiError(429, `too many failed sign-ins for this account: try again after ${until}`, { lockedUntil: until })) });
  // … the alert reads 'Too many failed sign-ins for this account. Try again after ' + new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + '.'
});

it('after failed attempts, says how many once (D9)', async () => {
  const onDismiss = vi.fn();
  render(<FailedSignInsNotice count={3} lastFailedAt="2026-10-15T10:42:00.000Z" onDismiss={onDismiss} />);
  expect(screen.getByRole('status')).toHaveTextContent(/3 failed sign-ins since your last visit, the last one .*If that wasn't you, tell an admin\./);
  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalled();
});

it('shows no notice after a clean sign-in', async () => { /* App with login resolving failedSinceLastSignIn: 0 → no status 'failed sign-ins' */ });
it('says how long a password must be before sending', async () => { /* 11 chars → 'at least 12 characters', no call */ });
it('App shows the password change instead of the app while mustChangePassword', async () => { /* render App with a fake me; no nav */ });
```

`client.test.ts`: pin that `login` posts `{ login, password }` and that `changePassword` sends `PUT /api/auth/password` with `{ currentPassword, newPassword }`.

Run: `npx vitest run --project web apps/web/test/sign-in.test.tsx apps/web/test/change-password.test.tsx apps/web/test/client.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

- SignIn: fields *Email address* (`type="text"`, `autoComplete="username"`, `inputMode="email"`, hint below: *Admins: sign in as* `admin` *with the token from the API log*) and *Password* (`type="password"`, `autoComplete="current-password"`, with a show/hide toggle button labelled *Show password*). Keep the existing layout, brand mark and 429 message.
- ChangePassword: *One-time password* (first) or *Current password* (account), *New password*, *Repeat the new password* (both `autoComplete="new-password"`). The client checks length (12 to 200) and that the two match; the server is the authority (its 400 shows in the alert). The hint states the rules from D8. *Sign out* is a secondary button. On success: `onDone()`, and App re-reads `me`.
- A 403 `change your one-time password first` from any call (only possible if the gate were bypassed) is handled like the 401 listener: App re-reads `me`.
- `SignIn`'s `onSignedIn(me, failed)` passes `{ count, lastFailedAt }` when `failedSinceLastSignIn > 0`. App keeps it in state (never in storage: a reload drops it, which is fine, since the server reset the count) and renders `FailedSignInsNotice` at the top of the shell, or above the password change at first sign-in. The text is singular for 1 (*1 failed sign-in since your last visit…*), and the time is `relativeTime` from `jobs/derive.ts`. It's `role="status"` with the warn tone.
- A 429 with `lockedUntil` reads *Too many failed sign-ins for this account. Try again after HH:MM.* (*after DD MMM, HH:MM* when it isn't today). A 429 without it keeps today's per-IP message.
- Remove `Me.expiresAt` uses (only `AccessPage` read it; check with `grep -rn "expiresAt" apps/web/src/access apps/web/src/shell`).

- [ ] **Step 3: Run the web project**

Run: `npx vitest run --project web`
Expected: PASS, except the Access page tests (Task 6 rewrites them). If they block the commit, skip ahead to Task 6 and commit 5 and 6 together.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "Web: sign in with email and password; choose a password at first sign-in"
```

---

### Task 6: Web: the Access page lists users

**Files:**
- Rewrite: `apps/web/src/access/AccessPage.tsx` (Users section; `S3KeysSection` below, untouched)
- Create: `apps/web/src/access/UserDialog.tsx` (add and edit; on `Dialog`, `dialog-rich` layout like the New project dialog)
- Create: `apps/web/src/access/SignInsPanel.tsx` (D11)
- Rewrite: `apps/web/src/access/derive.ts` (`userStatusView(user, now)`, `userCounts(users, now)`, `userMatches(user, query)`, `signInResultView(event)`, `deviceName(userAgent)`)
- Modify: `apps/web/src/ui/Icon.tsx` (add `pencil`, `user-off`, `user-check`, `unlock`, `key` and `history` if missing; same 24×24 stroke style)
- Test: `apps/web/test/access-page.test.tsx` (rewrite), `apps/web/test/access-derive.test.ts` (rewrite, table-driven), `apps/web/test/sign-ins-panel.test.tsx`

**Interfaces:**
- Consumes: `Api.listUsers(): Promise<User[]>`, `addUser({name,email,role}): Promise<{user,password}>`, `updateUser(id, patch): Promise<User>`, `setUserEnabled(id, enabled): Promise<User>`, `reissuePassword(id): Promise<{user,password}>`, `listSignIns({ userId?, limit? }): Promise<SignInEvent[]>`.

**Layout:**
- Header *Users* with an *Add user* button. Filter chips *All · Active · Must change password · Locked · Disabled*. The top-bar search matches name or email.
- One row per user: initials avatar, **name**, email (or *Signs in as* `admin` for the admin from the log), a role tag (*Admin* / *User*), a status tag, and *Last signed in 3 days ago* / *Never signed in*. Status tags:
  - *Active* (ok)
  - *Must change password* (info), with *one-time password expires in N days* or *one-time password expired*
  - *Locked until 11:12* (warn), with *10 failed sign-ins*
  - *Disabled* (neutral), with *by Ann, 2 days ago*
  - *Disabled: 20 failed sign-ins* (danger), with the time
  - *Admin from the log* (info)
  - An active or must-change row whose `failedSignIns > 0` adds a small *3 failed sign-ins* note (warn text), so guessing shows before it locks.
- Icon buttons at the end of the row, each an `IconButton` with an `aria-label` and a matching `title`:
  - **Edit** (`pencil`) opens `UserDialog` in edit mode (name, email, role).
  - **Disable** (`user-off`) / **Enable** (`user-check`), a toggle. Disable asks first (*Disable Ken? They are signed out at once.*). For a temporarily locked user it's **Unlock** (`unlock`, no confirm: *Unlock Ken: they can sign in again now*), and Disable stays available beside it.
  - **Reissue one-time password** (`key`) asks first (*Ken's current password stops working and they are signed out.*), then shows the password once.
  - **Sign-in history** (`history`) filters the *Recent sign-ins* panel to this user and scrolls to it.
  - The admin from the log has only *Sign-in history*. Your own row has Disable and the role field disabled, with the reason as `title`.
- **Recent sign-ins** (`SignInsPanel`, below Users, above S3 keys): `listSignIns({ userId, limit: 50 })`, refreshed with the users list after each action and by a *Refresh* button. It has a table with columns *When* (relative, exact time as `title`), *User* (name, or *Unknown email*), *Result*, *IP address* and *Device*. A user filter `<select>` defaults to *Everyone* and shows a *Clear* chip when one is picked. *Show more* asks for 200. It says *Kept for 90 days.* under the heading.
  - Result labels and tones (`signInResultView`): *Signed in* ok · *Signed in after 3 failed attempts* warn · *Wrong password (3 in a row)* warn · *Wrong password: locked until 11:12* danger · *Unknown email* neutral · *Refused: locked* warn · *Refused: disabled* neutral · *One-time password expired* neutral · *Password changed* ok · *Password change refused* warn.
  - `deviceName` reads the user agent as browser and OS (*Firefox on Windows*, *Safari on iPhone*, *Edge on Windows*; unknown → the first 40 characters; null → *—*). The full string is the `title`.
- After *Add user* or *Reissue*, an inline notice above the list (the same pattern as today's *new token* notice): *One-time password for Ken (ken@example.com)*, the password in a monospace box, a **Copy** button, *Shown once. It works for 7 days, and Ken chooses their own password at first sign-in.*, and *Done* to dismiss.
- A refusal (409 etc.) shows in an alert at the top of the section.

- [ ] **Step 1: Failing tests** (by role and label, never class names)

```tsx
it('lists users with their status', async () => {
  render(<AccessPage api={fakeApi({ users: [ADMIN_FROM_LOG, KEN_ACTIVE, ANN_LOCKED, BOB_DISABLED_BY_FAILURES] })} me={ADMIN_ME} />);
  const ken = await screen.findByRole('listitem', { name: /Ken Hayward/ });
  expect(within(ken).getByText('ken@example.com')).toBeVisible();
  expect(within(ken).getByText('Active')).toBeVisible();
  expect(within(screen.getByRole('listitem', { name: /Ann/ })).getByText(/^Locked until /)).toBeVisible();
  expect(within(screen.getByRole('listitem', { name: /Bob/ })).getByText('Disabled: 20 failed sign-ins')).toBeVisible();
  const admin = screen.getByRole('listitem', { name: /Admin/ });
  expect(within(admin).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Sign-in history for Admin']);
});

it('shows failed attempts on a row before it locks', async () => { /* KEN with failedSignIns 3 → '3 failed sign-ins' in his row */ });

it('adds a user and shows the one-time password once', async () => {
  // click 'Add user', fill Name, Email address, pick Role 'User', click 'Add user' in the dialog
  // → api.addUser({ name: 'Ken Hayward', email: 'ken@example.com', role: 'user' })
  // → a region named 'One-time password for Ken Hayward' shows 'abcd-efgh-jkmn-pqrs' and a 'Copy' button
  // → after 'Done' the password is no longer in the document
});

it('disables after confirming', async () => { /* 'Disable Ken Hayward' → dialog → 'Disable' → setUserEnabled(id, false) */ });
it('unlocks a locked user without a confirm', async () => { /* 'Unlock Ann' → setUserEnabled(id, true); 'Disable Ann' is still there */ });
it('re-enables a user disabled by failed sign-ins', async () => { /* 'Enable Bob' → setUserEnabled(id, true) */ });
it('Sign-in history filters the panel to that user', async () => {
  // click 'Sign-in history for Ken Hayward' → api.listSignIns({ userId: KEN.id, limit: 50 }),
  // the user filter reads 'Ken Hayward', and 'Clear' goes back to listSignIns({ limit: 50 })
});
it('reissues after confirming and shows the new password', async () => { /* 'Reissue one-time password for Ken Hayward' */ });
it('edits name, email and role', async () => { /* 'Edit Ken Hayward' → change email → 'Save' → updateUser(id, { email }) */ });
it('cannot disable or demote yourself', async () => { /* me = Ann (admin): her Disable is disabled with title 'You cannot disable yourself' */ });
it('shows a refusal', async () => { /* addUser rejects ApiError(409, 'a user with this email already exists') → alert */ });
it('filters by chip and by the top-bar query', async () => {});
it('still shows the S3 keys section', async () => { /* heading 'S3 keys for the data lake' */ });
```

`access-derive.test.ts`: `it.each` over every `UserStatus` (plus a must-change user whose one-time password expires in 1 day and one that has expired, a user whose lock ran out at `now` and so reads *Active* with *10 failed sign-ins*, and both disabled reasons) giving the expected label, tone and detail. A second `it.each` over every `SignInResult` (with and without `failures` and `lockedUntil`) for `signInResultView`. A third over a dozen real user-agent strings for `deviceName`.

`sign-ins-panel.test.tsx`: lists events with the labels above, *Unknown email* for a null user, *Show more* asks for 200, and an error from `listSignIns` shows an alert without hiding the Users list.

Run: `npx vitest run --project web apps/web/test/access-page.test.tsx apps/web/test/access-derive.test.ts apps/web/test/sign-ins-panel.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement** the page, dialog, derive helpers and icons to make them pass. The copy follows *Layout* above. Delete what was token-only: `EXPIRY_OPTIONS`, `ADMIN_EXPIRY_OPTIONS`, `expiryDays`, `expiresSoon`, `tokenGroup`, `tokenCounts` (grep for any other users first).

- [ ] **Step 3: Run the web project**

Run: `npx vitest run --project web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "Web: Access page lists users with edit, enable/disable, unlock and reissue actions, and recent sign-ins"
```

---

### Task 7: Web: Change password in the account menu

**Files:**
- Modify: `apps/web/src/shell/AppShell.tsx` (`AccountMenu`: add *Change password* above *Sign out*. Plain users get the menu too: today they have only a chip with Sign out, and now it becomes the same menu without the admin items.)
- Modify: `apps/web/src/App.tsx` (route `#/account/password` → `ChangePassword mode="account"`)
- Test: the existing AppShell test file (`grep -rl "AccountMenu\|account menu" apps/web/test`)

- [ ] **Step 1: Failing tests**: an admin's menu reads *Models, Access, Change password, Sign out*; a user's menu reads *Change password, Sign out*; Escape still returns focus to the name chip; choosing *Change password* goes to `#/account/password`; the admin from the log (`me.email === null`) has no *Change password* item.
- [ ] **Step 2: Implement**; `routeTitle` gives *Change password · CT Studio*.
- [ ] **Step 3: Run** `npx vitest run --project web`. Expected: PASS.
- [ ] **Step 4: Commit** `git commit -am "Web: change your password from the account menu"`

---

### Task 8: Smoke test, ADR, CLAUDE.md, API docs, full check

**Files:**
- Modify: `deploy/scripts/smoke-test.sh` (lines 36-38 and 89-110)
- Check: `deploy/scripts/deploy.sh`, `deploy.ps1`, `.github/workflows/ci.yml`: they only fetch `ADMIN_TOKEN` with `admin-token.sh`, which is unchanged. Confirm nothing posts `{"token":…}` with `grep -rn '"token"' deploy .github`.
- Create: `docs/adr/0013-email-password-users.md`
- Modify: `docs/adr/0006-token-access.md` (status: *superseded in part by [0013]*: sessions, the cookie, the per-IP limit, the public routes and the admin token from the log still stand)
- Modify: `CLAUDE.md` (the **Access** bullet: users, `users` table migration 0039, `admin` + log password, one-time passwords, restricted sessions, lockout, `req.auth.userId` for pins and `req.auth.label` = name for audit; drop the token wording)
- Regenerate: `docs/openapi.json`

- [ ] **Step 1: Rewrite the smoke steps**

```bash
login() { # login password jar
  curl -fsS -c "$3" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$1\",\"password\":\"$2\"}" "$BASE_URL/api/auth/login" >/dev/null
}

login admin "$ADMIN_TOKEN" "$ADMIN_JAR" || fail "admin sign-in"
check /api/users
created="$(curl -fsS -b "$ADMIN_JAR" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Smoke test $RANDOM\",\"email\":\"smoke-$RANDOM@example.invalid\"}" "$BASE_URL/api/users")"
otp="$(json_field password <<<"$created")"
email="$(json_field email <<<"$created")"
user_id="$(grep -o '"id":"[^"]*"' <<<"$created" | head -1 | cut -d'"' -f4)"
[[ -n "$otp" && -n "$user_id" ]] || fail "add user: $created"

login "$email" "$otp" "$USER_JAR" || fail "first sign-in"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/specs")" == 403 ]] || fail "one-time sessions are restricted"
[[ "$(status -b "$USER_JAR" -X PUT -H 'Content-Type: application/json' \
  -d "{\"currentPassword\":\"$otp\",\"newPassword\":\"smoke test phrase $RANDOM\"}" \
  "$BASE_URL/api/auth/password")" == 204 ]] || fail "change password"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/specs")" == 200 ]] || fail "signed in after the change"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/users")" == 403 ]] || fail "users can't list users"
[[ "$(status -b "$ADMIN_JAR" -X POST "$BASE_URL/api/users/$user_id/disable")" == 200 ]] || fail "disable"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/specs")" == 401 ]] || fail "disabling ends sessions"
events="$(curl -fsS -b "$ADMIN_JAR" "$BASE_URL/api/sign-ins?userId=$user_id&limit=10")"
grep -q '"result":"password-changed"' <<<"$events" || fail "sign-in events: $events"
[[ "$(status -b "$USER_JAR" "$BASE_URL/api/sign-ins")" == 401 ]] || fail "sign-ins are admin-only"
echo "ok   users: add, first sign-in, password change, disable, sign-in events"
```

The smoke test does not exercise the lockout: 10 guesses would trip the per-IP limiter on the CI runner's single address first. The unit and Pg tests cover it.

Smoke users stay in the list, disabled. Their emails are on `.invalid`, so a test user can never be real. Add a note to `deploy/README.md` about this, or have the smoke test filter them by the `Smoke test` name prefix in its own `GET /api/users` check.

- [ ] **Step 2: Write ADR 0013**, in the ADR 0006 style: Context (tokens hard for collaborators), Decision (D1 to D11 and the global constraints), Threat model (covered: guessing through scrypt, the escalating lockout and the per-IP limit, at most 10 guesses before a 15-minute wait and 20 before an admin must act; stolen sessions, which disabling ends and which last 30 days at most; leaked one-time passwords, which expire in 7 days and only allow a password change; guessing made visible to the user (D9) and to admins (D11). Not covered: someone who knows an email address can delay that person by locking them, up to 24 h at a time, and after 20 failures until an admin re-enables them; a locked account's 429 tells a guesser that the email exists, after 10 guesses; no second factor; the API log still holds the admin password; no email delivery, so admins hand over one-time passwords out of band), and Consequences (migration 0039 signs everyone out; the smoke test signs in as `admin`; `sign_in_events` holds IP addresses and user agents for 90 days, which belongs in any privacy notice).

- [ ] **Step 3: Regenerate the docs and run everything**

Run: `npm run openapi` and then `npm run check`
Expected: green. Then run the Pg contract (Task 3, Step 2 command) once more and `npm run test:integration` if a dev-infra stack is up.

- [ ] **Step 4: Run the stack once by hand**: `deploy/scripts/dev-infra.ps1 up`, `npm run dev:api`, `npm run dev:web`. Sign in as `admin` with the logged token, add a user, sign in with the one-time password in a private window, change it, lock it with 10 wrong passwords, unlock it from the Access page.

- [ ] **Step 5: Commit**

```bash
git add deploy docs CLAUDE.md
git commit -m "Docs and smoke test: email and password users (ADR 0013)"
```

---

## Suggestions beyond the request

**Adopted 2026-10-15:** S1 (escalating lockout, D3), S2 (failed attempts since the last visit, D9), S4 (30-day sessions, D10) and S6 (sign-in audit, D11). They are built into the tasks above.

Still open; each is small:

- **S3. Delete users who never signed in.** For a typo'd email address. Everyone else is disabled, not deleted, so audit labels keep meaning something.
- **S5. Breached-password check, offline.** Refuse the 10,000 most common passwords, shipped as a static list in the image. No network call.
- **S7. TOTP second factor for admins.** Later, if the app ever faces untrusted networks more directly. It stays in-stack (`node:crypto` HMAC), with no provider.
- **S8. Email delivery of one-time passwords.** Only if an SMTP relay exists. Until then, admins copy the password to the person themselves, which the one-time-password notice makes easy.

## Self-review notes

- Requirement 1 → Tasks 1 to 4. Requirement 2 → D1, Task 2 (`rotateAdminPassword`), Task 4 (server.ts). Requirement 3 → Task 4 `POST /api/users`, Task 6. Requirement 4 → restricted session (Tasks 2 and 4), `ChangePassword` (Task 5). Requirement 5 → Task 3 migration, Task 4 route removal and test, Task 5 client removal. Requirement 6 → no S3 file in any task; Task 6 test keeps the section. Requirement 7 → Task 6. Requirement 8 → `lockout.test.ts` and the Task 2 lockout tests, Task 3 concurrency tests, Task 4 route test.
- S1 (D3) → `lockFor` (Task 2 Step 0), the doubling and disable contract tests, Pg `LOCK_ROW`/`COUNT`, the 429 route test, the web lock message (Task 5) and row tags (Task 6). S2 (D9) → contract `failedSinceLastSignIn` test, route test, `FailedSignInsNotice` (Task 5). S4 (D10) → the 30-day contract test, the Pg `SESSION` query, the cookie `Max-Age` route test. S6 (D11) → the `sign_in_events` migration, the contract record/list/prune test, the route tests (recorded results, nothing typed stored, a failing write), pruning in `server.ts`, `SignInsPanel` (Task 6), the smoke check (Task 8).
- Review focus 1 → Task 3 concurrency test; 2 → Task 2 disable/lock/reissue tests; 3 → Task 2 normalisation test; 4 → Task 4 restricted sweep; 5 → Task 4 self-protection test.
