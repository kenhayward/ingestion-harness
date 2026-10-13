-- Workbench tabs (handoff SC1): "Keep" on a stale drafting stage. A confirmation acknowledges the
-- earlier stages' completions up to `up_to`; stage state stays derived (packages/shared
-- drafting.ts stageStates). The stage list matches KEEPABLE_STAGES.
CREATE TABLE workbench_stage_confirms (
  id            bigserial   PRIMARY KEY,
  project_id    text        NOT NULL REFERENCES workbench_projects (id) ON DELETE CASCADE,
  stage         text        NOT NULL CHECK (stage IN ('outputs', 'sections', 'steps')),
  up_to         timestamptz NOT NULL,
  confirmed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_stage_confirms_project_idx
  ON workbench_stage_confirms (project_id, confirmed_at DESC);
