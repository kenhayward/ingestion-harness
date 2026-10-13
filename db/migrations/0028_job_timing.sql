-- Test runs tab (Workbench tabs handoff TR2): when a job's extraction last started and finished.
-- Set by the database, so the worker is unchanged and never reads them. Only `process` runs are
-- timed: approving (task `publish`) and step re-runs (task `rerun`) reuse the row and must keep
-- the extraction's times. A claim sets started_at and clears finished_at; leaving `running`
-- (done, review, failure, cancel, reaped lock) sets finished_at.
ALTER TABLE jobs ADD COLUMN started_at timestamptz;
ALTER TABLE jobs ADD COLUMN finished_at timestamptz;

CREATE FUNCTION jobs_timing() RETURNS trigger AS $$
BEGIN
  IF NEW.task = 'process' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'running' THEN
      NEW.started_at := now();
      NEW.finished_at := NULL;
    ELSIF OLD.status = 'running' THEN
      NEW.finished_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_timing BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_timing();

-- The queue estimate (GET /api/queue/summary) reads recently finished, timed runs.
CREATE INDEX jobs_finished_idx ON jobs (finished_at DESC) WHERE finished_at IS NOT NULL;

-- queueStats counts running jobs on every poll of an open Test runs tab.
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (id) WHERE status = 'running';
