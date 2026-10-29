-- Tenant lanes for conversions (watched folders plan 2): a document to a sink instance waits
-- for a free lane of that tenant (`waiting_to_deliver`) before the worker hands it to the bridge.
ALTER TABLE decomposition_items DROP CONSTRAINT decomposition_items_outcome_check;
ALTER TABLE decomposition_items ADD CONSTRAINT decomposition_items_outcome_check CHECK (outcome IN (
  'queued', 'decomposing', 'delivering', 'created', 'updated', 'already_loaded',
  'duplicate', 'in_flight', 'changed_in_target', 'read_back_mismatch',
  'unresolved', 'failed', 'awaiting_review', 'rejected', 'waiting_to_deliver'));

-- When the item took one of its tenant's lanes (null: none). A lane is held while the item is
-- `decomposing`, `waiting_to_deliver` or `delivering`; leaving those states releases it.
ALTER TABLE decomposition_items ADD COLUMN lane_claimed_at timestamptz;

-- When an item of the batch last took a lane: waiting batches take turns, the longest since
-- first.
ALTER TABLE decomposition_batches ADD COLUMN last_lane_at timestamptz;

-- How many deliveries the target's tenant (sink + instance) takes at once, as the bridge's sink
-- catalog describes it; null when not described (one at a time). The API's target sync writes it.
ALTER TABLE publish_targets ADD COLUMN lanes integer CHECK (lanes BETWEEN 1 AND 64);

-- The lane count reads the items holding or waiting for a lane.
CREATE INDEX decomposition_items_lane_idx ON decomposition_items (outcome)
  WHERE outcome IN ('waiting_to_deliver', 'delivering');
