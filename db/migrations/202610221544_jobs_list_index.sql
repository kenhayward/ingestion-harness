-- The Jobs list pages on the server from a job's place (created_at, id), newest first
-- (GET /api/jobs/page, PgRepo.jobPage): an index in that order over the listable jobs
-- (never sample preparation), so a page is a short index read rather than a sort.
CREATE INDEX IF NOT EXISTS jobs_list_idx ON jobs (created_at DESC, id DESC) WHERE task <> 'prepare';
