-- Who queued a job, by user id (ADR 0013): `created_by` keeps the name for people to read, but a
-- name can change or be given to someone else later, so "My jobs" (`?mine=1`) and the web's
-- "your jobs" match this id. No foreign key, like `created_by`: a job outlives its user's record.
-- Null for jobs created before this migration (matched by name instead), with access control off,
-- and for document-less background jobs (withdraw, republish, ontology imports).
ALTER TABLE jobs ADD COLUMN created_by_user uuid;
CREATE INDEX jobs_created_by_user_created_at ON jobs (created_by_user, created_at DESC);
