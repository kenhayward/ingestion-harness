-- Workbench project list (redesign W1/W3): a per-project cache of the list row, kept under a
-- fingerprint of the project's data (recomputed when it changes), and per-token pins.
CREATE TABLE workbench_list_cache (
  project_id   text        PRIMARY KEY REFERENCES workbench_projects (id) ON DELETE CASCADE,
  fingerprint  text        NOT NULL,
  item         jsonb       NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- owner: the access token id (the bootstrap admin token is recreated on every start, so its
-- pins reset then), or 'local' when access control is off.
CREATE TABLE workbench_pins (
  owner       text        NOT NULL,
  project_id  text        NOT NULL REFERENCES workbench_projects (id) ON DELETE CASCADE,
  pinned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, project_id)
);
