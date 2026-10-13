-- Workbench follow-ups: who last changed the publish threshold, and a per-iteration cache of the
-- publish gate's raw holdout scores (keyed by a fingerprint of the iteration's jobs).
ALTER TABLE workbench_projects
  ADD COLUMN threshold_set_by text,
  ADD COLUMN threshold_set_at timestamptz;
ALTER TABLE workbench_iterations ADD COLUMN gate_cache jsonb;
