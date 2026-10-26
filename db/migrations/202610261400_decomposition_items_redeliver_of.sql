-- Every item read names its latest run again (an item whose redeliver_of is it: Item.rerunIn),
-- and the rerun guards look reruns up by it (PgRepo rerunItem, retryItems): index the column,
-- which only the reruns fill.
CREATE INDEX IF NOT EXISTS decomposition_items_redeliver_of_idx
  ON decomposition_items (redeliver_of, created_at)
  WHERE redeliver_of IS NOT NULL;
