-- Step-level history and re-running a single step from review.

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check CHECK (task IN ('process', 'publish', 'rerun'));
-- task = 'rerun': {"step": "<extract step id>", "model"?: "<provider/model>", "instructions"?: "..."}
ALTER TABLE jobs ADD COLUMN rerun jsonb;

CREATE TABLE step_runs (
  id             bigserial PRIMARY KEY,
  job_id         uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  step_id        text        NOT NULL,
  trigger        text        NOT NULL CHECK (trigger IN ('process', 'rerun')),
  model          text,
  attempts       integer     NOT NULL DEFAULT 0,
  input_tokens   integer,
  output_tokens  integer,
  status         text        NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error          text,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX step_runs_job_idx ON step_runs (job_id, id);
