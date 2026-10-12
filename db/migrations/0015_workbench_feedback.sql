-- Workbench phase 4c (ADR 0007): user feedback on outputs, steps and sections, and the
-- `revise` drafting stage that answers it.

CREATE TABLE workbench_feedback (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    text        NOT NULL REFERENCES workbench_projects (id),
  target        text        NOT NULL CHECK (target IN ('field', 'table', 'step', 'section')),
  target_id     text        NOT NULL,
  sample_id     uuid,
  iteration_id  uuid        REFERENCES workbench_iterations (id) ON DELETE SET NULL,
  body          text        NOT NULL,
  resolved_by   uuid        REFERENCES workbench_proposals (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_feedback_project_idx ON workbench_feedback (project_id, created_at DESC);

ALTER TABLE workbench_proposals ADD COLUMN feedback_ids uuid[];

ALTER TABLE workbench_proposals DROP CONSTRAINT workbench_proposals_stage_check;
ALTER TABLE workbench_proposals ADD CONSTRAINT workbench_proposals_stage_check
  CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references', 'revise'));
