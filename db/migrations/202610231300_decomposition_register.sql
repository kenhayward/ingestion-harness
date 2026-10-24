-- Decomposition phase 2: the register links each delivered source document to its persistent id
-- in a target, scoped to the target's sink and instance (one tenant; plan ruling R5). The worker
-- writes an entry `pending` before delivering, under a row lock (R6); the API settles it from the
-- bridge's events: delivered, incomplete, changed (in the target) or failed.
CREATE TABLE decomposition_register (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sink_id         text NOT NULL,
  -- Null for a sink without instances.
  instance_id     text,
  -- The file's path relative to the batch's source folder (its name, uploaded on its own).
  source_key      text NOT NULL,
  content_sha256  text NOT NULL,
  -- Once known, never cleared by a later event.
  persistent_id   text,
  state           text NOT NULL
                  CHECK (state IN ('pending', 'delivered', 'incomplete', 'changed', 'failed')),
  idempotency_key text NOT NULL,
  -- The latest delivery for this entry (null until the bridge accepted it).
  delivery_id     text UNIQUE,
  -- The last receipt with a document: the components an update expects unchanged.
  last_receipt    jsonb,
  last_error      jsonb,
  batch_id        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  -- One entry per source on a tenant; a sink without instances is one tenant.
  UNIQUE NULLS NOT DISTINCT (sink_id, instance_id, source_key)
);
-- The duplicate check: the same content already on this tenant under any key.
CREATE INDEX decomposition_register_content
  ON decomposition_register (sink_id, instance_id, content_sha256);
