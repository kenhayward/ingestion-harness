-- ADR 0011 step 4: the Workbench `mapping` stage, ontology term embeddings (pgvector) and the
-- `embed` job that writes them, and the `embedding_model` pipeline setting.

-- pgvector ships in deploy/docker/postgres.Dockerfile (postgres:17-alpine + pgvector).
CREATE EXTENSION IF NOT EXISTS vector;

-- One vector per term, embedding model and text: unchanged text is never embedded again.
-- Dimensions vary by model (`dims`); each model gets its own HNSW expression index, created by
-- the worker when it first stores that model's vectors.
CREATE TABLE ontology_term_embeddings (
  ontology_id  text        NOT NULL,
  version      integer     NOT NULL,
  kind         text        NOT NULL,
  iri          text        NOT NULL,
  model_ref    text        NOT NULL,
  dims         integer     NOT NULL CHECK (dims > 0),
  text_sha256  text        NOT NULL,
  embedding    vector      NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, version, kind, iri, model_ref),
  FOREIGN KEY (ontology_id, version, kind, iri)
    REFERENCES ontology_terms (ontology_id, version, kind, iri) ON DELETE CASCADE
);
CREATE INDEX ontology_term_embeddings_model ON ontology_term_embeddings
  (ontology_id, version, model_ref);

ALTER TABLE llm_settings DROP CONSTRAINT llm_settings_name_check;
ALTER TABLE llm_settings ADD CONSTRAINT llm_settings_name_check
  CHECK (name IN ('default_choice', 'drafting_model', 'ocr_model', 'embedding_model'));

-- `embed`: embed a ready ontology version's terms (document- and project-less, like `ontology`).
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology', 'graph', 'embed'));
ALTER TABLE jobs DROP CONSTRAINT jobs_document_or_project;
ALTER TABLE jobs ADD CONSTRAINT jobs_document_or_project
  CHECK (document_id IS NOT NULL OR project_id IS NOT NULL OR task IN ('ontology', 'embed'));

-- The `mapping` drafting stage.
ALTER TABLE workbench_proposals DROP CONSTRAINT workbench_proposals_stage_check;
ALTER TABLE workbench_proposals ADD CONSTRAINT workbench_proposals_stage_check
  CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references', 'revise', 'mapping'));
ALTER TABLE workbench_stage_skips DROP CONSTRAINT workbench_stage_skips_stage_check;
ALTER TABLE workbench_stage_skips ADD CONSTRAINT workbench_stage_skips_stage_check
  CHECK (stage IN ('survey', 'outputs', 'sections', 'steps', 'references', 'mapping'));
ALTER TABLE workbench_stage_confirms DROP CONSTRAINT workbench_stage_confirms_stage_check;
ALTER TABLE workbench_stage_confirms ADD CONSTRAINT workbench_stage_confirms_stage_check
  CHECK (stage IN ('outputs', 'sections', 'steps', 'mapping'));
ALTER TABLE template_changes DROP CONSTRAINT template_changes_stage_check;
ALTER TABLE template_changes ADD CONSTRAINT template_changes_stage_check
  CHECK (stage IN ('outputs', 'sections', 'steps', 'revise', 'mapping'));
