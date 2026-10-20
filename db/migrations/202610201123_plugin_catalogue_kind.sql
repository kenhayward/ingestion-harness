-- Check plugins (docs/design/output-roles.md): a catalogue plugin is a pipeline `step` or a
-- `check`. The worker publishes the kind with the rest; rows from before are steps.
ALTER TABLE plugin_catalogue
  ADD COLUMN kind text NOT NULL DEFAULT 'step' CHECK (kind IN ('step', 'check'));
