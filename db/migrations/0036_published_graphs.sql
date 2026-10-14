-- ADR 0011 step 6: the graphs published to the triple store, one per original document (its
-- sha256) and document type, with a version per publish; the entities they minted (the seed of
-- a later IRI registry, safeguard 2); and the ontology versions loaded as TBox graphs.

-- The current version of each (sha256, type) graph.
CREATE TABLE published_graphs (
  sha256           text        NOT NULL,
  template_id      text        NOT NULL,
  graph_iri        text        NOT NULL,
  version          integer     NOT NULL CHECK (version > 0),
  job_id           uuid        NOT NULL,
  document_id      uuid        NOT NULL,
  template_version integer     NOT NULL,
  base_iri         text        NOT NULL,
  triples          integer     NOT NULL,
  published_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, template_id)
);
CREATE INDEX published_graphs_base_idx ON published_graphs (base_iri);
CREATE INDEX published_graphs_job_idx ON published_graphs (job_id);

-- Append-only: one row per publish. With the versioned Turtle copies in the target, a later
-- phase can offer history without re-rendering anything.
CREATE TABLE published_graph_versions (
  sha256           text        NOT NULL,
  template_id      text        NOT NULL,
  version          integer     NOT NULL,
  graph_iri        text        NOT NULL,
  job_id           uuid        NOT NULL,
  document_id      uuid        NOT NULL,
  template_version integer     NOT NULL,
  base_iri         text        NOT NULL,
  triples          integer     NOT NULL,
  published_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, template_id, version)
);
CREATE INDEX published_graph_versions_job_idx ON published_graph_versions (job_id);

-- Every minted entity IRI with the scoped key it was built from. No foreign keys to jobs or
-- documents: those are deleted on their own schedule, and withdrawal (step 7) removes these.
CREATE TABLE published_entities (
  iri                text        PRIMARY KEY,
  kind               text        NOT NULL,
  scoped_key         jsonb       NOT NULL,
  first_published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE published_entity_sources (
  iri         text NOT NULL REFERENCES published_entities (iri) ON DELETE CASCADE,
  sha256      text NOT NULL,
  template_id text NOT NULL,
  job_id      uuid NOT NULL,
  PRIMARY KEY (iri, sha256, template_id)
);
CREATE INDEX published_entity_sources_graph_idx ON published_entity_sources (sha256, template_id);

-- Ontology versions loaded into the store as TBox graphs, per base (a re-mint loads them again).
CREATE TABLE published_ontology_graphs (
  ontology_id text        NOT NULL,
  version     integer     NOT NULL,
  base_iri    text        NOT NULL,
  graph_iri   text        NOT NULL,
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, version, base_iri)
);
