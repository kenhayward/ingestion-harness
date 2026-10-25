-- Decomposition phase 3: conversion batches. A batch is one upload of Word files (or a folder)
-- to one target; each file is an item that a `decompose` job converts and delivers. The job
-- belongs to no document and no Workbench project, like `ontology` and `rebuild`.
CREATE TABLE decomposition_batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id  text NOT NULL,
  -- Who started it, as the acting-user snapshot {id, name} (null parts without access control).
  created_by jsonb NOT NULL,
  state      text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'started', 'discarded')),
  -- An explicit update: the version check still applies.
  force      boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz
);

CREATE TABLE decomposition_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES decomposition_batches (id),
  -- The browser's relative path (folder upload) or the file name.
  source_key     text NOT NULL,
  filename       text NOT NULL,
  content_sha256 text NOT NULL,
  size_bytes     bigint NOT NULL,
  -- The uploaded file in the runs bucket (`decompositionSourceKey`).
  object_key     text NOT NULL,
  job_id         uuid REFERENCES jobs (id),
  -- The worker's DeliveryOutcome once decided (TS ITEM_OUTCOMES).
  outcome        text NOT NULL DEFAULT 'queued' CHECK (outcome IN (
                   'queued', 'decomposing', 'delivering', 'created', 'updated', 'already_loaded',
                   'duplicate', 'in_flight', 'changed_in_target', 'read_back_mismatch',
                   'unresolved', 'failed')),
  detail         text,
  -- The register entry this item settled; no foreign key, the entry may be removed later.
  register_entry_id uuid,
  report_key     text,
  link           text,
  redeliver_of   uuid,
  -- Upload order (one upload per transaction).
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_key)
);
CREATE INDEX decomposition_items_job ON decomposition_items (job_id);

-- What people did to a register entry from the Conversion tab.
CREATE TABLE register_actions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL,
  action   text NOT NULL CHECK (action IN ('detach', 'accept')),
  by       jsonb NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  details  jsonb NOT NULL
);
CREATE INDEX register_actions_entry ON register_actions (entry_id, at);

ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check CHECK (task IN ('process','publish','rerun','prepare','segment','draft','export','ontology','graph','embed','withdraw','republish','suggest','rebuild','plugin','decompose'));
ALTER TABLE jobs DROP CONSTRAINT jobs_document_or_project;
ALTER TABLE jobs ADD CONSTRAINT jobs_document_or_project
  CHECK (document_id IS NOT NULL OR project_id IS NOT NULL
         OR task IN ('ontology', 'embed', 'withdraw', 'republish', 'rebuild', 'decompose'));
