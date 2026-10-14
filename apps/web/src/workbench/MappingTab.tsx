import type { DataPolicy, OverviewItem } from '@ih/shared';
import type { Api } from '../api/client.js';
import { GraphPreview } from '../templates/MappingEditor.js';
import { mappingBadge, mappingNote, mappingRows } from './mapping.js';
import { StagePanel } from './StagePanel.js';
import { useDefinitions } from './useDefinitions.js';

/**
 * The Mapping tab (ADR 0011): the model proposes the recipe's ontology mapping from the brief's
 * ontologies and the values the dev samples produced; each change shows the model's confidence,
 * the values behind it and the terms it was chosen over. Below: the mapping as it is now, and
 * the graph a dev sample would publish.
 */
export function MappingTab({
  api,
  projectId,
  used,
  definition,
  dataPolicy,
  hasDraft,
  draft,
  published,
  briefVersion,
  pollMs,
  item,
  retired,
  onApplied,
  onSkipped,
  onNavigate,
}: {
  api: Api;
  projectId: string;
  /** The brief chooses a vocabulary ontology. */
  used: boolean;
  /** The definition whose mapping is shown; absent: the open draft's, loaded here. */
  definition?: Record<string, unknown> | null;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  draft: number | null;
  published: number | null;
  briefVersion: number | null;
  pollMs: number;
  item: OverviewItem | null;
  retired?: string | null;
  onApplied: () => void;
  onSkipped: () => void;
  onNavigate: (hash: string) => void;
}) {
  const loaded = useDefinitions(api, projectId, draft, published, definition === undefined && used);
  if (!used) {
    return (
      <div className="mapping-tab">
        <p className="banner tone-skip">
          Not used: the brief chooses no ontologies. Choose the customer or industry ontologies this
          document type maps to, and the model will propose a mapping from their terms.
        </p>
        <button type="button" onClick={() => onNavigate(`#/workbench/${projectId}/brief`)}>
          Choose ontologies in the Brief
        </button>
      </div>
    );
  }
  const rows = mappingRows(definition ?? loaded.draftDef ?? loaded.liveDef);
  return (
    <div className="mapping-tab">
      <StagePanel
        api={api}
        projectId={projectId}
        stage="mapping"
        title="Ontology mapping"
        item={item}
        dataPolicy={dataPolicy}
        hasDraft={hasDraft}
        draft={draft}
        published={published}
        briefVersion={briefVersion}
        pollMs={pollMs}
        onApplied={onApplied}
        onSkipped={onSkipped}
        retired={retired}
        changeNote={mappingNote}
        changeBadge={(c) => mappingBadge(c)}
      />
      <section className="card mapping-current">
        <h3>Current mapping</h3>
        <table aria-label="Current mapping">
          <thead>
            <tr>
              <th>Output</th>
              <th>Term</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path} aria-label={r.path}>
                <td>
                  <code>{r.path}</code>
                </td>
                <td>{r.term ?? <span className="muted">Default vocabulary</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <a href={`#/workbench/${projectId}/template`}>Edit the mapping on the Recipe tab</a>
        </p>
      </section>
      <GraphPreview api={api} projectId={projectId} dirty={false} />
    </div>
  );
}
