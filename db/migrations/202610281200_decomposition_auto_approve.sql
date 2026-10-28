-- Auto Approve (a batch option, off by default): the batch's PDFs are delivered without being
-- held for review.
ALTER TABLE decomposition_batches ADD COLUMN auto_approve boolean NOT NULL DEFAULT false;
