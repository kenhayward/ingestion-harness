-- Who queued a job: the label of the signed-in access token, copied when the job is created.
-- No foreign key: the bootstrap admin token is recreated on every start and tokens can be
-- deleted, while the label stays. Null for jobs created before this migration or with access
-- control off. The Jobs page's "My jobs" toggle filters on it.
ALTER TABLE jobs ADD COLUMN created_by text;
CREATE INDEX jobs_created_by_created_at ON jobs (created_by, created_at DESC);
