-- Workbench phase 5a (ADR 0007): the publish gate's threshold and the publication log.

ALTER TABLE workbench_projects
  ADD COLUMN publish_threshold numeric NOT NULL DEFAULT 0.9
    CHECK (publish_threshold >= 0 AND publish_threshold <= 1);

CREATE TABLE workbench_publications (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       text        NOT NULL REFERENCES workbench_projects (id),
  version          integer     NOT NULL,
  iteration_id     uuid        REFERENCES workbench_iterations (id) ON DELETE SET NULL,
  score            numeric,
  threshold        numeric     NOT NULL,
  override_reason  text,
  published_by     text,
  published_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_publications_project_idx ON workbench_publications (project_id, published_at DESC);
