-- A user holds one personal connection per sink instance, so a delivery as that user always
-- knows which credential to use. A sink without instances has a null instance: still one.
CREATE UNIQUE INDEX connections_personal_instance
  ON connections (owner, sink_id, instance_id) NULLS NOT DISTINCT WHERE kind = 'personal';
-- Deleting a user's connections, and the reconcile, select by owner.
CREATE INDEX connections_owner ON connections (owner) WHERE owner IS NOT NULL;
