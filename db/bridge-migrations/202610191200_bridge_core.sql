-- The delivery bridge's own tables (docs/superpowers/specs/2026-10-19-delivery-bridge-design.md).
-- Applied with search_path = bridge by apps/bridge/src/db/migrate.ts; CT Studio never reads them.

-- Named recipients: which sink, which instance, and where in it.
CREATE TABLE targets (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  sink_id     text NOT NULL,
  instance_id text,
  destination jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One document's publication; the bytes are staged in the package store at staged_key.
CREATE TABLE packages (
  id              uuid PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('document', 'graph')),
  idempotency_key text NOT NULL,
  manifest        jsonb NOT NULL,
  staged_key      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz
);

-- One package to one target. A claim leases the row until lease_until.
CREATE TABLE deliveries (
  id              uuid PRIMARY KEY,
  package_id      uuid NOT NULL REFERENCES packages (id),
  target_id       text NOT NULL REFERENCES targets (id),
  idempotency_key text NOT NULL,
  acting_user     jsonb,
  overrides       jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL CHECK (status IN
                    ('queued', 'running', 'waiting', 'succeeded', 'skipped', 'needs_user', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  run_after       timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  sink_job_id     text,
  error           jsonb,
  receipt         jsonb,
  skipped_for     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_claim ON deliveries (run_after) WHERE status IN ('queued', 'waiting', 'running');
CREATE INDEX deliveries_key ON deliveries (target_id, idempotency_key, status);

-- Outbox: written with each status change, sent to the producer by the dispatcher.
CREATE TABLE events (
  id          uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries (id),
  sequence    int NOT NULL,
  body        jsonb NOT NULL,
  sent_at     timestamptz,
  attempts    int NOT NULL DEFAULT 0,
  run_after   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, sequence)
);
CREATE INDEX events_due ON events (run_after) WHERE sent_at IS NULL;
