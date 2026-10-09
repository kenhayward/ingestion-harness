-- Document templates stored in the database (source of truth; YAML import/export).
-- Drafts are editable; published versions are immutable (enforced below) and jobs pin a version.

CREATE TABLE templates (
  id            text        NOT NULL CHECK (id ~ '^[a-z][a-z0-9_-]*$'),
  version       integer     NOT NULL CHECK (version > 0),
  status        text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  definition    jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  PRIMARY KEY (id, version)
);

CREATE FUNCTION templates_published_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' AND (NEW.definition IS DISTINCT FROM OLD.definition
                                   OR NEW.status <> 'published') THEN
    RAISE EXCEPTION 'template %/v% is published and cannot be changed', OLD.id, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER templates_immutable BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION templates_published_immutable();

CREATE FUNCTION templates_no_delete_published() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'template %/v% is published and cannot be deleted', OLD.id, OLD.version;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER templates_no_delete BEFORE DELETE ON templates
  FOR EACH ROW EXECUTE FUNCTION templates_no_delete_published();

-- Test runs of (draft) templates: processed and reviewable, never published.
ALTER TABLE jobs ADD COLUMN test boolean NOT NULL DEFAULT false;
