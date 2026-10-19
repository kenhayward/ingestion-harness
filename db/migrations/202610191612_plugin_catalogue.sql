-- The plugin catalogue (docs/design/recipe-plugins.md, slice 3b): the plugins the worker image
-- can run, published by the worker when it starts (it replaces the whole set, so the table holds
-- what the newest worker to start has). The API checks recipes' plugin steps against it (`uses`
-- must be listed, `with` must fit `settings_schema`) and the recipe editor offers it.
CREATE TABLE plugin_catalogue (
  ref             text        PRIMARY KEY,            -- '<id>@<major>', a step's `uses`
  plugin_id       text        NOT NULL,
  major           integer     NOT NULL CHECK (major > 0),
  summary         text        NOT NULL,
  egress          text        NOT NULL CHECK (egress IN ('none', 'model', 'remote')),
  settings_schema jsonb       NOT NULL,               -- JSON Schema of the step's `with`
  worker_version  text,                               -- the worker that published it
  published_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ref = plugin_id || '@' || major)
);
