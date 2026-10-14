-- Retired document types: hidden from new work (uploads, test runs, drafting, publishing) and
-- refused by the API with a 409, while every version, job, result and reference stays readable.
-- One row per retired type id. No foreign key: a type is a database recipe (templates) or a
-- file-only legacy spec.yaml. Unretiring deletes the row (who and when are in the API log).
-- Read by the API only: the worker never reads it, so jobs already queued finish.
CREATE TABLE document_type_retirements (
  type_id    text        PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now(),
  retired_by text
);
