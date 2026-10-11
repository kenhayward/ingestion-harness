-- Operators can cancel queued/running jobs. The worker checks for the status at safe points and
-- never overwrites it (all worker status writes are guarded with AND status = 'running').
-- (ADD VALUE inside a transaction is fine on PG >= 12 as long as the value isn't used in it.)
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'cancelled';
