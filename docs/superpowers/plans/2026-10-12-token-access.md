# Token Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the whole app behind access tokens (admin token rotated per API start, user tokens issued in-app) so it can be exposed through NGINX Proxy Manager.

**Architecture:**
- `AccessRepo` port (memory + Pg) holds hashed tokens and sessions.
- A Fastify `onRequest` hook enforces a session cookie on `/api/*` except login and logout.
- The web app shows a sign-in gate and an admin Access page.
- Deploy scripts and the CI smoke test sign in with the admin token from the API log.

**Tech Stack:** Fastify 5 + `@fastify/cookie`, Zod 3, Postgres (`pg`), React + Vitest + Testing Library, bash/PowerShell deploy scripts.

**Spec:** `docs/superpowers/specs/2026-10-12-token-access-design.md`

## Global Constraints

- TDD: write the test first, watch it fail, then implement. Unit tests stay offline, using `MemoryAccessRepo` and `fakeApi`.
- Store tokens and session ids only as SHA-256 hex. Show the plaintext once.
- The cookie is `ih_session`, `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` only when `req.protocol === 'https'`.
- Idle session limit is 7 days. Touch `last_seen_at` / `last_used_at` at most every 5 minutes.
- Login limits: 10 failures per IP and 100 globally per 15 minutes, then 429.
- `AppDeps.access: AccessRepo | null`; `null` exists only for unit tests. `server.ts` always wires `PgAccessRepo`.
- Migrations are forward-only. Use ESM `.js` import suffixes and Zod at the boundaries.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Every existing `/api` route must be covered by the hook.** A route registered with a different prefix, or added later, could slip through. An enforcement sweep test over `app.printRoutes()` / an injected route list pins this (Task 3).
2. **Cookie over plain-HTTP LAN versus HTTPS through NPM.** The `Secure` flag must depend on the forwarded proto, and nginx must pass NPM's `X-Forwarded-Proto` through. Pinned in Task 3 (`x-forwarded-proto: https` → `Secure`) and Task 6 (nginx `map`).
3. **Admin rotation while admin sessions exist.** Those sessions must die, and user sessions must survive. Pinned in Task 1.
4. **Rate-limit IP source.** Behind two proxies, `req.ip` must be the real client: `trustProxy` uses private ranges. Pinned in Task 3 with distinct `x-forwarded-for` values.
5. **CI smoke test and deploy scripts must still pass once the API returns 401.** Pinned in Task 6: the smoke test logs in with the admin token taken from the logs.

---

### Task 1: Access model (MemoryAccessRepo, token utilities)

**Files:**
- Create: `apps/api/src/access/tokens.ts` (`newToken()`, `newSessionId()`, `sha256()`), `apps/api/src/access/repo.ts` (types + `AccessRepo` interface + `MemoryAccessRepo`)
- Create: `db/migrations/0007_access.sql`
- Test: `apps/api/test/access-repo.test.ts`

**Interfaces (produced):**

```ts
export type AccessRole = 'admin' | 'user';
export type TokenStatus = 'active' | 'expired' | 'revoked' | 'current-admin';
export interface AccessToken { id: string; label: string; role: AccessRole; createdAt: string;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; status: TokenStatus }
export interface SessionInfo { tokenId: string; role: AccessRole; label: string; expiresAt: string | null }
export interface AccessRepo {
  rotateAdminToken(): Promise<string>;                                      // plaintext
  createToken(label: string, expiresInDays: number | null): Promise<{ token: string; record: AccessToken }>;
  listTokens(): Promise<AccessToken[]>;
  revokeToken(id: string): Promise<'ok' | 'not_found' | 'admin'>;
  deleteToken(id: string): Promise<'ok' | 'not_found' | 'admin'>;
  login(token: string): Promise<{ sessionId: string; session: SessionInfo } | null>;
  session(sessionId: string): Promise<SessionInfo | null>;                  // validates + touches
  logout(sessionId: string): Promise<void>;
}
export const SESSION_IDLE_MS = 7 * 86_400_000; export const TOUCH_INTERVAL_MS = 5 * 60_000;
```

`MemoryAccessRepo(now = () => Date.now())` takes an injectable clock.

- [ ] **Step 1: Write failing tests** (`access-repo.test.ts`, against `MemoryAccessRepo` with a mutable clock):
  - rotation returns an `ih_` token of 46 characters; login with it gives role `admin`;
  - a second rotation invalidates the old admin token **and** its sessions, while a user token and its session survive;
  - a user token with `expiresInDays: 1` stops working after 1 day plus 1 ms, and its session dies too;
  - a session idle for 7 days plus 1 ms is invalid; one touched within the window stays valid;
  - revoking kills sessions at once, and login with that token fails;
  - delete removes the token from `listTokens()`;
  - the admin row reports `current-admin`, and revoke or delete on it returns `'admin'`;
  - `listTokens` never exposes a hash (keys are only the interface fields);
  - unknown ids return `'not_found'`;
  - `sha256('x')` equals the known hex.
- [ ] **Step 2: Run them and confirm they fail** (the module is missing): `npx vitest run --project api test/access-repo.test.ts`.
- [ ] **Step 3: Implement** `tokens.ts`: `newToken = () => 'ih_' + randomBytes(32).toString('base64url')`, `sha256 = (s) => createHash('sha256').update(s).digest('hex')`. `MemoryAccessRepo` keeps a `tokens: Map<id, row with hash>` and a `sessions: Map<idHash, {tokenId, lastSeen}>`. `session()` checks:
  - the token exists;
  - it isn't revoked;
  - it hasn't expired (`expiresAt > now`);
  - `lastSeen + IDLE >= now`.

  It touches `lastSeen` and `lastUsedAt` when older than the touch interval.

  Migration `0007_access.sql`:

```sql
-- Access tokens (admin token rotated on every API start; user tokens issued in-app) and the
-- browser sessions they open. Only SHA-256 hashes are stored. See ADR 0006.
CREATE TABLE access_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text        NOT NULL,
  role         text        NOT NULL CHECK (role IN ('admin', 'user')),
  token_hash   text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz
);
CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,
  token_id     uuid        NOT NULL REFERENCES access_tokens (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_token_idx ON sessions (token_id);
```

- [ ] **Step 4: Run them and confirm they pass**, then commit "Access model: hashed tokens, sessions, admin rotation (memory repo + migration)".

### Task 2: PgAccessRepo

**Files:** Create `apps/api/src/access/pg.ts`; verify with a scratch-Postgres script (not committed).

- [ ] Implement each method with the same semantics as Task 1:
  - **Rotation:** in one transaction, `DELETE FROM access_tokens WHERE role='admin'`, then `INSERT … RETURNING`.
  - **Session validation:** one query joining `sessions` to `access_tokens` with the expiry, revoked and idle predicates (`last_seen_at > now() - interval '7 days'`).
  - **Touch:** `UPDATE … WHERE last_seen_at < now() - interval '5 minutes'`.
  - **Status:** derived in SQL, `CASE WHEN role='admin' THEN 'current-admin' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END`.
- [ ] Verify on scratch Postgres 17 (all migrations applied): rotate, login, create, revoke and delete behave as the memory repo does, and a re-rotation kills the admin session. Then commit "PgAccessRepo".

### Task 3: API enforcement and routes

**Files:**
- Create `apps/api/src/access/routes.ts` (hook + routes) and `apps/api/src/access/limiter.ts`.
- Modify `apps/api/src/app.ts`: deps, the cookie plugin, `trustProxy`, registration.
- Modify `apps/api/src/config.ts`: `TRUST_PROXY`.
- Modify `apps/api/src/server.ts`: `PgAccessRepo`, rotation, and the warn-level log line.
- Modify `apps/api/test/helpers.ts`: `access: null` by default.
- Add the dependency `@fastify/cookie`.
- Test: `apps/api/test/access.test.ts`.

**Interfaces:** `AppDeps.access: AccessRepo | null`; `AppDeps.trustProxy?: string | boolean`; `FastifyRequest.auth?: SessionInfo`; `class LoginLimiter { allowed(ip, now): boolean; fail(ip, now): void }`.

- [ ] **Step 1: Write failing tests** (`testApp({ access: new MemoryAccessRepo() })`):
  - **Gate:** `/api/specs` returns 401 `{error:'sign in required'}` without a cookie.
  - **Sweep:** the enforcement sweep calls every route returned by `app.printRoutes({commonPrefix:false})` whose path starts `/api/` and isn't login or logout, with its method and placeholder ids. Each must answer 401.
  - **Login:** the admin token from `rotateAdminToken()` returns 200 `{role:'admin'}` and sets `ih_session` with `HttpOnly`, `SameSite=Strict` and `Path=/`, and no `Secure`. With `x-forwarded-proto: https` the cookie is `Secure`.
  - **Signed-in calls:** with the cookie, `/api/specs` returns 200 and `/api/auth/me` returns `{role, label}`.
  - **Bad tokens:** a wrong token and an empty or missing token each return 401 `invalid or expired token`.
  - **Token routes:**
    - a user creates a token and gets 403;
    - an admin creates one and gets `{token, record:{role:'user'}}`;
    - the user can log in with that token;
    - an admin revokes it, and the user's next call gets 401;
    - revoke or delete of the admin token returns 409;
    - an unknown id returns 404.
  - **Logout:** returns 204, clears the cookie (`Max-Age=0`), and the old cookie then gets 401.
  - **Limiter:** 10 failures from `x-forwarded-for: 10.0.0.5` → the 11th gets 429 even with a valid token, while `10.0.0.6` still gets 200.
  - **Existing behaviour:** the rest of the suite runs with `access: null`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **Plugin and proxy setup:** register `@fastify/cookie`, and pass `trustProxy` to Fastify. The default is `'127.0.0.1/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1,fc00::/7'`.
  - **Hook:** `addHook('onRequest')` skips anything not under `/api/` plus the two public routes, then reads the cookie. If `deps.access` is null it does nothing.
  - **Admin routes:** they check `req.auth?.role === 'admin'`.
  - **Request bodies:** the login body is `z.object({token: z.string().min(1).max(200)})` and the create body is `z.object({label: z.string().trim().min(1).max(100), expiresInDays: z.union([z.literal(1),z.literal(7),z.literal(30),z.literal(90),z.literal(365), z.null()])})`.
  - **Startup:** `server.ts` runs `const adminToken = await access.rotateAdminToken(); app.log.warn(\`ADMIN TOKEN (valid until the next restart): ${adminToken}\`)` once the app is listening.
- [ ] **Step 4: Run the tests and confirm they pass**, plus `typecheck` and `lint`. Commit "API: token access enforcement, auth routes, login limiter".

### Task 4: Web sign-in gate and nav

**Files:**
- Modify `apps/web/src/api/client.ts`: `me`, `login`, `logout`, `onUnauthorized`, and 401 handling via an internal `send()` wrapper.
- Modify `apps/web/test/fake-api.ts`.
- Create `apps/web/src/access/SignIn.tsx`.
- Modify `apps/web/src/App.tsx`: gate, nav identity, Sign out.
- Test: `apps/web/test/SignIn.test.tsx` and additions to `apps/web/test/App.test.tsx`.

**Interfaces:**
- `Api.me(): Promise<SessionInfo | null>` (null on 401);
- `Api.login(token): Promise<SessionInfo>` (throws `Error` with `.status`);
- `Api.logout(): Promise<void>`;
- `Api.onUnauthorized(cb): () => void`.

`createHttpApi` fires `onUnauthorized` listeners on a 401 from any non-`/auth/` call.

- [ ] **Tests first:**
  - **Gate:** `me()` null shows the sign-in screen (field "Access token", button "Sign in"); a successful login renders the Jobs page.
  - **Errors:** a 401 shows "That token is invalid or has expired."; a 429 shows "Too many attempts. Try again in a few minutes."
  - **Session ended:** an `onUnauthorized` emission while signed in shows sign-in with "Your session has ended."
  - **Nav:** shows `label · role`. Sign out calls `logout` and shows sign-in.
  - **Access link:** admins see it; users don't.
  - **Existing tests:** App tests default `fakeApi().me` to an admin session so they keep passing.
- [ ] **Implement, run, commit** "Web: sign-in gate, session identity and sign out".

### Task 5: Web Access page

**Files:**
- Create `apps/web/src/access/AccessPage.tsx`.
- Modify the router (`{name:'access'}` for `#/access`) and `App.tsx`.
- Modify the `Api` port: `listTokens`, `createToken(label, expiresInDays)`, `revokeToken`, `deleteToken`.
- Test: `apps/web/test/AccessPage.test.tsx`.

- [ ] **Tests first:**
  - **Listing:** shows the token table (label, role, created, expires, last used, status).
  - **Creating:** create with a label and expiry → the token appears once in a read-only field with a Copy button and "This is the only time it will be shown.", and `createToken` is called with (label, days or null). After Done, the token is gone.
  - **Revoke / Delete:** both use the inline confirm (`Confirm revoke <label>`); the current admin row has no actions.
  - **Non-admins:** see "Admins only" and `listTokens` isn't called.
  - **Errors:** shown as alerts.
- [ ] **Implement, run, commit** "Web: Access page to issue, revoke and delete tokens".

### Task 6: Deployment, smoke test and docs

**Files:**
- Modify `deploy/docker/nginx.conf`: proto `map` and security headers.
- Modify `deploy/scripts/smoke-test.sh`: auth flow; the admin token comes from `ADMIN_TOKEN` or from `docker compose logs api` via `COMPOSE_CMD`.
- Modify `deploy/scripts/deploy.sh` and `deploy/scripts/deploy.ps1`: print the admin token line and smoke-test with login.
- Modify `.github/workflows/ci.yml`: export the admin token to the smoke step.
- Docs: `deploy/README.md` gets a Remote access section, and there's a new `docs/adr/0006-token-access.md`. `CLAUDE.md` gets the Access rule, `docs/architecture.md` a short note, and `deploy/.env.example` the `TRUST_PROXY` comment.

- [ ] **nginx:** `map $http_x_forwarded_proto $forwarded_proto { default $http_x_forwarded_proto; '' $scheme; }` in the http context. A `conf.d` server file can't hold `map` at server level, so put it at the top of the file, which nginx includes inside `http`. Then `proxy_set_header X-Forwarded-Proto $forwarded_proto;` plus `add_header` for the four headers, `always`, at server level.
- [ ] **Smoke test:**
  - `curl -s -o /dev/null -w '%{http_code}' $BASE/api/specs` returns `401`;
  - log in with a cookie jar;
  - the existing checks run with `-b jar`;
  - create a user token, log in with it in a second jar, then revoke it;
  - a call with the second jar returns 401.
- [ ] **CI:** `ADMIN_TOKEN=$(compose logs api | grep -o 'ih_[A-Za-z0-9_-]\{43\}' | tail -1)`, retried until the API has logged it. Pass it to the smoke script.
- [ ] **Run** `npm run check`. Validate `smoke-test.sh` locally against a scratch stack if Docker allows, otherwise in CI. Commit "Deploy: token-aware smoke test, proxy headers, remote-access docs, ADR 0006".
