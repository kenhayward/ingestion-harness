-- Delivery bridge phase 2: publishing goes through the bridge. A job whose package the bridge
-- accepted waits in `delivering` until every delivery is final; the bridge's signed events
-- (and the API's reconcile) record each delivery here and finish the job.
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'delivering';

-- The bridge delivery that wrote a published output (null: delivered before the bridge).
ALTER TABLE job_outputs ADD COLUMN delivery_id uuid;

CREATE TABLE job_deliveries (
  delivery_id   uuid PRIMARY KEY,
  job_id        uuid NOT NULL REFERENCES jobs ON DELETE CASCADE,
  target_id     text NOT NULL REFERENCES publish_targets (id),
  status        text NOT NULL,
  error         jsonb,
  receipt       jsonb,
  -- The newest event applied: older or repeated events change nothing.
  last_sequence int  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_deliveries_job ON job_deliveries (job_id);
