-- A batch's name (owner's call 2026-10-30): set from the Conversion tab's batch list, shown there
-- and on the batch. Null until it is named.
ALTER TABLE decomposition_batches
  ADD COLUMN name text CHECK (name IS NULL OR (name <> '' AND char_length(name) <= 120));
