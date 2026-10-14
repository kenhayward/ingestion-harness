-- ADR 0011 step 7: deleting a job or retiring a document type withdraws what was delivered
-- (published target objects and graphs); unretiring re-delivers. Both run on the worker, which
-- alone reaches the target and the triple store.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology', 'graph', 'embed', 'withdraw', 'republish'));
ALTER TABLE jobs DROP CONSTRAINT jobs_document_or_project;
ALTER TABLE jobs ADD CONSTRAINT jobs_document_or_project
  CHECK (document_id IS NOT NULL OR project_id IS NOT NULL
         OR task IN ('ontology', 'embed', 'withdraw', 'republish'));

-- A retired type's delivered outputs: removed from the target, kept here to re-deliver on
-- unretiring. Readers ignore withdrawn rows.
ALTER TABLE job_outputs ADD COLUMN withdrawn_at timestamptz;
