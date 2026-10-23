-- Version 2: the conditional update a delivery carries (replace a document already in the target
-- only if none of its components changed there). Null for a plain delivery. Named
-- conditional_update because UPDATE is a reserved word.
ALTER TABLE deliveries ADD COLUMN conditional_update jsonb;
