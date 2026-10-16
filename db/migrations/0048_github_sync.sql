-- GitHub recipe sync (docs/superpowers/specs/2026-10-16-github-recipe-sync-design.md).
-- No foreign keys to `templates`: a link outlives its drafts. A never-published type's links and
-- push records are removed when that project is deleted.

-- This deployment's identity in a repository. One row, created on first read.
CREATE TABLE github_sync_settings (
  id               boolean     PRIMARY KEY DEFAULT true CHECK (id),
  instance_name    text        NOT NULL,
  instance_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  default_root     text        NOT NULL DEFAULT 'ct-studio',
  first_pushed_at  timestamptz,           -- the name is locked once this is set
  set_by           text,
  set_at           timestamptz NOT NULL DEFAULT now()
);

-- Where a document type's published versions are stored on GitHub.
CREATE TABLE template_github_links (
  type_id         text        PRIMARY KEY,
  repo            text        NOT NULL,
  branch          text        NOT NULL,
  root            text        NOT NULL,
  always_pr       boolean     NOT NULL DEFAULT false,
  push_on_publish boolean     NOT NULL DEFAULT false,
  set_by          text,
  set_at          timestamptz NOT NULL DEFAULT now()
);

-- The last push of each published version: what GitHub held then (blob and label shas).
CREATE TABLE template_github_pushes (
  type_id    text        NOT NULL,
  version    integer     NOT NULL CHECK (version > 0),
  repo       text        NOT NULL,
  branch     text        NOT NULL,
  path       text        NOT NULL,
  commit_sha text        NOT NULL,
  blob_sha   text        NOT NULL,
  label_sha  text        NOT NULL,
  pr_number  integer,
  pr_url     text,
  pr_state   text        CHECK (pr_state IN ('open', 'merged', 'closed')),
  pushed_by  text        NOT NULL,
  pushed_at  timestamptz NOT NULL,
  PRIMARY KEY (type_id, version)
);

-- Who published a version. The 0003 trigger guards `definition` and `status` only, and this is
-- set in the same UPDATE that publishes, so published rows stay immutable as before.
ALTER TABLE templates ADD COLUMN published_by text;
