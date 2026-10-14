-- Ontology library (ADR 0011, docs/design/rdf-publishing.md): admin-imported OWL/RDFS, SKOS and
-- SHACL files, one immutable row per imported version, and the terms the worker indexed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE ontologies (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  label       text NOT NULL CHECK (length(trim(label)) > 0),
  description text NOT NULL DEFAULT '',
  tags        text[] NOT NULL DEFAULT '{}',
  local_only  boolean NOT NULL DEFAULT false,
  retired_at  timestamptz,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ontology_versions (
  ontology_id  text NOT NULL REFERENCES ontologies (id) ON DELETE CASCADE,
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'parsing', 'ready', 'failed')),
  file_name    text NOT NULL,
  media_type   text NOT NULL,
  sha256       text NOT NULL,
  bytes        bigint NOT NULL,
  ontology_iri text,
  version_iri  text,
  license      text,
  kinds        text[] NOT NULL DEFAULT '{}',
  stats        jsonb,
  imports      jsonb NOT NULL DEFAULT '[]',
  error        text,
  job_id       uuid REFERENCES jobs (id) ON DELETE SET NULL,
  imported_by  text,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, version),
  UNIQUE (ontology_id, sha256)
);

CREATE TABLE ontology_terms (
  ontology_id text NOT NULL,
  version     integer NOT NULL,
  iri         text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('class', 'object_property', 'datatype_property',
                'annotation_property', 'concept', 'scheme', 'shape')),
  label       text NOT NULL,
  alt_labels  text[] NOT NULL DEFAULT '{}',
  definition  text NOT NULL DEFAULT '',
  parents     text[] NOT NULL DEFAULT '{}',
  domains     text[] NOT NULL DEFAULT '{}',
  ranges      text[] NOT NULL DEFAULT '{}',
  scheme      text,
  deprecated  boolean NOT NULL DEFAULT false,
  -- Computed by the worker: no parent in its group, or unreachable from one (cycles).
  root        boolean NOT NULL DEFAULT false,
  child_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ontology_id, version, kind, iri),
  FOREIGN KEY (ontology_id, version)
    REFERENCES ontology_versions (ontology_id, version) ON DELETE CASCADE
);
CREATE INDEX ontology_terms_label_trgm ON ontology_terms USING gin (lower(label) gin_trgm_ops);
CREATE INDEX ontology_terms_parents ON ontology_terms USING gin (parents);
CREATE INDEX ontology_terms_iri ON ontology_terms (ontology_id, version, iri);

-- A ready version is immutable: its terms were indexed from exactly these bytes.
CREATE FUNCTION ontology_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'ontology % version % is ready and cannot change', OLD.ontology_id, OLD.version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ontology_versions_immutable BEFORE UPDATE ON ontology_versions
  FOR EACH ROW EXECUTE FUNCTION ontology_versions_immutable();

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology'));
