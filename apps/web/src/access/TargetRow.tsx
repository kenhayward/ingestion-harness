import { useId, useState } from 'react';
import {
  SSE_MODES,
  STORAGE_CLASSES,
  targetInUse,
  type PublishTargetView,
  type TargetLayout,
  type TargetPatchBody,
  type TargetTestResult,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { ConnectionPicker, connectionStatus } from './ConnectionPicker.js';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What uses a target: only the non-zero parts, else the (zero) document types. */
function usedBy(u: PublishTargetView['usage']): string {
  const parts = [
    u.documentTypes.length > 0 && count(u.documentTypes.length, 'document type'),
    u.deliveredOutputs > 0 && count(u.deliveredOutputs, 'delivered output'),
    u.consumers > 0 && count(u.consumers, 'S3 key consumer'),
    u.pendingJobs > 0 && count(u.pendingJobs, 'pending withdrawal'),
  ].filter(Boolean);
  return `used by ${parts.length > 0 ? parts.join(' · ') : count(0, 'document type')}`;
}

/** A sink target's destination fields on one line: `key: value · key: value`. */
function destinationText(d: Record<string, string>): string {
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

const REMOVE_BLOCKED = 'In use: a recipe version, output, key or withdrawal names it';

function whereFrom(t: PublishTargetView): string {
  if (t.editedAt !== null) return `edited by ${t.updatedBy ?? 'an admin'}`;
  if (t.source === 'env') return 'from .env';
  return `added here by ${t.updatedBy ?? 'an admin'}`;
}

/** The plain-words result of a connection test. */
export function TestOutcome({ result }: { result: TargetTestResult | null }) {
  if (!result) return null;
  if (result.ok) return <p role="status">Connection works. {result.message}</p>;
  return <p role="alert">{`Failed at ${result.step ?? 'connect'}: ${result.message}`}</p>;
}

/** How a target writes what it is given (an archive keeps whole packages). */
export const LAYOUT_LABELS: Record<TargetLayout, string> = {
  files: 'Files',
  package: 'Archive (whole package)',
};

/**
 * One publishing target: a row that opens on its settings. Bucket and prefix are read-only while
 * anything uses the target; label, connection and encryption always change. Credentials live on
 * the delivery bridge's connections page, never here.
 */
export function TargetRow({
  api,
  target: t,
  onChanged,
}: {
  api: Api;
  target: PublishTargetView;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(t.label);
  // Null for a target of a sink other than S3 (none is edited here yet).
  const [bucket, setBucket] = useState(t.bucket ?? '');
  const [prefix, setPrefix] = useState(t.prefix ?? '');
  const [layout, setLayout] = useState(t.layout ?? 'files');
  const [connectionId, setConnectionId] = useState(t.connectionId ?? '');
  const [sse, setSse] = useState<string>(t.sse ?? 'none');
  const [kms, setKms] = useState(t.kmsKeyId ?? '');
  const [storageClass, setStorageClass] = useState(t.storageClass ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TargetTestResult | null>(null);
  const bodyId = useId();
  const external = t.kind === 'external';
  // The triple store (seeded from RDF_ENDPOINT): only its label changes here.
  const tripleStore = t.kind === 'rdf';
  // A target of a sink this page does not edit yet: shown, never changed.
  const otherSink = t.kind === 'sink';
  // The bridge no longer has it: nothing here can be saved until it is added back.
  const gone = !t.onBridge;
  const locked = targetInUse(t.usage);
  const usedByText = usedBy(t.usage);

  /**
   * Only what differs from the stored target; an emptied KMS key or storage class is `null`,
   * which clears it, and so is the KMS key once encryption leaves KMS.
   */
  const changes = (): TargetPatchBody => {
    const c: TargetPatchBody = {};
    if (label.trim() !== t.label) c.label = label.trim();
    if (tripleStore) return c;
    if (!locked) {
      if (bucket.trim() !== t.bucket) c.bucket = bucket.trim();
      if (prefix.trim() !== t.prefix) c.prefix = prefix.trim();
      if (layout !== t.layout) c.layout = layout;
    }
    if (external) {
      if (connectionId && connectionId !== (t.connectionId ?? '')) c.connectionId = connectionId;
      if (sse !== t.sse) c.sse = sse as TargetPatchBody['sse'];
      const kmsKey = sse === 'aws:kms' ? kms.trim() : '';
      if (kmsKey !== (t.kmsKeyId ?? '')) c.kmsKeyId = kmsKey || null;
      if (storageClass !== (t.storageClass ?? '')) {
        c.storageClass = (storageClass || null) as TargetPatchBody['storageClass'];
      }
    }
    return c;
  };
  const patch = changes();
  const dirty = Object.keys(patch).length > 0;

  const act = async (action: () => Promise<unknown>, reload = true) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      if (reload) await onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setResult(null);
    await act(async () => setResult(await api.testPublishTarget({ id: t.id })), false);
  };

  return (
    <section
      className={open ? 'endpoint-row open' : 'endpoint-row'}
      aria-label={`Target ${t.label}`}
    >
      <button
        type="button"
        className="endpoint-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronDown" />
        <span>{t.label}</span>
        <span className="mono endpoint-name">{t.id}</span>
        <span className="tag tone-neutral">
          {otherSink ? t.sinkId : tripleStore ? 'Triple store' : external ? 'External' : 'Internal'}
        </span>
        {gone && <span className="tag tone-warn">Not on the bridge</span>}
        {t.layout === 'package' && <span className="tag tone-neutral">Archive</span>}
        <span className="mono muted">
          {otherSink
            ? destinationText(t.destination)
            : tripleStore
              ? `${t.endpoint ?? 'endpoint not known'} · dataset ${t.bucket}`
              : `${t.bucket}/${t.prefix}`}
        </span>
        <span className="endpoint-count">{usedByText}</span>
        <span className="muted endpoint-where">{whereFrom(t)}</span>
      </button>
      {open && (
        <form
          id={bodyId}
          className="endpoint-body dialog-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (dirty) {
              void act(() => api.updatePublishTarget(t.id, patch)).then((ok) => {
                if (ok) setResult(null);
              });
            }
          }}
        >
          {gone && (
            <p className="muted">
              The delivery bridge no longer has this target; deliveries to it fail until it is added
              back.
            </p>
          )}
          <label>
            Label
            <input value={label} readOnly={gone} onChange={(ev) => setLabel(ev.target.value)} />
          </label>
          {otherSink ? (
            <ul className="muted mono">
              {Object.entries(t.destination).map(([k, v]) => (
                <li key={k}>{`${k}: ${v}`}</li>
              ))}
            </ul>
          ) : tripleStore ? (
            <p className="muted">
              From RDF_ENDPOINT: recipes that deliver RDF load their graphs into dataset{' '}
              <span className="mono">{t.bucket}</span> at{' '}
              <span className="mono">{t.endpoint ?? 'endpoint not known'}</span>.{' '}
              {t.connection
                ? connectionStatus(t.connection)
                : 'Its connection is not known now: see Manage connections'}
            </p>
          ) : (
            <>
              <label>
                Bucket
                <input
                  value={bucket}
                  readOnly={locked || gone}
                  onChange={(ev) => setBucket(ev.target.value)}
                />
              </label>
              <label>
                Prefix
                <input
                  value={prefix}
                  readOnly={locked || gone}
                  placeholder="none"
                  onChange={(ev) => setPrefix(ev.target.value)}
                />
              </label>
              <label>
                Layout
                <select
                  value={layout}
                  disabled={locked || gone}
                  onChange={(ev) => setLayout(ev.target.value as TargetLayout)}
                >
                  {(Object.keys(LAYOUT_LABELS) as TargetLayout[]).map((l) => (
                    <option key={l} value={l}>
                      {LAYOUT_LABELS[l]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {external && !otherSink && (
            <>
              <ConnectionPicker
                api={api}
                value={connectionId}
                current={t.connection}
                onChange={setConnectionId}
              />
              <p className="muted">
                {t.connection
                  ? connectionStatus(t.connection)
                  : t.connectionId
                    ? `Connection ${t.connectionId}: its status is not known now`
                    : 'No connection: choose one, or add it under Manage connections'}
              </p>
              <label>
                Server-side encryption
                <select value={sse} disabled={gone} onChange={(ev) => setSse(ev.target.value)}>
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
                  <input value={kms} readOnly={gone} onChange={(ev) => setKms(ev.target.value)} />
                </label>
              )}
              <label>
                Storage class
                <select
                  value={storageClass}
                  disabled={gone}
                  onChange={(ev) => setStorageClass(ev.target.value)}
                >
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
          {locked && !tripleStore && !otherSink && (
            <small className="muted">In use: add a new target to move bucket or prefix.</small>
          )}
          {error && <p role="alert">{error}</p>}
          <TestOutcome result={result} />
          <div className="endpoint-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || gone || !dirty || !label.trim()}
            >
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => void test()}>
              Test connection
            </button>
            {t.id !== 'default' && !tripleStore && !confirmRemove && (
              <button
                type="button"
                className="danger"
                disabled={locked}
                title={locked ? REMOVE_BLOCKED : undefined}
                onClick={() => setConfirmRemove(true)}
              >
                <Icon name="trash" />
                Remove
              </button>
            )}
            {t.id !== 'default' && !tripleStore && locked && (
              <small className="muted">{REMOVE_BLOCKED}</small>
            )}
          </div>
          {confirmRemove && (
            <p className="confirm-text">
              Remove {t.label}?{' '}
              <button
                type="button"
                className="danger"
                aria-label={`Confirm remove ${t.label}`}
                disabled={busy}
                onClick={() => void act(() => api.deletePublishTarget(t.id))}
              >
                Remove
              </button>{' '}
              <button type="button" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </p>
          )}
        </form>
      )}
    </section>
  );
}
