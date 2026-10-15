-- A model's output limit (admin, Models page): the most tokens one of its replies may use where
-- the step does not say (Workbench drafting and mapping; 16,000 when not set). Mainly a property
-- of the model, so it lives with the model, not a step. NULL: the default.
ALTER TABLE llm_models ADD COLUMN max_output_tokens integer
  CHECK (max_output_tokens BETWEEN 1024 AND 1000000);

-- Workers rebuild their registry when it changes, as for curation (0024).
DROP TRIGGER llm_models_curated_update ON llm_models;
CREATE TRIGGER llm_models_curated_update AFTER UPDATE OF curated, enabled, max_output_tokens ON llm_models
  FOR EACH ROW WHEN (OLD.curated IS DISTINCT FROM NEW.curated OR OLD.enabled IS DISTINCT FROM NEW.enabled
                     OR OLD.max_output_tokens IS DISTINCT FROM NEW.max_output_tokens)
  EXECUTE FUNCTION llm_config_bump();
