import { useId, useState, type FormEvent } from 'react';
import {
  publishTargetIdFrom,
  SSE_MODES,
  STORAGE_CLASSES,
  type TargetCreateBody,
  type TargetKind,
  type TargetTestResult,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Segmented } from '../ui/Segmented.js';
import { TestOutcome } from './TargetRow.js';

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
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [pathStyle, setPathStyle] = useState(false);
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
    };
    if (kind === 'internal') return { ...common, kind } as TargetCreateBody;
    return {
      ...common,
      kind,
      ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
      region: region.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secret.trim(),
      forcePathStyle: pathStyle,
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
    label.trim() !== '' &&
    bucket.trim() !== '' &&
    (kind === 'internal' || (region.trim() && accessKeyId.trim() && secret.trim()));

  return (
    <Dialog
      title="Add publishing target"
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
      <form id={formId} className="dialog-form" onSubmit={submit}>
        <div className="field">
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
              : 'An S3 bucket elsewhere, reached with its own keys.'}
          </small>
        </div>
        <label>
          Label
          <input
            value={label}
            placeholder="Finance data lake"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Id
          <input value={shownId} onChange={(e) => setId(e.target.value)} />
        </label>
        <small className="muted">Use the same id on every deployment for the same recipient.</small>
        <label>
          Bucket
          <input value={bucket} onChange={(e) => setBucket(e.target.value)} />
        </label>
        <label>
          Prefix
          <input value={prefix} placeholder="none" onChange={(e) => setPrefix(e.target.value)} />
        </label>
        {kind === 'external' && (
          <>
            <label>
              Endpoint
              <input
                value={endpoint}
                placeholder="AWS S3"
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <label>
              Region
              <input value={region} onChange={(e) => setRegion(e.target.value)} />
            </label>
            <label>
              Access key id
              <input
                autoComplete="off"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
              />
            </label>
            <label>
              Secret access key
              <input
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={pathStyle}
                onChange={(e) => setPathStyle(e.target.checked)}
              />
              Path-style addressing
            </label>
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
            {sse === 'aws:kms' && (
              <label>
                KMS key id
                <input value={kms} onChange={(e) => setKms(e.target.value)} />
              </label>
            )}
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
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <TestOutcome result={result} />
      </form>
    </Dialog>
  );
}
