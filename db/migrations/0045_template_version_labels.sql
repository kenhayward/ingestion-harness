-- Issue #144: a recipe version's label and note, what a person says the version is for.
-- Metadata only, never part of the definition: the 0003 trigger guards `definition` and `status`
-- alone, so published versions can be labelled too. The worker never reads these columns, and
-- setting them leaves `updated_at` alone (a draft's editor compares it before saving).
ALTER TABLE templates
  ADD COLUMN label        text CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
  ADD COLUMN note         text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  ADD COLUMN label_set_by text,
  ADD COLUMN label_set_at timestamptz;
