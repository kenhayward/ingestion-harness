-- Workbench drafting may hold a conversation with tools (test anchors, search the ontologies,
-- read sample pages) on an endpoint unless an admin turns it off (Administration > Models,
-- *Tool calls*): some OpenAI-compatible servers mis-handle tools. Off: one reply per call, as
-- before. The llm_endpoints_bump trigger moves the config version, so workers rebuild.
ALTER TABLE llm_endpoints ADD COLUMN tool_calls boolean NOT NULL DEFAULT true;
