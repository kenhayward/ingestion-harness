-- Where each delivery goes, resolved when it was accepted: the target's destination with its
-- sink's name patterns applied for that document (and a reviewer's overrides). Null for
-- deliveries accepted before: the runner merges their overrides over the target's destination.
ALTER TABLE deliveries ADD COLUMN destination jsonb;
