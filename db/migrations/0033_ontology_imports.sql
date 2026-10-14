-- Ontology library, rollout step 2 (ADR 0011): versions imported by URL or pulled in by
-- owl:imports, and terms indexed from a version's imports.
ALTER TABLE ontology_versions
  ADD COLUMN source_kind text NOT NULL DEFAULT 'upload'
    CHECK (source_kind IN ('upload', 'url', 'import')),
  ADD COLUMN source_url text,
  -- The owl:imports IRI a version was created for (source_kind = 'import'): later imports of
  -- the same IRI find it even when the file declares another ontology IRI.
  ADD COLUMN import_iri text,
  -- A URL version has no bytes until the worker fetches them.
  ALTER COLUMN sha256 DROP NOT NULL,
  ALTER COLUMN bytes DROP NOT NULL;

-- "<ontologyId>@<version>" for a term indexed from an import; NULL for the version's own.
ALTER TABLE ontology_terms ADD COLUMN defined_in text;
