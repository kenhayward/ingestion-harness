-- A removed target keeps its row: its finished deliveries still name it (deliveries.target_id),
-- and its id is not used again, so a new target cannot inherit its delivery history.
ALTER TABLE targets ADD COLUMN removed_at timestamptz;
