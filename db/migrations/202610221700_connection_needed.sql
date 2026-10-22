-- A job back in review because a delivery needs a person's connection (none, or refused): the
-- review screen offers Manage connections. Set by the worker's refusal and the bridge's events;
-- an approval clears it.
ALTER TABLE jobs ADD COLUMN connection_needed boolean NOT NULL DEFAULT false;
