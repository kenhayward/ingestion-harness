-- Delivery bridge phase 4: several targets per recipe.

-- How an S3 target writes a package: each file at its key (`files`, today's keys) or the whole
-- package as an archive (`package`). Fixed: it locks with the bucket and prefix.
ALTER TABLE publish_targets ADD COLUMN layout text NOT NULL DEFAULT 'files';
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_layout_check
  CHECK (layout IN ('files', 'package') AND (kind <> 'rdf' OR layout = 'files'));

-- The targets a recipe definition names (`delivery.publishTo`: one id or a list), in order;
-- `default` when it names none. The triple store is never listed.
CREATE FUNCTION publish_to_ids(definition jsonb) RETURNS SETOF text
LANGUAGE sql IMMUTABLE AS $$
  SELECT x FROM (
    SELECT CASE jsonb_typeof(definition->'delivery'->'publishTo')
             WHEN 'string' THEN ARRAY[definition->'delivery'->>'publishTo']
             WHEN 'array' THEN ARRAY(SELECT jsonb_array_elements_text(definition->'delivery'->'publishTo'))
             ELSE ARRAY['default']
           END AS ids
  ) l CROSS JOIN LATERAL unnest(l.ids) AS x
$$;

-- Published outputs are recorded per target. The primary target's rows (the first files-layout
-- target in the recipe's list) serve Results, the zip and read keys; rows from before are all
-- primary. NULLS NOT DISTINCT keeps review-stage rows (no target) unique as before.
ALTER TABLE job_outputs ADD COLUMN is_primary boolean NOT NULL DEFAULT true;
ALTER TABLE job_outputs DROP CONSTRAINT job_outputs_job_output_stage_key;
ALTER TABLE job_outputs ADD CONSTRAINT job_outputs_job_output_stage_target_key
  UNIQUE NULLS NOT DISTINCT (job_id, output_id, stage, target_id);
