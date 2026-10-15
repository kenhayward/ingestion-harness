-- Ontology suggestions (ADR 0011 follow-up): the Survey tab's Refresh queues a project-scoped
-- `suggest` job (no document, like segment and graph previews) that writes
-- ontology-suggestions/{project}/{job}.json to the runs bucket.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology', 'graph', 'embed', 'withdraw', 'republish', 'suggest'));

-- Suggestions look every candidate up in the whole library: the synonyms need a trigram index
-- like the labels (0032). array_to_string is only STABLE, so an IMMUTABLE wrapper (safe for
-- text[]) makes the expression indexable; queries call the same function.
CREATE FUNCTION ih_alt_labels_text(labels text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT lower(array_to_string(labels, ' ')) $$;
CREATE INDEX ontology_terms_alt_labels_trgm ON ontology_terms
  USING gin (ih_alt_labels_text(alt_labels) gin_trgm_ops);
