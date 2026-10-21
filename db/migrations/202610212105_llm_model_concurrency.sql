-- How many calls a worker may send a model at once (admin, Models page): a step's occurrence and
-- chunk calls, and OCR pages. NULL: one at a time (OCR: ocr.concurrency of the config file).
-- A property of the model and its server, so it lives with the model, like max_output_tokens.
ALTER TABLE llm_models ADD COLUMN max_concurrent_calls integer
  CHECK (max_concurrent_calls BETWEEN 1 AND 32);

-- Workers rebuild their registry when it changes, as for the output limit (0043).
DROP TRIGGER llm_models_curated_update ON llm_models;
CREATE TRIGGER llm_models_curated_update
  AFTER UPDATE OF curated, enabled, max_output_tokens, max_concurrent_calls ON llm_models
  FOR EACH ROW WHEN (OLD.curated IS DISTINCT FROM NEW.curated OR OLD.enabled IS DISTINCT FROM NEW.enabled
                     OR OLD.max_output_tokens IS DISTINCT FROM NEW.max_output_tokens
                     OR OLD.max_concurrent_calls IS DISTINCT FROM NEW.max_concurrent_calls)
  EXECUTE FUNCTION llm_config_bump();
