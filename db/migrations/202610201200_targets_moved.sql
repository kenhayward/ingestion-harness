-- Delivery bridge phase 2: a target's keys live on the bridge, as a shared connection. CT Studio
-- keeps `publish_targets` as its recipient registry (mirrored to the bridge) and names the
-- connection each target delivers with; the one-off move sets moved_to_bridge_at and drops
-- secret_key_enc, so no target secret stays here.
ALTER TABLE publish_targets
  ADD COLUMN moved_to_bridge_at timestamptz,
  ADD COLUMN connection_id text;
