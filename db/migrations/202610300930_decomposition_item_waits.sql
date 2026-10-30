-- A conversion item's waits between its decomposition and its delivery (a free lane of its
-- tenant, a review of a held PDF), so its working time can leave them out. The worker sets
-- `waiting_since` when the item starts waiting (`waiting_to_deliver`, `awaiting_review`), and the
-- run that carries it on adds the wait to `waited_ms` and clears it. Items converted before have
-- no waits recorded.
ALTER TABLE decomposition_items ADD COLUMN waiting_since timestamptz;
ALTER TABLE decomposition_items ADD COLUMN waited_ms bigint NOT NULL DEFAULT 0
  CHECK (waited_ms >= 0);
