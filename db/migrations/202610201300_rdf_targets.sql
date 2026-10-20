-- Delivery bridge phase 3: RDF behind the bridge.
-- The triple store becomes a publishing target (`rdf-default`, seeded from RDF_ENDPOINT by the
-- API and the worker): kind `rdf`, its dataset in `bucket`, its URL in `endpoint`, its writer's
-- user in `access_key_id` (not secret; the password stays on the bridge). Its job_deliveries rows
-- need the row, as every delivery's target does.
ALTER TABLE publish_targets DROP CONSTRAINT publish_targets_kind_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_kind_check
  CHECK (kind IN ('internal', 'external', 'rdf'));

-- An ontology (TBox) graph loaded through the bridge: the delivery that loads it. It counts as
-- loaded unless that delivery failed or needs a person; rows from before the bridge have none and
-- count as loaded.
ALTER TABLE published_ontology_graphs ADD COLUMN delivery_id uuid;
