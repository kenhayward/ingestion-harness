-- How long each conversion item took (the Conversion tab's rows): `started_at` when the worker
-- first moves the item to `decomposing` (a retry keeps it), `finished_at` when it reaches a final
-- outcome: written by the worker for an outcome decided without a delivery, by the API's settle
-- (apps/api/src/bridge/register.ts) for a delivered or refused one. Null for items before this.
ALTER TABLE decomposition_items
  ADD COLUMN started_at  timestamptz,
  ADD COLUMN finished_at timestamptz;
