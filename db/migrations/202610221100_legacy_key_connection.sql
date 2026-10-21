-- The connection a key move chose for a target, recorded before the move writes it: a move whose
-- target write failed reuses its own connection on the next try, rather than making another
-- (target-<id>-2, ...) with a copy of the same secret.
ALTER TABLE publish_target_legacy_keys ADD COLUMN connection_id text;
