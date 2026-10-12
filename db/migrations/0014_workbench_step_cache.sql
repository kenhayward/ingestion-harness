-- Workbench phase 4b (ADR 0007): step cache hits are recorded as step runs; iterations can be
-- grouped (model comparison) and forced to call the models again (uncached).

ALTER TABLE step_runs ADD COLUMN cached boolean NOT NULL DEFAULT false;

ALTER TABLE workbench_iterations
  ADD COLUMN group_id uuid,
  ADD COLUMN uncached boolean NOT NULL DEFAULT false;
CREATE INDEX workbench_iterations_group_idx ON workbench_iterations (group_id) WHERE group_id IS NOT NULL;
