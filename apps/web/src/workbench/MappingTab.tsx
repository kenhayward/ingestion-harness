import { useState } from 'react';
import { deliveryTargets, type DataPolicy, type OverviewItem } from '@ih/shared';
import type { Api } from '../api/client.js';
import { GraphPreview } from '../templates/MappingEditor.js';
import { mappingBadge, mappingNote } from './mapping.js';
import { MappingReview } from './MappingReview.js';
import { StagePanel } from './StagePanel.js';
import { useDefinitions } from './useDefinitions.js';

/**
 * The Mapping tab (ADR 0011): the model proposes the recipe's ontology mapping from the brief's
 * ontologies and the values the dev samples produced; each change shows the model's confidence,
 * the values behind it and the terms it was chosen over. The proposal is reviewed in the Recipe
 * tab's outline (MappingReview); without one the outline shows the mapping as it is. Below: the
 * graph a dev sample would publish.
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
  /** Goes up when the applied proposal's "Preview the graph" is pressed: GraphPreview starts. */
  const [previewRequest, setPreviewRequest] = useState(0);
  const loaded = useDefinitions(api, projectId, draft, published, definition === undefined);
  const shown = definition ?? loaded.draftDef ?? loaded.liveDef;
  if (definition === undefined && hasDraft && loaded.draftDef === null && loaded.error === null) {
    return <p>Loading…</p>;
  }
  // The Outputs tab's RDF switch comes first, as in the overview (`overviewItems`).
  if (shown && !deliveryTargets(shown).rdf) {
    return (
      <div className="mapping-tab">
        <p className="banner tone-skip">
          Not used: RDF is off on the Outputs tab. Turn RDF on there to publish each document as a
          graph, and map its outputs to ontology terms here.
        </p>
        <button type="button" onClick={() => onNavigate(`#/workbench/${projectId}/outputs`)}>
          Turn RDF on in Outputs
        </button>
      </div>
    );
  }
  if (!used) {
    return (
      <div className="mapping-tab">
        <p className="banner tone-skip">
          Not used: no vocabulary is pinned on Survey. Pin the customer or industry ontologies this
          document type maps to on the Survey tab, and the model will propose a mapping from their
          terms.
        </p>
        <button
          type="button"
          onClick={() => onNavigate(`#/workbench/${projectId}/survey/ontologies`)}
        >
          Choose ontologies on Survey
        </button>
      </div>
    );
  }
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
        onApplied={() => {
          // Applying changes the open draft in place: reload it so the outline shows it.
          if (definition === undefined) void loaded.reload();
          onApplied();
        }}
        onSkipped={onSkipped}
        retired={retired}
        changeNote={mappingNote}
        changeBadge={(c) => mappingBadge(c)}
        nextAction={
          <button type="button" className="primary" onClick={() => setPreviewRequest((n) => n + 1)}>
            Preview the graph
          </button>
        }
        review={(state) => (
          <MappingReview api={api} projectId={projectId} definition={shown} review={state} />
        )}
      />
      <GraphPreview api={api} projectId={projectId} dirty={false} request={previewRequest} />
    </div>
  );
}
