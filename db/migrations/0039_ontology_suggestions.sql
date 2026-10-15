-- Ontology suggestions (ADR 0011 follow-up): the Survey tab's Refresh queues a project-scoped
-- `suggest` job (no document, like segment and graph previews) that writes
-- ontology-suggestions/{project}/{job}.json to the runs bucket.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology', 'graph', 'embed', 'withdraw', 'republish', 'suggest'));
