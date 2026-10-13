import { useState, type ReactNode } from 'react';
import type { DataPolicy, ModelChoice } from '@ih/shared';
import { Dialog } from './Dialog.js';
import { ModelPicker } from './ModelPicker.js';

/**
 * The one confirmation for every re-run (ADR 0010, phase 4d): says what will run (`summary`),
 * offers the model choices (or shows the model a
 * run must use, `fixedModel`), then any fields the caller owns (`children`), and runs only on the confirm button. A refusal stays in the
 * dialog with its reason; success closes it.
 */
export function ReprocessDialog({
  title,
  confirmLabel,
  choices,
  initialModel = '',
  emptyLabel,
  dataPolicy,
  fixedModel,
  noModel = false,
  canConfirm = true,
  onConfirm,
  onClose,
  summary,
  children,
}: {
  title: string;
  confirmLabel: string;
  choices: readonly ModelChoice[];
  /** A choice id, or '' for `emptyLabel`. */
  initialModel?: string;
  /** The "no override" option, e.g. "Document type's models"; absent: a choice must be picked. */
  emptyLabel?: string;
  dataPolicy?: DataPolicy;
  /** The model this run always uses, shown instead of the picker (it gets null). */
  fixedModel?: string;
  /** No model field: the caller's fields choose (a comparison's set of choices, say). */
  noModel?: boolean;
  /** False while the caller's own fields are incomplete. */
  canConfirm?: boolean;
  /** Runs it with the picked choice's id (null: no override); a rejection is shown here. */
  onConfirm: (model: string | null) => Promise<unknown>;
  onClose: () => void;
  /** What will run, above the model. */
  summary?: ReactNode;
  /** The caller's own fields (guidance, pages…), below the model. */
  children?: ReactNode;
}) {
  const [picked, setModel] = useState(initialModel);
  // Without an empty option, the default choice is picked until another one is (choices may
  // arrive after the dialog opens).
  const model =
    picked || (emptyLabel === undefined ? (choices.find((c) => c.isDefault)?.id ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(fixedModel === undefined && !noModel && model ? model : null);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="primary"
          disabled={
            busy ||
            !canConfirm ||
            (!noModel && emptyLabel === undefined && !model && fixedModel === undefined)
          }
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </button>
      }
    >
      <div className="reprocess-body">
        {summary}
        {!noModel && (
          <div className="field">
            <span className="field-label">Model</span>
            {fixedModel !== undefined ? (
              <span className="reprocess-fixed">{fixedModel}</span>
            ) : (
              <ModelPicker
                label="Model"
                choices={choices}
                value={model}
                emptyLabel={emptyLabel}
                dataPolicy={dataPolicy}
                onChange={setModel}
              />
            )}
          </div>
        )}
        {children}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
