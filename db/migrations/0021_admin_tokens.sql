-- Issued admin tokens (ADR 0006 addendum): admins can issue named, expiring admin tokens that
-- survive restarts. Only the admin token from the log (bootstrap) is rotated on start and
-- cannot be revoked or deleted; issued_by records the label of the session that issued a token.
ALTER TABLE access_tokens
  ADD COLUMN bootstrap boolean NOT NULL DEFAULT false,
  ADD COLUMN issued_by text;

UPDATE access_tokens SET bootstrap = true WHERE role = 'admin';

ALTER TABLE access_tokens
  ADD CONSTRAINT access_tokens_bootstrap_is_admin CHECK (NOT bootstrap OR role = 'admin'),
  ADD CONSTRAINT access_tokens_admin_expires
    CHECK (role <> 'admin' OR bootstrap OR expires_at IS NOT NULL);
