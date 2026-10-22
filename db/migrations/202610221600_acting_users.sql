-- Who a job's deliveries are made as (delivery bridge phase 6). The approver by id (the
-- free-text reviewer name stays for display; a rename no longer loses who approved), and the
-- user the bridge last accepted a package as, whom a system re-delivery (a graph rebuild or
-- remint) acts as.
ALTER TABLE jobs ADD COLUMN reviewer_user_id uuid;
ALTER TABLE jobs ADD COLUMN delivered_as_user uuid;
