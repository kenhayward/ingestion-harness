-- Delivery bridge: a job waiting for a publishing target the API has not synced from the bridge
-- yet is re-queued without spending an attempt; waiting_since (set on its first wait, cleared once
-- it gets past target resolution or finishes) bounds that wait, after which the job fails.
ALTER TABLE jobs ADD COLUMN waiting_since timestamptz;
