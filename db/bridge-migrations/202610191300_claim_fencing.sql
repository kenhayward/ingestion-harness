-- Fencing: each claim gets its own id, and a status change must present it, so a runner whose
-- lease expired cannot overwrite what the runner that took the delivery over recorded.
ALTER TABLE deliveries ADD COLUMN claim_id uuid;
