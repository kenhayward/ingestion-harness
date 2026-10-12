-- Workbench phase 3b (ADR 0007): per-change decisions, the draft a proposal was made against,
-- and stage skips. Stage state is derived from proposals and skips (packages/shared drafting.ts).

ALTER TABLE workbench_proposals DROP CONSTRAINT workbench_proposals_decision_check;
ALTER TABLE workbench_proposals ADD CONSTRAINT workbench_proposals_decision_check
  CHECK (decision IN ('accepted', 'partially_accepted', 'rejected'));

ALTER TABLE workbench_proposals
  ADD COLUMN accepted_changes integer[],
  ADD COLUMN base_version     integer,
  ADD COLUMN base_definition  jsonb;

CREATE TABLE workbench_stage_skips (
  id          bigserial   PRIMARY KEY,
  project_id  text        NOT NULL REFERENCES workbench_projects (id),
  stage       text        NOT NULL CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references')),
  skipped_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_stage_skips_project_idx ON workbench_stage_skips (project_id, skipped_at DESC);
