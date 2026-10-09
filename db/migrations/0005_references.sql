-- Reference documents per document type (approved values = expected result) and regression
-- runs: test jobs of a template version linked to the reference they re-run.

CREATE TABLE template_references (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    text        NOT NULL,
  name           text        NOT NULL,
  document_id    uuid        NOT NULL REFERENCES documents (id),
  source_job_id  uuid        REFERENCES jobs (id) ON DELETE SET NULL,
  expected       jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, name)
);

ALTER TABLE jobs ADD COLUMN reference_id uuid REFERENCES template_references (id) ON DELETE SET NULL;
CREATE INDEX jobs_reference_idx ON jobs (reference_id) WHERE reference_id IS NOT NULL;
