-- Workbench phase 3a (ADR 0007): per-project data policy, the `draft` task, and proposals.

ALTER TABLE workbench_projects
  ADD COLUMN data_policy text NOT NULL DEFAULT 'local' CHECK (data_policy IN ('local', 'external')),
  ADD COLUMN data_policy_changed_at timestamptz,
  ADD COLUMN data_policy_changed_by text;

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft'));

-- One row per drafting run. The id is the draft job's id. Status is derived from that job
-- until the user decides; the body lives in the runs bucket (drafting/{project}/{job}.json).
CREATE TABLE workbench_proposals (
  id             uuid        PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  project_id     text        NOT NULL REFERENCES workbench_projects (id),
  stage          text        NOT NULL CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references')),
  brief_version  integer,
  decision       text        CHECK (decision IN ('accepted', 'rejected')),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_proposals_project_idx ON workbench_proposals (project_id, created_at DESC);
