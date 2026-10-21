-- Delivery bridge: one target registry. The bridge's targets (sink, instance, connection,
-- destination, label) are authoritative; `publish_targets` becomes CT Studio's cache of them, so
-- the five foreign keys to publish_targets(id) and the in-use guard keep a local row. It keeps
-- CT Studio's own facts: kind, source, seeded_at, edited_at, updated_by, created_at, inert_at.
-- The old S3 and credential columns are relaxed here, not dropped: the API, the worker and the
-- backup still read them until they read the cache (a later migration drops them).

-- 1. The cache's columns. `on_bridge`: the bridge still lists it. `synced_at`: when the cache
-- last took it from the bridge (NULL: not yet, so the worker waits).
ALTER TABLE publish_targets
  ADD COLUMN sink_id     text  NOT NULL DEFAULT 's3',
  ADD COLUMN instance_id text,
  ADD COLUMN destination jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN on_bridge   boolean NOT NULL DEFAULT true,
  ADD COLUMN synced_at   timestamptz;

-- 2. The backfill: exactly what the mirror (apps/api/src/bridge/mirror.ts, mirrorOf) sent the
-- bridge. S3 rows: the six destination fields, unset ones blank; internal ones on the built-in
-- `internal` connection. The triple store: its dataset, on its own connection. Only rows the
-- mirror had sent (created on the page, or seeded) count as synced; the unseeded `default` the
-- first migration inserted waits for the API's seed, which picks its kind and so its connection
-- (it keeps none until then).
UPDATE publish_targets
   SET sink_id = 'rdf',
       destination = jsonb_build_object('dataset', bucket),
       connection_id = 'rdf-default'
 WHERE kind = 'rdf';
UPDATE publish_targets
   SET sink_id = 's3',
       destination = jsonb_build_object(
         'bucket', bucket,
         'prefix', prefix,
         'sse', sse,
         'kmsKeyId', coalesce(kms_key_id, ''),
         'storageClass', coalesce(storage_class, ''),
         'layout', layout),
       connection_id = CASE WHEN kind = 'internal' AND (seeded_at IS NOT NULL OR source = 'ui')
                            THEN 'internal' ELSE connection_id END
 WHERE kind <> 'rdf';
UPDATE publish_targets SET synced_at = now() WHERE seeded_at IS NOT NULL OR source = 'ui';

-- `sink`: a target of any sink other than s3 and rdf (phase 6).
ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_kind_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_kind_check
  CHECK (kind IN ('internal', 'external', 'rdf', 'sink'));
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_destination_layout_check
  CHECK (coalesce(destination->>'layout', '') IN ('', 'files', 'package'));

-- The old columns: a cache row is written without them.
ALTER TABLE publish_targets
  ALTER COLUMN bucket DROP NOT NULL,
  ALTER COLUMN bucket SET DEFAULT '',
  ALTER COLUMN prefix DROP NOT NULL,
  ALTER COLUMN force_path_style DROP NOT NULL,
  ALTER COLUMN sse DROP NOT NULL,
  ALTER COLUMN layout DROP NOT NULL;

-- 3. Keys from before the bridge, until the one-off move takes them to a bridge connection: the
-- external rows not moved yet, and the env-keyed default (its keys are .env variable names).
-- The triple store's endpoint and writer user are not keys: its connection holds them.
-- A target removed takes its legacy keys with it (they are no use of the target).
CREATE TABLE publish_target_legacy_keys (
  id                 text        PRIMARY KEY REFERENCES publish_targets (id) ON DELETE CASCADE,
  endpoint           text,
  region             text,
  access_key_id      text,
  secret_key_enc     text,
  access_key_env     text,
  secret_key_env     text,
  force_path_style   boolean     NOT NULL DEFAULT false,
  moved_to_bridge_at timestamptz
);
INSERT INTO publish_target_legacy_keys
  (id, endpoint, region, access_key_id, secret_key_enc, access_key_env, secret_key_env,
   force_path_style, moved_to_bridge_at)
SELECT id, endpoint, region, access_key_id, secret_key_enc, access_key_env, secret_key_env,
       coalesce(force_path_style, false), moved_to_bridge_at
  FROM publish_targets
 WHERE kind <> 'rdf'
   AND ((kind = 'external' AND moved_to_bridge_at IS NULL)
        OR access_key_env IS NOT NULL OR secret_key_env IS NOT NULL);

-- 4. Where an S3 target writes, for SQL readers: one row for sink s3 (a blank layout is
-- `files`), none for any other sink.
CREATE FUNCTION target_s3_place(destination jsonb, sink_id text)
RETURNS TABLE (bucket text, prefix text, layout text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(destination->>'bucket', ''),
         coalesce(destination->>'prefix', ''),
         coalesce(nullif(destination->>'layout', ''), 'files')
   WHERE sink_id = 's3'
$$;
