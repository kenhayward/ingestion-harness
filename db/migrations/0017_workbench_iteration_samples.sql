-- Workbench phase 5a (ADR 0007): the samples an evaluation ran, by PDF sha256, recorded when the
-- iteration is created. Holdout history and the publish gate's coverage read it, so they survive
-- the iteration's jobs being deleted. Null for iterations created before this migration (callers
-- fall back to the jobs' documents).

ALTER TABLE workbench_iterations ADD COLUMN sample_shas text[];
