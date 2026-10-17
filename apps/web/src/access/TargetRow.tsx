import { useId, useState } from 'react';
import {
  SSE_MODES,
  STORAGE_CLASSES,
  targetInUse,
  type PublishTargetView,
  type TargetPatchBody,
  type TargetTestResult,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';

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

/**
 * One publishing target: a row that opens on its settings. Bucket, prefix, endpoint and region
 * are read-only while anything uses the target; keys, label and encryption always change.
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
  const [bucket, setBucket] = useState(t.bucket);
  const [prefix, setPrefix] = useState(t.prefix);
  const [endpoint, setEndpoint] = useState(t.endpoint ?? '');
  const [region, setRegion] = useState(t.region ?? '');
  const [pathStyle, setPathStyle] = useState(t.forcePathStyle);
  const [sse, setSse] = useState<string>(t.sse);
  const [kms, setKms] = useState(t.kmsKeyId ?? '');
  const [storageClass, setStorageClass] = useState(t.storageClass ?? '');
  const [keys, setKeys] = useState<{ id: string; secret: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TargetTestResult | null>(null);
  const bodyId = useId();
  const external = t.kind === 'external';
  const locked = targetInUse(t.usage);
  const usedByText = usedBy(t.usage);

  /**
   * Only what differs from the stored target (keys always as a pair); an emptied endpoint, KMS
   * key or storage class is `null`, which clears it, and so is the KMS key once encryption
   * leaves KMS.
   */
  const changes = (): TargetPatchBody => {
    const c: TargetPatchBody = {};
    if (label.trim() !== t.label) c.label = label.trim();
    if (!locked) {
      if (bucket.trim() !== t.bucket) c.bucket = bucket.trim();
      if (prefix.trim() !== t.prefix) c.prefix = prefix.trim();
    }
    if (external) {
      if (!locked) {
        if (endpoint.trim() !== (t.endpoint ?? '')) c.endpoint = endpoint.trim() || null;
        if (region.trim() && region.trim() !== (t.region ?? '')) c.region = region.trim();
      }
      if (pathStyle !== t.forcePathStyle) c.forcePathStyle = pathStyle;
      if (sse !== t.sse) c.sse = sse as TargetPatchBody['sse'];
      const kmsKey = sse === 'aws:kms' ? kms.trim() : '';
      if (kmsKey !== (t.kmsKeyId ?? '')) c.kmsKeyId = kmsKey || null;
      if (storageClass !== (t.storageClass ?? '')) {
        c.storageClass = (storageClass || null) as TargetPatchBody['storageClass'];
      }
      if (keys) {
        c.accessKeyId = keys.id.trim();
        c.secretAccessKey = keys.secret.trim();
      }
    }
    return c;
  };
  const patch = changes();
  const dirty = Object.keys(patch).length > 0;
  const keysIncomplete = keys !== null && (!keys.id.trim() || !keys.secret.trim());

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
    await act(async () => setResult(await api.testPublishTarget({ id: t.id, ...patch })), false);
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
        <span className="tag tone-neutral">{external ? 'External' : 'Internal'}</span>
        <span className="mono muted">
          {t.bucket}/{t.prefix}
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
            if (dirty && !keysIncomplete) {
              void act(() => api.updatePublishTarget(t.id, patch)).then((ok) => {
                if (!ok) return;
                setKeys(null);
                setResult(null);
              });
            }
          }}
        >
          <label>
            Label
            <input value={label} onChange={(ev) => setLabel(ev.target.value)} />
          </label>
          <label>
            Bucket
            <input value={bucket} readOnly={locked} onChange={(ev) => setBucket(ev.target.value)} />
          </label>
          <label>
            Prefix
            <input
              value={prefix}
              readOnly={locked}
              placeholder="none"
              onChange={(ev) => setPrefix(ev.target.value)}
            />
          </label>
          {external && (
            <>
              <label>
                Endpoint
                <input
                  value={endpoint}
                  readOnly={locked}
                  placeholder="AWS S3"
                  onChange={(ev) => setEndpoint(ev.target.value)}
                />
              </label>
              <label>
                Region
                <input
                  value={region}
                  readOnly={locked}
                  onChange={(ev) => setRegion(ev.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={pathStyle}
                  onChange={(ev) => setPathStyle(ev.target.checked)}
                />
                Path-style addressing
              </label>
              <label>
                Server-side encryption
                <select value={sse} onChange={(ev) => setSse(ev.target.value)}>
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
                  <input value={kms} onChange={(ev) => setKms(ev.target.value)} />
                </label>
              )}
              <label>
                Storage class
                <select value={storageClass} onChange={(ev) => setStorageClass(ev.target.value)}>
                  <option value="">Bucket default</option>
                  {STORAGE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span className="field-label">Credentials</span>
                {keys === null ? (
                  <span>
                    <span>
                      {t.keysFromEnv
                        ? `Keys from .env (${t.keysFromEnv.accessKey}, ${t.keysFromEnv.secretKey})`
                        : t.secretSet
                          ? 'Secret stored (encrypted)'
                          : 'No secret'}
                    </span>{' '}
                    <button type="button" onClick={() => setKeys({ id: '', secret: '' })}>
                      Set secret
                    </button>
                  </span>
                ) : (
                  <span className="inline-edit">
                    <input
                      aria-label="New access key id"
                      autoComplete="off"
                      value={keys.id}
                      onChange={(ev) => setKeys({ ...keys, id: ev.target.value })}
                    />
                    <input
                      type="password"
                      aria-label="New secret access key"
                      autoComplete="off"
                      value={keys.secret}
                      onChange={(ev) => setKeys({ ...keys, secret: ev.target.value })}
                    />
                    <button type="button" onClick={() => setKeys(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </div>
            </>
          )}
          {locked && (
            <small className="muted">
              In use: add a new target to move bucket, prefix, endpoint or region.
            </small>
          )}
          {error && <p role="alert">{error}</p>}
          <TestOutcome result={result} />
          <div className="endpoint-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || !dirty || keysIncomplete || !label.trim()}
            >
              Save
            </button>
            <button type="button" disabled={busy || keysIncomplete} onClick={() => void test()}>
              Test connection
            </button>
            {t.id !== 'default' && !confirmRemove && (
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
            {t.id !== 'default' && locked && <small className="muted">{REMOVE_BLOCKED}</small>}
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
