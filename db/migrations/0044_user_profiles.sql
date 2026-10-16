-- A user's own profile (docs/design/profile.md): details they edit themselves and a linked GitHub
-- account. One row per user who saved a detail or linked GitHub; none = an empty profile.
CREATE TABLE user_profiles (
  user_id           uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  job_title         text CHECK (length(btrim(job_title)) BETWEEN 1 AND 100),
  company           text CHECK (length(btrim(company)) BETWEEN 1 AND 100),
  linkedin          text CHECK (linkedin ~ '^[A-Za-z0-9-]{3,100}$'),
  -- GitHub's numeric user id: a login can be renamed, the id cannot.
  github_id         bigint,
  github_login      text,
  github_avatar_url text,
  -- The OAuth token, AES-256-GCM under LLM_SECRETS_KEY (`v1:…`, apps/api/src/llm/secrets.ts).
  github_token_enc  text,
  github_linked_at  timestamptz,
  -- owner/name of the repository recipe YAML will be stored in (not used yet).
  github_repo       text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_github_whole CHECK (
    (github_id IS NULL) = (github_login IS NULL)
    AND (github_id IS NULL) = (github_avatar_url IS NULL)
    AND (github_id IS NULL) = (github_token_enc IS NULL)
    AND (github_id IS NULL) = (github_linked_at IS NULL)
    AND (github_id IS NOT NULL OR github_repo IS NULL)
  )
);
-- One app user per GitHub account.
CREATE UNIQUE INDEX user_profiles_github_key ON user_profiles (github_id);

-- A GitHub link in progress (OAuth `state`, hashed): the callback arrives from github.com without
-- the SameSite=Strict session cookie, so it finds the user here. Older than 10 minutes = expired.
CREATE TABLE github_link_states (
  state_hash text PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_link_states_created_idx ON github_link_states (created_at);

COMMENT ON TABLE user_profiles IS
  'Profile details a user edits themselves, and their linked GitHub account (TS only).';
