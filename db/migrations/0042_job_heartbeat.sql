-- Job heartbeats: a worker refreshes heartbeat_at about every minute while it runs a job, from a
-- thread on its own connection, guarded by its claim (status 'running' and its locked_at). The
-- reaper re-queues a running job only when its heartbeat (or, for a claim from before this
-- migration, its claim time) is older than STALE_LOCK_S, so a long job (an ontology import that
-- embeds for an hour) is never taken over by another worker while its own is alive.
-- locked_at stays the claim's token: a beat never changes it.
ALTER TABLE jobs ADD COLUMN heartbeat_at timestamptz;

-- A beat is not a change anyone watches: live job streams (0031) ignore an update that only
-- moves heartbeat_at, so a running job does not wake every viewer each minute.
DROP TRIGGER jobs_notify_changed ON jobs;
CREATE TRIGGER jobs_notify_changed AFTER UPDATE ON jobs
  FOR EACH ROW WHEN ((to_jsonb(OLD) - 'heartbeat_at') IS DISTINCT FROM (to_jsonb(NEW) - 'heartbeat_at'))
  EXECUTE FUNCTION jobs_notify_changed();
