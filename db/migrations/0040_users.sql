-- Email and password users replace access tokens (ADR 0013, superseding the token parts of ADR
-- 0006). Everyone signs in again: tokens cannot be mapped to people. The admin from the log
-- (bootstrap) signs in as "admin" with the password the API prints on every start.
DELETE FROM workbench_pins;   -- owners were access token ids; now user ids
DROP TABLE sessions;
DROP TABLE access_tokens;

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
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

COMMENT ON TABLE users IS
  'People who sign in (ADR 0013). Hashes are scrypt; a one-time password is shown once.';
COMMENT ON COLUMN workbench_pins.owner IS 'user id, or ''local'' without access control';
