-- Workbench phase 1 (ADR 0007): projects, samples and briefs; the `prepare` task (text + OCR
-- only); queue priority so workbench work never delays production jobs.

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare'));

-- Higher runs first: production 0, workbench -10.
ALTER TABLE jobs ADD COLUMN priority smallint NOT NULL DEFAULT 0;
DROP INDEX jobs_claim_idx;
CREATE INDEX jobs_claim_idx ON jobs (priority DESC, run_after, created_at) WHERE status = 'queued';

-- One long-lived project per document type: id = template id.
CREATE TABLE workbench_projects (
  id          text        PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]*$'),
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ADD COLUMN project_id text REFERENCES workbench_projects (id);
CREATE INDEX jobs_project_idx ON jobs (project_id, created_at) WHERE project_id IS NOT NULL;

-- A sample is an ordinary document; its prepare job is the job on that document with
-- task = 'prepare'. Deleting jobs never deletes a document a sample still uses.
CREATE TABLE workbench_samples (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         text        NOT NULL REFERENCES workbench_projects (id),
  document_id        uuid        NOT NULL REFERENCES documents (id),
  role               text        NOT NULL DEFAULT 'dev' CHECK (role IN ('dev', 'holdout')),
  added_for_version  integer     NOT NULL CHECK (added_for_version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_id)
);

-- Append-only: every save is a new version.
CREATE TABLE workbench_briefs (
  project_id  text        NOT NULL REFERENCES workbench_projects (id),
  version     integer     NOT NULL CHECK (version > 0),
  body        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);
