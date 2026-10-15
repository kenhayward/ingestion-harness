# 0006: Token access instead of user accounts

**Status:** accepted · 2026-10-12 · superseded in part by [ADR 0013](0013-email-password-users.md) (users with email and password replace the access tokens; sessions, the cookie, the per-client sign-in limit, the public routes and the admin token from the log still stand)

## Context
The app is exposed beyond the LAN through NGINX Proxy Manager. A full user-account and login
system is more than a small trusted team needs, but every route and every stored document must be
protected from strangers and scanners.

## Decision
- **Access tokens:** people sign in with an access token. A token is `ih_` followed by 32 random
  bytes. Only its SHA-256 hash is stored, and the plaintext is shown once.
- **Admin token:** created afresh on every API start and printed in the API log. The previous one
  and its sessions end. That makes the first sign-in after a deploy possible, and it makes
  rotation automatic.
- **User tokens:** admins issue them on the **Access** page with a label and an expiry (1 to 365
  days, or never). Admins can revoke them (ending their sessions immediately) or delete them.
  Users can do everything except manage tokens.
- **Sessions:**
  - Signing in exchanges the token for an opaque session cookie `ih_session` (`HttpOnly`,
    `SameSite=Strict`, and `Secure` over HTTPS); only the cookie's hash is stored.
  - A session lasts until its token expires or is revoked, ending after 7 idle days.
  - Every `/api/*` route needs a session except sign-in and sign-out. The check is made on the
    *matched route*, not the raw URL.
  - Tokens are required on the LAN too.
- **Sign-in limits:** at most 10 failed sign-ins per client (an IP, or an IPv6 /64) per 15
  minutes.
  - There's no global block (that would let anyone lock everyone out); a surge is only logged.
  - The client IP comes from `X-Forwarded-For`, trusted only from private networks plus anything
    in `TRUST_PROXY`.
- **Cookie lifetime:** the session cookie persists until its token expires (at most 400 days).
- **Admin token output:** the admin token line goes straight to stdout, whatever `LOG_LEVEL` is.
  Scripts match only that exact line, which a request URL can't forge, and it's masked in GitHub
  Actions.

## Threat model
- **Covered:** strangers, scanners and token guessing, through 256-bit tokens, rate limits and a
  gate on every API route; cross-site requests (`SameSite=Strict`); and stolen or leaked user
  tokens, which can be revoked.
- **Not covered:**
  - **A compromised device that's already signed in:** revoke its token.
  - **Anyone who can read the API logs** (the Docker host, or a log aggregator): they get the
    current admin token until the next restart.
  - **A single admin token:** it assumes one API instance; a second instance would rotate it out
    from under the first.
  - **TLS:** that's the proxy's job.

## Consequences
- The smoke test and deploy scripts sign in with the admin token from the log
  (`deploy/scripts/admin-token.sh`).
- Unit tests build the app with `access: null`. Enforcement is tested separately, including a
  sweep that calls every `/api` route.
- nginx forwards the original `X-Forwarded-Proto`, so `Secure` cookies work behind TLS.

## Addendum (2026-10-13): public API docs

The API docs ([design](../design/api-docs.md)) are public: the Scalar browser and the OpenAPI
document under `/api/docs`. Public routes are now marked on the route (`config.public`) rather
than listed by path; the access hook still decides on the matched route. Sign-in, sign-out and
the routes the docs plugin registers are the only public `/api` routes, and the sweep in
`access.test.ts` checks that exact set. The document describes an API whose code is already
public and carries no deployment details (`servers: [{ url: '/' }]`).

## Addendum (2026-10-13): issued admin tokens

Reading the API log after every deploy is awkward for long-lived admin access, so admins can now
issue **admin tokens** on the Access page, named and expiring like user tokens.

- **The admin token from the log** (`bootstrap`, migration 0021) is unchanged: replaced on every
  API start, and the only token that cannot be revoked or deleted.
- **Issued admin tokens** survive restarts and **must expire** (1, 7, 30, 90 or 365 days; the
  API refuses "never" and a table constraint backs it). Any admin can revoke or delete them.
  They are full admins: every admin check is on the role, so they can issue tokens too,
  including more admin tokens.
- **Audit:** every token records `issued_by`, the label of the session that issued it, shown in
  the list. Issuing an admin token is logged at warning level (`admin token issued`, with the
  id, label, expiry and issuer; never the token).

**Threat model change:** a leaked issued admin token stays valid until it expires or is
revoked; a restart no longer ends it. Revoking it does not revoke tokens it issued: check the
list for tokens it issued (`Issued by`) and revoke those too.
