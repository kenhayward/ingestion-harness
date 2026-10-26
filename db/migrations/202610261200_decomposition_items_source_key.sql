-- Detach refuses while a run of the entry's source is unfinished on its tenant (PgRepo
-- detachRegisterEntry): it looks items up by source key across every batch, which the unique
-- (batch_id, source_key) index can't serve, and the table only grows.
CREATE INDEX IF NOT EXISTS decomposition_items_source_key_idx ON decomposition_items (source_key);
