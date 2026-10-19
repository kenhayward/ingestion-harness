-- A staged package's bytes are deleted once it is past its retention (expires_at, from
-- BRIDGE_PACKAGE_RETENTION_DAYS) and every delivery of it is final; the row stays, as the
-- deliveries name it.
ALTER TABLE packages ADD COLUMN pruned_at timestamptz;
CREATE INDEX packages_to_prune ON packages (expires_at) WHERE pruned_at IS NULL;
