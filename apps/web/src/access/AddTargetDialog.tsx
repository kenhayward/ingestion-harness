import { useId, useState, type FormEvent } from 'react';
import {
  publishTargetIdFrom,
  SSE_MODES,
  STORAGE_CLASSES,
  type TargetCreateBody,
  type TargetKind,
  type TargetLayout,
  type TargetTestResult,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { ConnectionPicker } from './ConnectionPicker.js';
import { LAYOUT_LABELS, TestOutcome } from './TargetRow.js';

const KINDS: readonly { value: TargetKind; label: string }[] = [
  { value: 'internal', label: 'Internal' },
  { value: 'external', label: 'External' },
];

/** Add a publishing target: an internal bucket on this deployment's S3, or an external one. */
export function AddTargetDialog({
  api,
  onClose,
  onAdded,
}: {
  api: Api;
  onClose: () => void;
  onAdded: () => void;
}) {
  const formId = useId();
  const [kind, setKind] = useState<TargetKind>('internal');
  const [label, setLabel] = useState('');
  const [id, setId] = useState<string | null>(null);
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('');
  const [layout, setLayout] = useState<TargetLayout>('files');
  const [connectionId, setConnectionId] = useState('');
  const [sse, setSse] = useState<(typeof SSE_MODES)[number]>('none');
  const [kms, setKms] = useState('');
  const [storageClass, setStorageClass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TargetTestResult | null>(null);

  const shownId = id ?? (label.trim() ? publishTargetIdFrom(label) : '');

  const body = (): TargetCreateBody => {
    const common = {
      ...(shownId ? { id: shownId } : {}),
      label: label.trim(),
      bucket: bucket.trim(),
      prefix: prefix.trim(),
      layout,
    };
    if (kind === 'internal') return { ...common, kind } as TargetCreateBody;
    return {
      ...common,
      kind,
      connectionId,
      sse,
      ...(sse === 'aws:kms' && kms.trim() ? { kmsKeyId: kms.trim() } : {}),
      ...(storageClass ? { storageClass: storageClass as TargetCreateBody['storageClass'] } : {}),
    };
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      await api.createPublishTarget(body());
      onAdded();
    });
  };
  const test = () =>
    void run(async () => {
      setResult(null);
      setResult(await api.testPublishTarget(body()));
    });

  const complete =
    label.trim() !== '' && bucket.trim() !== '' && (kind === 'internal' || connectionId !== '');

  const idHint = useId();
  const sseLabel = sse === 'none' ? 'None' : sse;
  const classLabel = storageClass || 'bucket default';

  return (
    <Dialog
      title="Add publishing target"
      icon={<Icon name="upload" size={32} />}
      description="Where a recipe delivers its published outputs: a bucket on this deployment's S3, or one elsewhere."
      className="target-dialog"
      onClose={onClose}
      actions={
        <>
          <button type="button" disabled={busy || !complete} onClick={test}>
            Test connection
          </button>
          <button type="submit" form={formId} className="primary" disabled={busy || !complete}>
            Add
          </button>
        </>
      }
    >
      <form id={formId} className="dialog-form target-form" onSubmit={submit}>
        <div className="target-kind">
          <span className="field-label">Kind</span>
          <Segmented
            label="Kind"
            options={KINDS}
            value={kind}
            onChange={(next) => {
              setKind(next);
              setResult(null);
            }}
          />
          <small className="muted">
            {kind === 'internal'
              ? "A bucket on this deployment's own S3."
              : 'An S3 bucket elsewhere, reached with a connection on the delivery bridge.'}
          </small>
        </div>
        <fieldset className="target-group">
          <legend>Where</legend>
          <div className="target-grid">
            <label>
              Label
              <input
                value={label}
                autoComplete="off"
                placeholder="Finance data lake"
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <div className="target-field">
              <label>
                Id
                <input
                  className="mono"
                  name="publish-target-id"
                  value={shownId}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={idHint}
                  onChange={(e) => setId(e.target.value)}
                />
              </label>
              <small id={idHint} className="muted">
                Use the same id on every deployment for the same recipient.
              </small>
            </div>
            <label>
              Bucket
              <input
                className="mono"
                value={bucket}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setBucket(e.target.value)}
              />
            </label>
            <label>
              Prefix
              <input
                className="mono"
                value={prefix}
                placeholder="none"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </label>
            <label>
              Layout
              <select value={layout} onChange={(e) => setLayout(e.target.value as TargetLayout)}>
                {(Object.keys(LAYOUT_LABELS) as TargetLayout[]).map((l) => (
                  <option key={l} value={l}>
                    {LAYOUT_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        {kind === 'external' && (
          <>
            <fieldset className="target-group">
              <legend>Connection</legend>
              <ConnectionPicker
                api={api}
                value={connectionId}
                onChange={(next) => {
                  setConnectionId(next);
                  setResult(null);
                }}
              />
            </fieldset>
            <details className="target-more">
              <summary>
                <span>Encryption and storage class</span>
                <span className="muted">
                  {sseLabel} · {classLabel}
                </span>
              </summary>
              <div className="target-grid">
                <label>
                  Server-side encryption
                  <select
                    value={sse}
                    onChange={(e) => setSse(e.target.value as (typeof SSE_MODES)[number])}
                  >
                    {SSE_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m === 'none' ? 'None' : m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Storage class
                  <select value={storageClass} onChange={(e) => setStorageClass(e.target.value)}>
                    <option value="">Bucket default</option>
                    {STORAGE_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                {sse === 'aws:kms' && (
                  <label className="target-span">
                    KMS key id
                    <input
                      className="mono"
                      value={kms}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setKms(e.target.value)}
                    />
                  </label>
                )}
              </div>
            </details>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <TestOutcome result={result} />
      </form>
    </Dialog>
  );
}
