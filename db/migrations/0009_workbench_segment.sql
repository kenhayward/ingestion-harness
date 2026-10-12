-- Workbench phase 2 (ADR 0007): project-scoped jobs without a document (the `segment` task),
-- task parameters, and a NOTIFY so the worker wakes as soon as a job is queued.

ALTER TABLE jobs ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE jobs ADD CONSTRAINT jobs_document_or_project
  CHECK (document_id IS NOT NULL OR project_id IS NOT NULL);

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment'));

-- Task parameters (segment: candidate sections/copies/pageMarkers and the samples to apply them to).
ALTER TABLE jobs ADD COLUMN params jsonb;

-- Wake idle workers immediately (worker: LISTEN ih_jobs). Payload: the job id.
CREATE FUNCTION jobs_notify_queued() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ih_jobs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify_queued AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW WHEN (NEW.status = 'queued') EXECUTE FUNCTION jobs_notify_queued();
