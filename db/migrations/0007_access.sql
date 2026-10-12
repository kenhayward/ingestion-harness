-- Access tokens (the admin token is rotated on every API start; user tokens are issued in-app)
-- and the browser sessions they open. Only SHA-256 hashes are stored. See ADR 0006.
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
