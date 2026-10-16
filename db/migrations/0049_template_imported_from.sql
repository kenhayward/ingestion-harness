-- Where a version's definition was imported from (a CT Studio recipe file on GitHub or uploaded):
-- {instance, typeId, version, commit|null}. Metadata like the labels of 0045, outside the
-- definition: the 0003 trigger guards `definition` and `status` alone, setting it leaves
-- `updated_at` alone, and a hand edit does not clear it. A later push writes it into the file.
-- The worker never reads it.
ALTER TABLE templates ADD COLUMN imported_from jsonb;
