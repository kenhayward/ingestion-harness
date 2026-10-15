import { useId, useState } from 'react';
import { deliveryTargets, setDeliveryTarget, type DeliveryTarget } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

const LABEL: Record<DeliveryTarget, string> = {
  s3: 'S3 (CSV + JSON)',
  rdf: 'RDF (triple store)',
};
const LAST = 'At least one output stays on.';

/**
 * The Outputs tab's switches for where the draft's outputs go (`deliveryTargets`). Each click
 * saves the draft, as a hand edit; RDF off also deletes the ontology mapping, after a confirm.
 */
export function DeliveryTargets({
  api,
  projectId,
  draftVersion,
  definition,
  updatedAt,
  onSaved,
}: {
  api: Api;
  projectId: string;
  draftVersion: number;
  definition: Record<string, unknown>;
  /** The loaded draft's `updatedAt`, sent as `baseUpdatedAt` (409 when it moved). */
  updatedAt: string | null;
  onSaved: () => void;
}) {
  const labelId = useId();
  const lastId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const targets = deliveryTargets(definition);

  const save = async (target: DeliveryTarget, on: boolean) => {
    setConfirmOff(false);
    setBusy(true);
    setError(null);
    try {
      await api.saveTemplate(
        projectId,
        draftVersion,
        setDeliveryTarget(definition, target, on),
        updatedAt ?? undefined,
      );
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const click = (target: DeliveryTarget) => {
    if (target === 'rdf' && targets.rdf) setConfirmOff(true);
    else void save(target, !targets[target]);
  };

  return (
    <div className="delivery-targets">
      <div className="chips" role="group" aria-labelledby={labelId}>
        <span id={labelId} className="card-label">
          Delivered outputs
        </span>
        {(['s3', 'rdf'] as const).map((target) => {
          const last = targets[target] && !targets[target === 's3' ? 'rdf' : 's3'];
          return (
            <button
              key={target}
              type="button"
              className="chip"
              aria-pressed={targets[target]}
              aria-describedby={last ? lastId : undefined}
              disabled={busy || last}
              onClick={() => click(target)}
            >
              {LABEL[target]}
            </button>
          );
        })}
        <span id={lastId} hidden>
          {LAST}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {confirmOff && (
        <Dialog
          title="Turn RDF off?"
          onClose={() => setConfirmOff(false)}
          actions={
            <button type="button" className="danger" onClick={() => void save('rdf', false)}>
              Turn RDF off
            </button>
          }
        >
          <p>
            This stops publishing a graph for each document and deletes the ontology mapping from
            draft v{draftVersion}. Pinned ontologies stay pinned on the Survey tab.
          </p>
        </Dialog>
      )}
    </div>
  );
}
