-- Publishing targets: admin-managed S3 destinations for published outputs, replacing the single
-- TARGET_S3_* publish target of .env. A recipe names one with delivery.publishTo (absent =
-- 'default'). The 'default' row is inserted here so the foreign keys below hold before the first
-- start; the API and the worker seed it from .env on that start (seeded_at NULL until then).

CREATE TABLE publish_targets (
  id               text        PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  label            text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('internal', 'external')),
  bucket           text        NOT NULL,
  prefix           text        NOT NULL DEFAULT '',
  endpoint         text,
  region           text,
  -- Credentials: stored (AES-256-GCM under LLM_SECRETS_KEY, as for LLM endpoints) or the names of
  -- .env variables to read them from (the seeded default).
  access_key_id    text,
  secret_key_enc   text,
  access_key_env   text,
  secret_key_env   text,
  force_path_style boolean     NOT NULL DEFAULT false,
  sse              text        NOT NULL DEFAULT 'none' CHECK (sse IN ('none', 'AES256', 'aws:kms')),
  kms_key_id       text,
  storage_class    text,
  source           text        NOT NULL DEFAULT 'ui' CHECK (source IN ('env', 'ui')),
  seeded_at        timestamptz,
  edited_at        timestamptz,
  updated_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO publish_targets (id, label, kind, bucket, source)
VALUES ('default', 'Default', 'internal', 'ingest-published', 'env');

-- One row that moves on every change, so the API and the worker rebuild their stores.
CREATE TABLE publish_targets_state (
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO publish_targets_state (version) VALUES (0);

CREATE FUNCTION publish_targets_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE publish_targets_state SET version = version + 1;
  PERFORM pg_notify('ih_publish_targets', '');
  RETURN NULL;
END $$;

CREATE TRIGGER publish_targets_bump AFTER INSERT OR UPDATE OR DELETE ON publish_targets
  FOR EACH STATEMENT EXECUTE FUNCTION publish_targets_bump();

-- Where each published output was written, so it is read and withdrawn through its own target.
ALTER TABLE job_outputs ADD COLUMN target_id text REFERENCES publish_targets (id);
UPDATE job_outputs SET target_id = 'default' WHERE stage = 'published';
ALTER TABLE job_outputs ADD CONSTRAINT job_outputs_target_check
  CHECK (stage = 'draft' OR target_id IS NOT NULL) NOT VALID;
ALTER TABLE job_outputs VALIDATE CONSTRAINT job_outputs_target_check;

ALTER TABLE published_graph_versions
  ADD COLUMN target_id text NOT NULL DEFAULT 'default' REFERENCES publish_targets (id);
ALTER TABLE published_graphs
  ADD COLUMN target_id text NOT NULL DEFAULT 'default' REFERENCES publish_targets (id);

-- Which targets each S3 key consumer (ADR 0008) may read; existing consumers keep the default.
CREATE TABLE s3_consumer_targets (
  consumer_id uuid NOT NULL REFERENCES s3_consumers (id) ON DELETE CASCADE,
  target_id   text NOT NULL REFERENCES publish_targets (id),
  PRIMARY KEY (consumer_id, target_id)
);
INSERT INTO s3_consumer_targets (consumer_id, target_id) SELECT id, 'default' FROM s3_consumers;

-- Withdraw jobs the old API queued name no target (every published output went to the one
-- target of .env, now 'default'), and the worker's params are strict: carry them over, so a
-- withdrawal pending at upgrade (or one an operator retries later) still runs. Finished ones are
-- history and stay as they ran.
UPDATE jobs
   SET params = jsonb_build_object(
         'objects', coalesce((SELECT jsonb_agg('{"target": "default"}'::jsonb || e ORDER BY n)
                                FROM jsonb_array_elements(params->'objects') WITH ORDINALITY o(e, n)),
                             '[]'::jsonb),
         'graphs', coalesce((SELECT jsonb_agg('{"target": "default"}'::jsonb || e ORDER BY n)
                               FROM jsonb_array_elements(params->'graphs') WITH ORDINALITY g(e, n)),
                            '[]'::jsonb))
 WHERE task = 'withdraw' AND status <> 'succeeded';
