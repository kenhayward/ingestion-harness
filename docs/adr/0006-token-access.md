# 0006: Token access instead of user accounts

**Status:** accepted · 2026-10-12

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
- **Sign-in limits:** at most 10 failed sign-ins per client IP and 100 in total per 15 minutes.
  The client IP comes from `X-Forwarded-For`, trusted only from private networks (`TRUST_PROXY`).

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
