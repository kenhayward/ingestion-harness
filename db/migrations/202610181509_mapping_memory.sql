-- Mapping memory (docs/design/mapping-memory.md): the ontology mappings designers accepted,
-- deployment-wide, offered again by the Workbench mapping stage for outputs that look the same.
-- One entry per signature (what the output looks like) and answer (what was accepted); one vote
-- per recipe and output (the recipe's newest version), refusals when a designer chose otherwise,
-- and reviews made on the Ontologies page. Never anything from a document: recipe structure only.
CREATE TABLE mapping_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('document', 'field', 'column', 'table')),
  -- signatureOf (packages/shared/src/mapping-memory.ts) / signature_of (worker); value-node
  -- defaults are keyed `defaults|<ontology ids>`.
  signature_key text NOT NULL,
  -- The wording it was first accepted for (each vote keeps its own).
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  -- RememberedAnswerSchema: the form and its terms, full IRIs; answer_key = its stable JSON.
  answer jsonb NOT NULL,
  answer_key text NOT NULL,
  ontologies text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'learned' CHECK (status IN ('learned', 'confirmed', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  note text,
  -- Reviewed or added from a project that allows external models (its wording may be sent).
  reviewed_external boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signature_key, answer_key)
);
CREATE INDEX mapping_memory_ontologies_idx ON mapping_memory USING gin (ontologies);

-- One vote per recipe and output: the answer its newest version (open draft, else latest
-- published) gives. Replaced whenever a designer writes the recipe; imports do not vote.
CREATE TABLE mapping_memory_votes (
  template_id text NOT NULL,
  output_path text NOT NULL,
  entry_id uuid NOT NULL REFERENCES mapping_memory (id) ON DELETE CASCADE,
  version int NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  table_name text,
  -- The recipe's project allows external models (no project: false).
  external boolean NOT NULL DEFAULT false,
  -- The remembered entry this output was pre-selected from, when it was.
  origin_entry_id uuid REFERENCES mapping_memory (id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, output_path)
);
CREATE INDEX mapping_memory_votes_entry_idx ON mapping_memory_votes (entry_id);

-- A recipe where a designer chose otherwise when the entry was offered or pre-selected.
CREATE TABLE mapping_memory_refusals (
  entry_id uuid NOT NULL REFERENCES mapping_memory (id) ON DELETE CASCADE,
  template_id text NOT NULL,
  output_path text NOT NULL,
  by text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, template_id, output_path)
);

-- Signature embeddings per embedding model, computed lazily by the worker (the API makes no
-- model calls); compared in the worker, so a plain array, whatever the model's dimensions.
CREATE TABLE mapping_memory_embeddings (
  entry_id uuid NOT NULL REFERENCES mapping_memory (id) ON DELETE CASCADE,
  model text NOT NULL,
  embedding real[] NOT NULL,
  PRIMARY KEY (entry_id, model)
);
