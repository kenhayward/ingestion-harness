-- Watched folders (plan 3): an admin points CT Studio at a sink's folder; the worker picks files
-- up from its root and runs them through conversion batches. A watch owns one long-lived batch.
CREATE TABLE watched_folders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  target_id        text NOT NULL REFERENCES publish_targets (id),
  -- The sink's source fields as entered ({field id: value}) and the path they make.
  source           jsonb NOT NULL,
  source_path      text NOT NULL,
  -- The acting user the watch delivers as: {id, name, email}.
  run_as           jsonb NOT NULL,
  force            boolean NOT NULL DEFAULT false,
  auto_approve     boolean NOT NULL DEFAULT true,
  reason_files     boolean NOT NULL DEFAULT true,
  sleep_seconds    integer NOT NULL DEFAULT 30 CHECK (sleep_seconds BETWEEN 10 AND 3600),
  admit            integer NOT NULL DEFAULT 10 CHECK (admit BETWEEN 1 AND 100),
  state            text NOT NULL DEFAULT 'stopped' CHECK (state IN ('running', 'draining', 'stopped')),
  batch_id         uuid REFERENCES decomposition_batches (id) ON DELETE SET NULL,
  problem          text,
  root_waiting     integer NOT NULL DEFAULT 0,
  next_look_at     timestamptz NOT NULL DEFAULT now(),
  last_look_at     timestamptz,
  last_pickup_at   timestamptz,
  total_delivered  bigint NOT NULL DEFAULT 0,
  total_failed     bigint NOT NULL DEFAULT 0,
  created_by       jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Names are unique whatever the case.
CREATE UNIQUE INDEX watched_folders_name_idx ON watched_folders (lower(name));

-- One file seen in the folder root, and how far it got.
CREATE TABLE watch_pickups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id       uuid NOT NULL REFERENCES watched_folders (id) ON DELETE CASCADE,
  original_name  text NOT NULL,
  size           bigint NOT NULL,
  modified_at    timestamptz NOT NULL,
  etag           text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  step           text NOT NULL DEFAULT 'seen'
                 CHECK (step IN ('seen', 'stored', 'moved', 'queued', 'refusing', 'finished',
                                 'abandoned')),
  working_name   text,
  item_id        uuid,
  object_key     text,
  -- Moves the sink refused (not an outage): after five the worker stops trying this pickup and
  -- the watch shows a problem.
  move_failures  integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watch_id, original_name, size, modified_at)
);

-- One row per file that reached a final outcome: the throughput figures count these.
CREATE TABLE watch_finishes (
  watch_id     uuid NOT NULL REFERENCES watched_folders (id) ON DELETE CASCADE,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  delivered    boolean NOT NULL
);
CREATE INDEX watch_finishes_idx ON watch_finishes (watch_id, finished_at);

CREATE TABLE watch_events (
  id        bigserial PRIMARY KEY,
  watch_id  uuid NOT NULL REFERENCES watched_folders (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  level     text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message   text NOT NULL,
  details   jsonb
);
CREATE INDEX watch_events_idx ON watch_events (watch_id, id DESC);

ALTER TABLE decomposition_batches
  ADD COLUMN watch_id uuid REFERENCES watched_folders (id) ON DELETE SET NULL;

-- A watched file is picked up again under the same source key after it changes, so the
-- (batch, source key) uniqueness holds for uploaded items only.
ALTER TABLE decomposition_items ADD COLUMN watched boolean NOT NULL DEFAULT false;
DO $$
DECLARE c text;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'decomposition_items'::regclass
     AND con.contype = 'u'
     AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
            FROM pg_attribute att
           WHERE att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey))
         = ARRAY['batch_id', 'source_key'];
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE decomposition_items DROP CONSTRAINT %I', c);
  END IF;
END $$;
CREATE UNIQUE INDEX decomposition_items_batch_source_idx
  ON decomposition_items (batch_id, source_key) WHERE NOT watched;

-- A refused watched file was never stored.
ALTER TABLE decomposition_items ALTER COLUMN object_key DROP NOT NULL;
