-- Workbench phase 4a (ADR 0007): one row per evaluation run of the draft. The scorecard is
-- computed from the jobs; `scores` caches the summary once every job has finished.

CREATE TABLE workbench_iterations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        text        NOT NULL REFERENCES workbench_projects (id),
  template_version  integer     NOT NULL,
  definition        jsonb       NOT NULL,
  brief_version     integer,
  eval_set          text        NOT NULL DEFAULT 'dev' CHECK (eval_set IN ('dev', 'holdout')),
  model             text,
  job_ids           uuid[]      NOT NULL,
  scores            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_iterations_project_idx ON workbench_iterations (project_id, created_at DESC);
