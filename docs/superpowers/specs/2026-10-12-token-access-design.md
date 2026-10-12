# Token access: design

Date: 2026-10-12 · Status: approved in conversation (sections 1–4)

## Goal

Make the app safe to reach from outside the LAN through the existing NGINX Proxy Manager,
without a user-account system. People sign in by entering an **access token**. An admin issues
tokens from an in-app **Access** page. The admin token rotates on every API start and is printed
in the API log. Tokens are required everywhere, including the LAN.

## 1. Data model and token lifecycle

- **Token format:** `ih_` followed by 32 random bytes encoded as base64url. Only the SHA-256 hex
  digest is stored; a fast hash is fine because tokens are high-entropy. The plaintext is shown
  exactly once: in the log for the admin token, and in the create response for user tokens.
- **Migration `0007_access.sql`:**
  - `access_tokens(id uuid pk, label text, role text CHECK (role IN ('admin','user')),
    token_hash text UNIQUE, created_at, expires_at NULL = never, revoked_at, last_used_at)`
  - `sessions(id_hash text pk, token_id uuid REFERENCES access_tokens ON DELETE CASCADE,
    created_at, last_seen_at)`
- **Admin rotation:** on every API start, `rotateAdminToken()` does the following:
  - deletes every `role='admin'` row, which also deletes their sessions through the cascade;
  - inserts a new admin token with no expiry;
  - the server logs it once at warn level: `ADMIN TOKEN (valid until the next restart): ih_…`.

  User tokens and their sessions are untouched. This assumes a single API instance, which the
  docs state.
- **User tokens:**
  - An admin creates them with a label and an expiry of 1, 7, 30, 90 or 365 days, or never.
  - Revoking sets `revoked_at` and deletes the token's sessions.
  - Delete removes the row.
  - The current admin token can't be revoked or deleted (409).
- **Sessions:** a valid login creates a session. The cookie value is 32 random bytes and only its
  hash is stored. A session is valid while all of these hold:
  - its token is not expired and not revoked;
  - its token row still exists (a rotated-out admin token's row is gone);
  - `last_seen_at` is within the last 7 days.

  `last_seen_at` and the token's `last_used_at` are updated at most every 5 minutes. Logout
  deletes the session.

## 2. API and enforcement

- **`AccessRepo` port:** `PgAccessRepo` and `MemoryAccessRepo` in `apps/api/src/access/`,
  injected as `AppDeps.access: AccessRepo | null`.
  - `null` turns enforcement off. That exists for unit tests only; `server.ts` always passes
    `PgAccessRepo`, and no environment variable disables it.
- **`onRequest` hook** on every `/api/*` route except `POST /api/auth/login` and
  `POST /api/auth/logout`. (`/healthz` and `/readyz` aren't under `/api`.)
  - No valid session: **401** `{error: 'sign in required'}`.
  - Valid session: `req.auth = {tokenId, role, label, expiresAt}`.
  - The `/api/auth/tokens*` routes additionally require `role === 'admin'`, otherwise **403**.
- **Routes:**
  - `POST /api/auth/login {token}`:
    - an active token creates a session, sets the cookie, and returns `{role, label, expiresAt}`;
    - anything else returns **401** `{error: 'invalid or expired token'}`.
  - `POST /api/auth/logout`: deletes the session and clears the cookie, returns 204.
  - `GET /api/auth/me`: `{role, label, expiresAt}`, or 401.
  - `GET /api/auth/tokens` (admin): `[{id, label, role, createdAt, expiresAt, revokedAt,
    lastUsedAt, status}]`.
    - `status` is one of `active`, `expired`, `revoked`, `current-admin`; hashes are never
      returned.
  - `POST /api/auth/tokens {label (1..100), expiresInDays: 1|7|30|90|365|null}` (admin): returns
    `{token, record}` and always creates a `user` token.
  - `POST /api/auth/tokens/:id/revoke` and `DELETE /api/auth/tokens/:id` (admin): 404 if the
    token is unknown, 409 for the admin token.
- **Brute-force limit:** in memory, at most 10 failed logins per client IP and 100 in total per
  15 minutes, then **429** `{error: 'too many attempts, try again later'}`.
  - The client IP comes from Fastify `trustProxy`, which defaults to loopback and private ranges
    (`TRUST_PROXY` overrides it).
- **Cookie:** `ih_session` with `HttpOnly; SameSite=Strict; Path=/`.
  - `Secure` is added when `req.protocol === 'https'`, so plain-HTTP LAN access keeps working.
  - Cookies are parsed with `@fastify/cookie`.

## 3. Web UI

- **Sign-in gate:** `App` calls `api.me()` at startup and shows "Loading…" while it waits.
  - `null` (a 401): show the **Sign in** screen, a password field labelled "Access token" and a
    Sign in button.
  - Inline errors cover an invalid or expired token (401) and too many attempts (429).
  - A successful sign-in renders the app.
- **Mid-session 401:** a 401 on any other API call fires `onUnauthorized`. The app returns to
  sign-in with "Your session has ended".
- **Navigation:** the nav shows the signed-in label and role, plus **Sign out**. Admins also see
  an **Access** link to `#/access`.
- **Access page (admin):**
  - **Creating a token:** a form with a label and an expiry select (1/7/30/90/365 days or never).
    The created token is shown once, read-only, with a **Copy** button and the warning "This is
    the only time it will be shown."
  - **Token table:** label, role, created, expires, last used and status.
  - **Revoke and Delete:** inline confirm, with the same focus pattern as the Jobs table.
  - Non-admins see "Admins only".

## 4. Deployment and operations

- **nginx (app container):**
  - `X-Forwarded-Proto` passes the incoming value through (a `map` falling back to `$scheme`).
  - Adds `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.
- **Compose:** the SeaweedFS master UI already defaults to `127.0.0.1`. The docs say to keep
  `SEAWEEDFS_MASTER_BIND` and `S3_PUBLIC_BIND` local when exposing the app.
- **Admin token access:** after a deploy, `deploy.sh` and `deploy.ps1` print the admin token line
  from the API logs. It can also be found with `docker compose logs api | grep "ADMIN TOKEN"`.
- **Smoke test** (`smoke-test.sh`, used by CI, and `deploy.ps1`):
  - `/api/specs` returns 401 without a cookie;
  - log in with the admin token from the API logs;
  - existing checks with the cookie;
  - create a user token, log in with it, revoke it, then confirm it's rejected.
- **Docs:**
  - `deploy/README.md` gets a "Remote access" section on NGINX Proxy Manager:
    - Let's Encrypt, Force SSL, HSTS and block common exploits;
    - `client_max_body_size 60m; proxy_read_timeout 300s;`;
    - forward only port 8081.
  - ADR 0006 records the threat model. Covered: strangers, scanners and guessing. Not covered: a
    compromised device that's already signed in, or someone with access to the Docker host's logs.
  - CLAUDE.md gets an "Access" rule.

## Testing

- **API:**
  - auth routes: login, logout, me, tokens, revoke, delete, the 409s and 403s, and the 429 limit;
  - cookie attributes, including `Secure` only over https via `x-forwarded-proto`;
  - admin rotation: the old token and its sessions stop working, user tokens survive;
  - the 7-day idle limit and token expiry (with an injectable clock);
  - an enforcement sweep where every registered `/api` route except the public ones returns 401
    without a cookie.
- **PgAccessRepo:** checked on a scratch Postgres, and end to end by the CI smoke test.
- **Web:** gate, sign-in errors, mid-session expiry, nav, and the Access page (create-once, revoke
  and delete with confirm, admins only).
