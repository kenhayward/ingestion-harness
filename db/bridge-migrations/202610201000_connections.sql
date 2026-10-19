-- Connections: credentials for one sink instance, shared (admins) or personal (one user).
-- The secret is AES-256-GCM under BRIDGE_SECRETS_KEY (secret_enc), or read from the bridge's
-- environment variable secret_env (an allowlisted name); fields hold the non-secret values.
CREATE TABLE connections (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  kind          text NOT NULL CHECK (kind IN ('shared', 'personal')),
  owner         text,
  sink_id       text NOT NULL,
  instance_id   text,
  name          text NOT NULL,
  fields        jsonb NOT NULL DEFAULT '{}',
  secret_enc    text,
  secret_env    text,
  status        text NOT NULL DEFAULT 'untested'
                  CHECK (status IN ('ok', 'needs_attention', 'untested')),
  status_reason text,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (owner IS NOT NULL))
);

-- A shared sink's target names the connection it delivers with.
ALTER TABLE targets ADD COLUMN connection_id text REFERENCES connections (id);
