-- Maintenance mode: an admin takes CT Studio down for everyone but admins (swapping models, a
-- deploy) with a message the sign-in page and the app show. One row. The message is kept when
-- maintenance is switched off, ready for next time; `since` is when it was switched on.
-- The API reads it; the worker never does (queued jobs keep running).
CREATE TABLE maintenance (
  id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
  enabled    boolean     NOT NULL DEFAULT false,
  message    text        NOT NULL DEFAULT '' CHECK (char_length(message) <= 1000),
  since      timestamptz CHECK ((since IS NULL) = (NOT enabled)),
  updated_by text,
  updated_at timestamptz
);

INSERT INTO maintenance DEFAULT VALUES;
