-- Plugin step previews (recipe plugins 3c): task 'plugin' runs a recipe's plugin step on a
-- Workbench project's prepared dev samples (project-scoped, no document, like 'graph').
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check CHECK (task IN ('process','publish','rerun','prepare','segment','draft','export','ontology','graph','embed','withdraw','republish','suggest','rebuild','plugin'));
