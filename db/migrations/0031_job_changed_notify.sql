-- Live job streams (GET /api/jobs/:id/events): tell the API, which LISTENs on ih_job_changed,
-- whenever a job may look different: its row (status, attempts, edits...), a new event (progress)
-- or a step run (the Progress list's Extraction). Payload: the job id. Notifications are sent on
-- commit, and identical ones in a transaction are folded into one. The worker never listens.
CREATE FUNCTION jobs_notify_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ih_job_changed', NEW.id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify_changed AFTER UPDATE ON jobs
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION jobs_notify_changed();

CREATE FUNCTION job_children_notify_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ih_job_changed', NEW.job_id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_events_notify_changed AFTER INSERT ON job_events
  FOR EACH ROW EXECUTE FUNCTION job_children_notify_changed();

CREATE TRIGGER step_runs_notify_changed AFTER INSERT OR UPDATE ON step_runs
  FOR EACH ROW EXECUTE FUNCTION job_children_notify_changed();
