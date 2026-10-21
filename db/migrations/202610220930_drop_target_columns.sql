-- Delivery bridge: one target registry, the last step. The bridge holds where and how a target
-- delivers (202610220900 made publish_targets its cache), and the keys not moved to it yet are in
-- publish_target_legacy_keys: the old S3 and credential columns have no reader or writer left.
ALTER TABLE publish_targets DROP CONSTRAINT IF EXISTS publish_targets_layout_check;
ALTER TABLE publish_targets
  DROP COLUMN bucket,
  DROP COLUMN prefix,
  DROP COLUMN sse,
  DROP COLUMN kms_key_id,
  DROP COLUMN storage_class,
  DROP COLUMN layout,
  DROP COLUMN endpoint,
  DROP COLUMN region,
  DROP COLUMN access_key_id,
  DROP COLUMN secret_key_enc,
  DROP COLUMN access_key_env,
  DROP COLUMN secret_key_env,
  DROP COLUMN force_path_style,
  DROP COLUMN moved_to_bridge_at;

-- Every cache write names its sink (the default was for rows written in the old columns).
ALTER TABLE publish_targets ALTER COLUMN sink_id DROP DEFAULT;
