-- Linked data (ADR 0011, rollout step 3): the deployment's customer and the base IRI its RDF is
-- minted under, the history of base changes, RDF outputs, and graph preview jobs.
CREATE TABLE linked_data_settings (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  customer_name text NOT NULL DEFAULT '',
  customer_slug text CHECK (customer_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  -- NULL: https://id.stocks-hayward.com/<customer_slug>/
  base_iri      text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only: one row per change of the effective base.
CREATE TABLE linked_data_base_history (
  id            bigserial PRIMARY KEY,
  from_base     text,
  to_base       text,
  changed_by    text,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  rdf_published integer NOT NULL DEFAULT 0
);

ALTER TABLE job_outputs DROP CONSTRAINT job_outputs_format_check;
ALTER TABLE job_outputs ADD CONSTRAINT job_outputs_format_check
  CHECK (format IN ('csv', 'json', 'rdf'));

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology', 'graph'));
