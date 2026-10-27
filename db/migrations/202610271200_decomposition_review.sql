-- PDFs are converted and then held for a person's review (step 5b, spec §14): two new item
-- outcomes, and the columns that hold the held document and the review's decision.
ALTER TABLE decomposition_items DROP CONSTRAINT decomposition_items_outcome_check;
ALTER TABLE decomposition_items ADD CONSTRAINT decomposition_items_outcome_check CHECK (outcome IN (
  'queued', 'decomposing', 'delivering', 'created', 'updated', 'already_loaded',
  'duplicate', 'in_flight', 'changed_in_target', 'read_back_mismatch',
  'unresolved', 'failed', 'awaiting_review', 'rejected'));

-- How many flags the report holds (the worker's count; null before it wrote the report).
ALTER TABLE decomposition_items ADD COLUMN flag_count int;
-- The held document: the sha-256 of the converted files, and the register entry the worker
-- would write on approval (null when it has none yet).
ALTER TABLE decomposition_items ADD COLUMN held_sha256 text;
ALTER TABLE decomposition_items ADD COLUMN held_entry jsonb;
-- The review's decision: who (a BatchCreator snapshot), when, and the note given.
ALTER TABLE decomposition_items ADD COLUMN reviewed_by jsonb;
ALTER TABLE decomposition_items ADD COLUMN reviewed_at timestamptz;
ALTER TABLE decomposition_items ADD COLUMN review_note text;
