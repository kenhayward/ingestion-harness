-- Model choices and pipeline settings replace the aliases (ADR 0010, phase 4b). People pick a
-- labelled choice ("Main Production Model"); templates and jobs store its id. One choice is the
-- default (settings.default_choice), used by template steps that name none. The OCR and
-- drafting models are settings, never a model a step or a job can name. As before, the worker
-- seeds both from .env and an admin's edit (edited_at) or addition (source 'ui') wins.
CREATE TABLE llm_choices (
  id          text        PRIMARY KEY
                          CHECK (id ~ '^[a-z0-9][a-z0-9_-]*$' AND id NOT IN ('default', 'draft', 'ocr')),
  label       text        NOT NULL CHECK (length(trim(label)) > 0),
  description text        NOT NULL DEFAULT '',
  -- endpoint/model-id: an offered model.
  ref         text        NOT NULL,
  source      text        NOT NULL DEFAULT 'env' CHECK (source IN ('env', 'ui')),
  edited_at   timestamptz,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_settings (
  -- default_choice: a choice id; drafting_model and ocr_model: endpoint/model-id.
  name       text        PRIMARY KEY CHECK (name IN ('default_choice', 'drafting_model', 'ocr_model')),
  value      text        NOT NULL,
  edited_at  timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The aliases move across, keeping who edited them: default and fast become the choices the
-- worker seeds without LLM_CHOICES ("Default model", "Fast model"), draft and ocr settings, any
-- other alias a choice of its own name.
INSERT INTO llm_choices (id, label, ref, source, edited_at, updated_by)
SELECT 'main', 'Default model', ref, 'env', edited_at, updated_by FROM llm_aliases WHERE name = 'default'
UNION ALL
SELECT 'fast', 'Fast model', ref, 'env', edited_at, updated_by FROM llm_aliases WHERE name = 'fast'
UNION ALL
SELECT name, name, ref, CASE WHEN edited_at IS NULL THEN 'env' ELSE 'ui' END, edited_at, updated_by
  FROM llm_aliases
 WHERE name NOT IN ('default', 'fast', 'draft', 'ocr', 'main') AND name ~ '^[a-z0-9][a-z0-9_-]*$';

INSERT INTO llm_settings (name, value, edited_at, updated_by)
SELECT 'default_choice', 'main', edited_at, updated_by FROM llm_aliases WHERE name = 'default'
UNION ALL
SELECT 'drafting_model', ref, edited_at, updated_by FROM llm_aliases WHERE name = 'draft'
UNION ALL
SELECT 'ocr_model', ref, edited_at, updated_by FROM llm_aliases WHERE name = 'ocr';

DROP TABLE llm_aliases;

CREATE TRIGGER llm_choices_bump AFTER INSERT OR UPDATE OR DELETE ON llm_choices
  FOR EACH ROW EXECUTE FUNCTION llm_config_bump();
CREATE TRIGGER llm_settings_bump AFTER INSERT OR UPDATE OR DELETE ON llm_settings
  FOR EACH ROW EXECUTE FUNCTION llm_config_bump();

-- "Discover" on the Models page: the bump makes every worker rebuild its registry and list the
-- endpoints' models now rather than at the next discovery interval.
ALTER TABLE llm_endpoints ADD COLUMN discover_requested_at timestamptz;
