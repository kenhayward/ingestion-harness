-- Draft change log (Workbench tabs TP1): one row per change written to a draft's definition —
-- a hand save, an applied drafting proposal, a restored iteration, the draft's start or an
-- import. Rows only describe what changed; definitions stay in `templates`, whose published
-- rows remain immutable (0003's triggers are untouched). Append-only: rows are never updated,
-- and a deleted draft takes its rows with it. Read by the API only (the worker never reads it).
CREATE TABLE template_changes (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id  text        NOT NULL,
  version      integer     NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  source       text        NOT NULL
               CHECK (source IN ('hand', 'proposal', 'restore', 'started', 'import')),
  stage        text        CHECK (stage IN ('outputs', 'sections', 'steps', 'revise')),
  proposal_id  uuid,
  summary      text        NOT NULL,
  diff         jsonb       NOT NULL DEFAULT '[]',
  created_by   text,
  CHECK ((source = 'proposal') = (stage IS NOT NULL)),
  FOREIGN KEY (template_id, version) REFERENCES templates (id, version) ON DELETE CASCADE
);

CREATE INDEX template_changes_version ON template_changes (template_id, version, id DESC);
