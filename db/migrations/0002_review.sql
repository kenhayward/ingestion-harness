-- Review workflow: documents needing review wait in awaiting_review; approval re-queues the job
-- as a publish task (edits applied, outputs delivered to the final target); rejection is final.
-- (ADD VALUE inside a transaction is fine on PG >= 12 as long as the value isn't used in it.)

ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'awaiting_review';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'rejected';

ALTER TABLE jobs
  ADD COLUMN task           text NOT NULL DEFAULT 'process' CHECK (task IN ('process', 'publish')),
  ADD COLUMN review_reasons jsonb,
  ADD COLUMN reviewer       text,
  ADD COLUMN review_note    text,
  ADD COLUMN reviewed_at    timestamptz;

-- Outputs are recorded per stage: the draft (outputs bucket) and the published copy (target).
ALTER TABLE job_outputs
  ADD COLUMN stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'published'));
ALTER TABLE job_outputs DROP CONSTRAINT job_outputs_job_id_output_id_key;
ALTER TABLE job_outputs ADD CONSTRAINT job_outputs_job_output_stage_key UNIQUE (job_id, output_id, stage);

-- Append-only audit of reviewer edits; the worker applies them in id order when publishing.
CREATE TABLE review_edits (
  id          bigserial PRIMARY KEY,
  job_id      uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  field_id    text,
  table_id    text,
  row_number  integer,
  column_id   text,
  old_value   jsonb,
  new_value   jsonb,
  editor      text,
  reason      text,
  CHECK ((field_id IS NOT NULL) <> (table_id IS NOT NULL)),
  CHECK (table_id IS NULL OR (row_number >= 1 AND column_id IS NOT NULL))
);
CREATE INDEX review_edits_job_idx ON review_edits (job_id, id);
