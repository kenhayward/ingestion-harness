-- Backup and restore (docs/superpowers/specs/2026-10-17-backup-and-restore-design.md).
--
-- A restore pauses the job queue: while `paused`, no worker claims a job (CLAIM_SQL), until an
-- admin resumes it. One row, like llm_config_state.
CREATE TABLE queue_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz, paused_by text, reason text);
INSERT INTO queue_control (id) VALUES (true);

-- A copy restore queues a `rebuild` job (params {mode: remint|rebuild}): no document, no project,
-- like `withdraw`.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check CHECK (task IN ('process','publish','rerun','prepare','segment','draft','export','ontology','graph','embed','withdraw','republish','suggest','rebuild'));
ALTER TABLE jobs DROP CONSTRAINT jobs_document_or_project;
ALTER TABLE jobs ADD CONSTRAINT jobs_document_or_project
  CHECK (document_id IS NOT NULL OR project_id IS NOT NULL
         OR task IN ('ontology', 'embed', 'withdraw', 'republish', 'rebuild'));

-- A copy restore drops the backup's external publishing targets; one its delivery records still
-- name stays as an inert row (the foreign keys), which nothing lists, resolves or delivers to.
ALTER TABLE publish_targets ADD COLUMN inert_at timestamptz;
