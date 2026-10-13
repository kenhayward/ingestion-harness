-- LLM endpoints, curated models and aliases in the database (ADR 0010). The worker seeds them
-- from config/llm-providers.yaml and .env on start and builds its registry from here; a row an
-- admin edited (edited_at) or added (source 'ui') is never changed by seeding: the UI wins.
CREATE TABLE llm_endpoints (
  -- The model ref prefix: `name/model-id`.
  name             text        PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  kind             text        NOT NULL CHECK (kind IN ('anthropic', 'openai-chat', 'openai-responses')),
  base_url         text,
  -- Data policy (ADR 0007): where requests to this endpoint go.
  location         text        NOT NULL DEFAULT 'external' CHECK (location IN ('local', 'external')),
  -- Env var with the key (seeded endpoints); LLM_ENDPOINT_KEYS holds `name=key` pairs.
  api_key_env      text,
  api_key_required boolean     NOT NULL DEFAULT true,
  discover         boolean     NOT NULL DEFAULT true,
  model_filter     text,
  options          jsonb       NOT NULL DEFAULT '{}',
  enabled          boolean     NOT NULL DEFAULT true,
  source           text        NOT NULL DEFAULT 'env' CHECK (source IN ('env', 'ui')),
  edited_at        timestamptz,
  updated_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Curated: offered in the model pickers (seeded from .env or chosen by an admin); discovered
-- models are suggestions until curated. curated_edited_at: an admin chose, so .env no longer does.
ALTER TABLE llm_models
  ADD COLUMN curated           boolean NOT NULL DEFAULT false,
  ADD COLUMN curated_edited_at timestamptz;

-- default, fast, draft and ocr (the OCR model) -> `endpoint/model-id` (or another alias).
CREATE TABLE llm_aliases (
  name       text        PRIMARY KEY,
  ref        text        NOT NULL,
  edited_at  timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row: moves on every change the worker's registry depends on, so workers rebuild it.
CREATE TABLE llm_config_state (
  id      boolean PRIMARY KEY DEFAULT true CHECK (id),
  version bigint  NOT NULL DEFAULT 0
);
INSERT INTO llm_config_state DEFAULT VALUES;

CREATE FUNCTION llm_config_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE llm_config_state SET version = version + 1;
  PERFORM pg_notify('ih_llm_config', '');
  RETURN NULL;
END $$;

CREATE TRIGGER llm_endpoints_bump AFTER INSERT OR UPDATE OR DELETE ON llm_endpoints
  FOR EACH ROW EXECUTE FUNCTION llm_config_bump();
CREATE TRIGGER llm_aliases_bump AFTER INSERT OR UPDATE OR DELETE ON llm_aliases
  FOR EACH ROW EXECUTE FUNCTION llm_config_bump();
-- Discovery upserts llm_models constantly: only curation and enabling move the version.
CREATE TRIGGER llm_models_curated_insert AFTER INSERT ON llm_models
  FOR EACH ROW WHEN (NEW.curated) EXECUTE FUNCTION llm_config_bump();
CREATE TRIGGER llm_models_curated_update AFTER UPDATE OF curated, enabled ON llm_models
  FOR EACH ROW WHEN (OLD.curated IS DISTINCT FROM NEW.curated OR OLD.enabled IS DISTINCT FROM NEW.enabled)
  EXECUTE FUNCTION llm_config_bump();
