-- Workbench phase 5b: references across versions. A Workbench type's references belong to a
-- template version (vN's regression keeps vN's set); a copy carries them to v(N+1) and remembers
-- the outputs they were verified against. Other types keep unpinned references (every version).

ALTER TABLE template_references
  ADD COLUMN template_version integer CHECK (template_version > 0),
  ADD COLUMN copied_from      uuid REFERENCES template_references (id) ON DELETE SET NULL,
  ADD COLUMN verified_outputs jsonb,
  ADD COLUMN superseded_at    timestamptz;

-- Existing Workbench references: pinned to the version their source job ran, verified against
-- that version's outputs. Without a source job they stay unpinned (every version).
UPDATE template_references r
   SET template_version = d.spec_version,
       verified_outputs = t.definition -> 'outputs'
  FROM jobs j
  JOIN documents d ON d.id = j.document_id
  JOIN templates t ON t.id = d.spec_id AND t.version = d.spec_version
 WHERE r.source_job_id = j.id
   AND EXISTS (SELECT 1 FROM workbench_projects p WHERE p.id = r.template_id);

-- Names are unique among live references of one version (unpinned ones share version 0).
ALTER TABLE template_references DROP CONSTRAINT template_references_template_id_name_key;
CREATE UNIQUE INDEX template_references_live_name_idx
  ON template_references (template_id, coalesce(template_version, 0), name)
  WHERE superseded_at IS NULL;
