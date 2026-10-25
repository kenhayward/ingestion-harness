-- Decomposition phase 3, the row actions (spec §8 "Resolving a refused document"):
-- - `detached`: detach keeps the entry as a tombstone, naming the register action that detached
--   it. The register's checks treat it as absent, and the next create of that source takes the
--   action's id into its idempotency key, so the target can't answer with the detached document.
--   That create replaces the tombstone with a new entry.
-- - `accepted`: the target's state was accepted. The entry holds the target's current versions,
--   and the next run of that source is an update (never "already loaded"), whatever the content.
ALTER TABLE decomposition_register DROP CONSTRAINT decomposition_register_state_check;
ALTER TABLE decomposition_register ADD CONSTRAINT decomposition_register_state_check
  CHECK (state IN ('pending', 'delivered', 'incomplete', 'changed', 'failed', 'detached',
                   'accepted'));
ALTER TABLE decomposition_register ADD COLUMN detach_action_id uuid;
