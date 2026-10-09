-- Core schema. Migrations are forward-only, applied in filename order by
-- apps/api/src/db/migrate.ts (also run by the `migrate` compose service).

CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'needs_review');

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text        NOT NULL,
  sha256        text        NOT NULL,
  size_bytes    bigint      NOT NULL,
  spec_id       text        NOT NULL,
  spec_version  integer     NOT NULL,
  bucket        text        NOT NULL,
  object_key    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_sha256_idx ON documents (sha256);

-- Queue table: the worker claims rows with SELECT ... FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  status          job_status  NOT NULL DEFAULT 'queued',
  model_override  text,
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 3,
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_at       timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (run_after) WHERE status = 'queued';
CREATE INDEX jobs_document_idx ON jobs (document_id);

CREATE TABLE job_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  level       text        NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message     text        NOT NULL,
  data        jsonb
);
CREATE INDEX job_events_job_idx ON job_events (job_id, at);

CREATE TABLE job_outputs (
  id          bigserial PRIMARY KEY,
  job_id      uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  output_id   text        NOT NULL,
  format      text        NOT NULL CHECK (format IN ('csv', 'json')),
  bucket      text        NOT NULL,
  object_key  text        NOT NULL,
  row_count   integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, output_id)
);

-- Populated by worker model discovery; read by the API for the model picker.
CREATE TABLE llm_models (
  provider       text        NOT NULL,
  provider_kind  text        NOT NULL,
  model_id       text        NOT NULL,
  display_name   text,
  enabled        boolean     NOT NULL DEFAULT true,
  discovered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_id)
);
