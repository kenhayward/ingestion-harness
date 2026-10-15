-- Ontology imports from a folder or zip (ADR 0011, ontology library): a version merged from many
-- files (source_kind 'files', its files listed in source_files; sha256 = the sha256 of the sorted
-- file hashes, so the same folder is a duplicate), and every owl:Ontology IRI a version declares,
-- so an import of any module of a merged version finds it.
ALTER TABLE ontology_versions DROP CONSTRAINT ontology_versions_source_kind_check;
ALTER TABLE ontology_versions ADD CONSTRAINT ontology_versions_source_kind_check
  CHECK (source_kind IN ('upload', 'url', 'import', 'files'));

-- [{ "fileName", "sha256", "bytes", "mediaType" }] for a 'files' version; NULL otherwise.
ALTER TABLE ontology_versions ADD COLUMN source_files jsonb;

ALTER TABLE ontology_versions ADD COLUMN ontology_iris text[] NOT NULL DEFAULT '{}';
UPDATE ontology_versions SET ontology_iris = ARRAY[ontology_iri] WHERE ontology_iri IS NOT NULL;
CREATE INDEX ontology_versions_iris_idx ON ontology_versions USING gin (ontology_iris);
