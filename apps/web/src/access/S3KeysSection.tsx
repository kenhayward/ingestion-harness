import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type IssuedS3Key,
  type S3Consumer,
  type S3Key,
} from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { EXPIRY_OPTIONS, expiresSoon, expiryDays, expiryText, type Expiry } from './derive.js';

type Grace = '1' | '7' | '30';

const GRACE_OPTIONS: readonly { value: Grace; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

const STATUS: Record<S3Key['status'], { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'ok' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Read-only S3 keys for the data lake (ADR 0008), on the Access page: issue (secret shown once),
 * rotate with a grace period, revoke, delete. Admins only (the page checks).
 */
export function S3KeysSection({ api }: { api: Api }) {
  const [overview, setOverview] = useState<{ bucket: string; consumers: S3Consumer[] } | null>(
    null,
  );
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [issued, setIssued] = useState<IssuedS3Key | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api.listS3Keys());
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setUnavailable(err.message);
      else setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      setIssued(await api.createS3Key(label.trim(), expiryDays(expiry)));
      setLabel('');
    });
  };

  return (
    <section className="s3-keys" aria-labelledby="s3-keys-heading">
      <div>
        <h2 id="s3-keys-heading">Data lake S3 keys</h2>
        <p className="muted">
          Read-only keys for the published outputs
          {overview && (
            <>
              {' '}
              in the <code>{overview.bucket}</code> bucket
            </>
          )}
          . Issue one consumer per system; rotate with a grace period so it can switch keys without
          a gap, and revoke a key to stop it immediately.
        </p>
      </div>
      {unavailable ? (
        <p className="note-card">{unavailable}</p>
      ) : (
        <form className="card-form" onSubmit={create} aria-label="Issue an S3 key">
          <label>
            Consumer
            <input
              value={label}
              placeholder="e.g. Semantic index"
              maxLength={100}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <div className="field">
            <span className="field-label">Key expires after</span>
            <Segmented
              label="Key expires after"
              options={EXPIRY_OPTIONS}
              value={expiry}
              onChange={setExpiry}
            />
          </div>
          <button type="submit" className="primary" disabled={!label.trim()}>
            <Icon name="plus" />
            Create key
          </button>
        </form>
      )}
      {issued && (
        // Keyed per key: a second key starts uncopied (each secret is shown only once).
        <NewS3Key key={issued.key.id} issued={issued} onDone={() => setIssued(null)} />
      )}
      {error && <p role="alert">{error}</p>}
      {overview?.consumers.length === 0 && !unavailable && (
        <p className="muted">No consumers yet.</p>
      )}
      {overview?.consumers.map((c) => (
        <ConsumerCard
          key={c.id}
          consumer={c}
          onRotate={(days, grace) =>
            act(async () => setIssued(await api.rotateS3Key(c.id, days, grace)))
          }
          onRevoke={(keyId) => act(() => api.revokeS3Key(keyId))}
          onDelete={() => act(() => api.deleteS3Consumer(c.id))}
        />
      ))}
    </section>
  );
}

function ConsumerCard({
  consumer: c,
  onRotate,
  onRevoke,
  onDelete,
}: {
  consumer: S3Consumer;
  onRotate: (expiresInDays: number | null, graceDays: number) => Promise<void>;
  onRevoke: (keyId: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'rotate' | 'delete' | null>(null);
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [grace, setGrace] = useState<Grace>('7');
  const active = c.keys.filter((k) => k.status === 'active').length;
  const now = Date.now();

  const rotate = (e: FormEvent) => {
    e.preventDefault();
    setMode(null);
    void onRotate(expiryDays(expiry), Number(grace));
  };

  return (
    <section className="s3-consumer" aria-label={c.label}>
      <header className={mode === 'delete' ? 'confirming' : undefined}>
        <div>
          <strong>{c.label}</strong>
          {mode === 'delete' && (
            <small className="confirm-text">Delete {c.label}? Its keys stop working now.</small>
          )}
        </div>
        {mode === 'delete' ? (
          <div className="row-actions">
            <button type="button" onClick={() => setMode(null)}>
              Keep
            </button>
            <button
              type="button"
              className="danger-fill"
              onClick={() => {
                setMode(null);
                void onDelete();
              }}
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="row-actions">
            {active >= 2 ? (
              <span className="muted">Two active keys: revoke one to rotate.</span>
            ) : (
              <button type="button" onClick={() => setMode(mode === 'rotate' ? null : 'rotate')}>
                Rotate
              </button>
            )}
            <button
              type="button"
              className="icon bordered danger"
              aria-label={`Delete ${c.label}`}
              title="Delete"
              onClick={() => setMode('delete')}
            >
              <Icon name="trash" />
            </button>
          </div>
        )}
      </header>
      {mode === 'rotate' && (
        <form className="s3-rotate" onSubmit={rotate} aria-label={`Rotate ${c.label}`}>
          <div className="field">
            <span className="field-label">New key expires after</span>
            <Segmented
              label="New key expires after"
              options={EXPIRY_OPTIONS}
              value={expiry}
              onChange={setExpiry}
            />
          </div>
          <div className="field">
            <span className="field-label">Old key stops after</span>
            <Segmented
              label="Old key stops after"
              options={GRACE_OPTIONS}
              value={grace}
              onChange={setGrace}
            />
          </div>
          <div className="row-actions">
            <button type="button" onClick={() => setMode(null)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Rotate now
            </button>
          </div>
        </form>
      )}
      <div className="list-box">
        <table className="token-list" aria-label={`Keys for ${c.label}`}>
          <thead>
            <tr>
              <th>Access key ID</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Status</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {c.keys.map((k) => (
              <KeyRow key={k.id} s3Key={k} now={now} onRevoke={() => onRevoke(k.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function KeyRow({
  s3Key: k,
  now,
  onRevoke,
}: {
  s3Key: S3Key;
  now: number;
  onRevoke: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);
  const expiry = expiryText(k, now);
  const status = STATUS[k.status];
  const muted = k.status !== 'active';

  return (
    <tr className={confirm ? 'confirming' : muted ? 'muted-row' : undefined}>
      <td>
        <span className="mono">{k.accessKeyId}</span>
        {confirm && <small className="confirm-text">Revoke? The lake loses access now.</small>}
      </td>
      <td className="muted">{shortDate(k.createdAt)}</td>
      <td className={expiresSoon(k, now) ? 'expiry soon' : 'expiry'}>
        {expiry.date && <span>{expiry.date}</span>}
        <small>{expiry.relative}</small>
      </td>
      <td>
        <span className={`pill tone-${status.tone}`}>{status.label}</span>
      </td>
      <td className="actions-cell">
        {k.status !== 'active' ? null : confirm ? (
          <div className="row-actions">
            <button type="button" onClick={() => setConfirm(false)}>
              Keep
            </button>
            <button
              ref={confirmButton}
              type="button"
              className="danger-fill"
              onClick={() => {
                setConfirm(false);
                void onRevoke();
              }}
            >
              Revoke now
            </button>
          </div>
        ) : (
          <div className="row-actions">
            <button
              type="button"
              aria-label={`Revoke ${k.accessKeyId}`}
              onClick={() => setConfirm(true)}
            >
              Revoke
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function NewS3Key({ issued, onDone }: { issued: IssuedS3Key; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const id = useId();
  const copy = (name: string, value: string) => {
    // The clipboard API needs a secure context: on plain-HTTP LAN access it doesn't exist.
    if (!navigator.clipboard) {
      setNote(`Copying needs HTTPS here: select the ${name} and copy it manually.`);
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => setNote('Copied.'),
      () => setNote(`Copy failed: select the ${name} and copy it manually.`),
    );
  };
  const fields: { label: string; value: string }[] = [
    { label: 'Endpoint URL', value: issued.endpoint ?? '' },
    { label: 'Bucket', value: issued.bucket },
    { label: 'Access key ID', value: issued.key.accessKeyId },
    { label: 'Secret access key', value: issued.secretAccessKey },
  ];
  return (
    <div className="token-panel" role="region" aria-label="New S3 key">
      <div>
        <strong>Key created for “{issued.consumer.label}”</strong>
        <p>
          Give the lake these settings. Copy the secret now — this is the only time it is shown.
        </p>
        {!issued.endpoint && (
          <p>
            The endpoint is the URL your proxy publishes the S3 gateway on; set{' '}
            <code>S3_PUBLIC_URL</code> on the API to show it here.
          </p>
        )}
      </div>
      <div className="s3-fields">
        {fields.map((f, i) => (
          <div key={f.label} className="field">
            <label htmlFor={`${id}-${i}`}>{f.label}</label>
            <div className="token-copy">
              <input
                id={`${id}-${i}`}
                className="mono"
                readOnly
                value={f.value}
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                aria-label={`Copy ${f.label.toLowerCase()}`}
                disabled={!f.value}
                onClick={() => copy(f.label.toLowerCase(), f.value)}
              >
                Copy
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="row-actions">
        <button type="button" className="primary" onClick={onDone}>
          Done
        </button>
      </div>
      {note && <p role="status">{note}</p>}
    </div>
  );
}
