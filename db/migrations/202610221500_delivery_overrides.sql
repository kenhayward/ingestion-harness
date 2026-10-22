-- The names a reviewer chose for what a job's deliveries create (per target id, per name field
-- id), stored with the approval and sent with the delivery; a re-approval replaces them.
ALTER TABLE jobs ADD COLUMN delivery_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
