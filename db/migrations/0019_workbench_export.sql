-- Workbench phase 6: the `export` task builds a project's drafting bundle (document-less, like
-- `draft`); the zip lives at exports/{project}/{job}.zip in the runs bucket.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export'));
