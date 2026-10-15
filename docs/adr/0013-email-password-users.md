# 0013: Email and password users instead of access tokens

**Status:** accepted · 2026-10-15 · supersedes the token parts of [ADR 0006](0006-token-access.md)

## Context
ADR 0006 gave people access tokens: a 256-bit string pasted into the sign-in page. Collaborators
found them hard to keep: a token is easy to lose and has no recovery but asking an admin for a
new one. People expect to sign in with an email address and a password they chose. Everything
has to stay inside the stack: no external identity provider and no email service.

## Decision
- **Users** (`users`, migration 0039) replace `access_tokens`. A user has a name, an email
  address (unique, any case, stored in lower case) and a role, `admin` or `user`. Names are
  unique too, whatever the case, because jobs, changes and publications record who did them by
  name (`req.auth.label`), and "My jobs" matches on it.
- **The admin from the log** is a reserved user: sign-in name `admin`, display name **Admin**
  (so nobody else can be called that), and its password is the token the API prints on every
  start (`ADMIN TOKEN (valid until the next restart): ih_…`, the line the deploy scripts read).
  It rotates on every start, ending its sessions. It cannot be edited, disabled, locked or given
  another password.
- **Adding a user:** an admin enters the name, email address and role. The API generates a
  **one-time password** (16 characters from an alphabet without look-alike characters, about 79
  bits, as `xxxx-xxxx-xxxx-xxxx`), shown once to the admin, valid for **7 days**. *Reissue
  one-time password* replaces the user's password with a new one, ends their sessions and unlocks
  them. There is no email delivery: the admin passes it on.
- **First sign-in:** a one-time password opens a *restricted* session that can only read
  `GET /api/auth/me`, change the password (`PUT /api/auth/password`) and sign out. Every other
  `/api` route answers `403 change your one-time password first`. Changing a password ends the
  user's other sessions.
- **Passwords:** 12 to 200 characters, different from the current one, not containing the part
  of the email address before the `@` (when it has 4 or more characters). No complexity rules.
  Hashed with scrypt (`N=32768, r=8, p=1`, 16-byte salt, 32-byte key), the parameters stored in
  each hash so they can be raised later; compared in constant time.
- **Guessing:** counted per account over consecutive failures; a success resets the count. The
  10th failure locks sign-in for 15 minutes; each later failure (possible only once a lock has
  run out) locks for twice as long, at most 24 hours; the 20th disables the account until an
  admin enables it. While locked, the password is not checked at all, and every attempt gets
  `429` with `lockedUntil` (checking it would tell a guesser when a guess was right). A
  temporary lock keeps the user's open sessions; the disable ends them. The admin from the log is
  never locked: its password is a 256-bit token, and a lock would let anyone block the one
  account that can unlock the others until the next restart. The per-client limit of ADR 0006
  (10 failures per IP, or IPv6 /64, per 15 minutes) still applies to everyone.
- **Answers:** an unknown email and a wrong password are the same `401 invalid email or
  password`. An unknown email is still checked against a dummy hash, so timing does not tell
  which emails exist. Only someone who gives the right password learns that the account is
  disabled or that the one-time password expired (`403`).
- **The person is told:** a successful sign-in answers how many failed attempts it cleared and
  when the last one was; the web shows that once.
- **Sessions:** as in ADR 0006 (an opaque `ih_session` cookie, only its hash stored, ended after
  7 days without use), and now also 30 days after sign-in however much it is used. The cookie
  lasts 30 days. A user's role, name and must-change flag are read on every request, so a change
  applies at once; disabling a user ends every session of theirs.
- **Sign-in log:** every sign-in attempt and password change is a `sign_in_events` row (time,
  user or null, result, failure count, lock end, client IP, user agent up to 200 characters),
  read by admins with `GET /api/sign-ins` and on the Access page. What someone typed for an
  unknown email is never stored. Attempts the per-IP limit refuses are only logged, which bounds
  the table under a scan. Rows older than 90 days are deleted at start and every hour.
- **Admin routes:** `GET|POST /api/users`, `PATCH /api/users/:id`,
  `POST /api/users/:id/disable|enable|one-time-password`, `GET /api/sign-ins`. An admin cannot
  disable themselves or remove their own admin role.
- **Unchanged:** the cross-site guard and cookie attributes (ADR 0012), the public routes (sign-in,
  sign-out, the API docs), the data-lake S3 keys (ADR 0008).

## Threat model
- **Covered:**
  - Password guessing: scrypt, at most 10 guesses before a 15-minute wait and 20 before an admin
    must act, plus the per-IP limit.
  - Guessing made visible: the person sees the failed attempts at their next sign-in; admins see
    every attempt with its IP address and device.
  - Stolen sessions: they end on disable, on a password change (the others), and after 30 days.
  - Leaked one-time passwords: valid for 7 days, and they only allow choosing a password.
- **Not covered:**
  - **Lock-outs by others:** someone who knows an email address can lock that person, up to 24
    hours at a time, and after 20 failures until an admin enables them. The per-IP limit slows
    one source.
  - **Account discovery:** a locked account's `429` tells a guesser the email exists, after 10
    guesses.
  - **No second factor.**
  - **The API log** still holds the admin password until the next restart.
  - **No email:** admins hand one-time passwords over themselves, outside the app.
  - **TLS** is the proxy's job, as before.

## Consequences
- Migration 0039 drops the access tokens and their sessions and empties the Workbench pins (their
  owners were token ids; they are user ids now): everyone signs in again, and an admin adds the
  users.
- The deploy and smoke scripts sign in as `admin` with the logged token as the password. The
  smoke test leaves a disabled `Smoke test …` user with an `@example.invalid` address each run.
- `sign_in_events` holds IP addresses and user agents for 90 days, which belongs in any privacy
  notice.
- Every guarded route documents the restricted session's `403` (`apps/api/src/openapi/zod.ts`).
