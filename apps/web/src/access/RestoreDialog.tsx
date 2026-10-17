import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { BackupManifest, RestoreMode, RestoreReport, RestoreStatus } from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModalFocus } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';
import { formatSize, storedUploadFor, UPLOAD_KEY, uploadBackup } from './backup-upload.js';

/** The check's answer to a key that does not open the file (`BackupKeyError`). */
const KEY_ERROR = 'this key does not open the backup';
const KEY_ERROR_TEXT = 'This key does not open the backup, or the file is damaged.';

const STEPS: Record<string, string> = {
  maintenance: 'Holding everyone else out',
  database: 'Restoring the database',
  migrations: 'Running the migrations',
  adjusting: 'Applying the copy rules',
  objects: 'Restoring files',
  identities: 'Restoring data-lake identities',
  triples: 'Restoring the triple store',
  swap: 'Switching to the restored database',
  finishing: 'Finishing',
};

const TRIPLES: Record<RestoreReport['triples'], string> = {
  restored: 'The triple store was restored.',
  'none-in-backup': 'The backup has no triple store: rebuild it with rdf_rebuild.',
  'no-triple-store': 'This server has no triple store: graphs were not loaded.',
  reminting: "Graphs are being re-minted under this server's base IRI.",
};

const when = (iso: string) => new Date(iso).toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ACTIVE: RestoreStatus['phase'][] = ['checking', 'checked', 'restoring'];

/** The name of the file whose upload this browser started and did not finish, else null. */
function interruptedUpload(): string | null {
  try {
    const raw = localStorage.getItem(UPLOAD_KEY);
    const name = raw ? (JSON.parse(raw) as { name?: unknown }).name : null;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Restore a backup (Administration > Backup > Restore…): upload the file in resumable parts,
 * pick the mode (and, for a copy, the source deployment's key), wait for the check, confirm by
 * typing the instance name, then follow the restore to its report. A restore ends every session,
 * so it is followed with the token the check handed out. It cannot be closed while the check or
 * the restore runs; a checked restore holds the lock until it is confirmed or cancelled.
 */
export function RestoreDialog({
  api,
  onClose,
  onSignOut,
  pollMs = 2000,
}: {
  api: Api;
  onClose: () => void;
  /** Sign in again after the restore ended every session. */
  onSignOut?: () => void;
  pollMs?: number;
}) {
  const titleId = useId();
  const fileId = useId();
  const keyId = useId();
  const keyHintId = useId();
  const confirmId = useId();
  const box = useRef<HTMLDivElement>(null);
  const trapTab = useModalFocus(box);

  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<RestoreMode>('deployment');
  const [key, setKey] = useState('');
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const [interrupted] = useState(interruptedUpload);

  const phase = restore?.phase ?? null;
  const active = phase !== null && ACTIVE.includes(phase);

  useEffect(() => () => abort.current?.abort(), []);

  // Follow the check and the restore (sessions end during it: the token keeps working).
  const restoreId = restore?.id ?? null;
  useEffect(() => {
    if (!restoreId || !token || !active) return;
    const timer = setInterval(() => {
      api.getRestore(restoreId, token).then(setRestore, () => {
        // The API is swapping databases or restarting: ask again on the next tick.
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [api, restoreId, token, active, pollMs]);

  const uploading = upload !== null && restore === null;
  const closable = !active && !busy;
  const close = () => {
    if (!closable) return;
    abort.current?.abort();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    trapTab(e);
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setUpload({ sent: 0, total: file.size });
    try {
      const uploadId = await uploadBackup(api, file, {
        signal: controller.signal,
        onProgress: (sent, total) => setUpload({ sent, total }),
      });
      setBusy(true);
      const started = await api.startRestore({
        uploadId,
        mode,
        ...(mode === 'copy' ? { key } : {}),
      });
      setToken(started.token);
      setRestore(started.status);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
      setUpload(null);
    } finally {
      setBusy(false);
      setKey('');
    }
  };

  const confirm = async () => {
    if (!restore || !token) return;
    setBusy(true);
    setError(null);
    try {
      setRestore(await api.confirmRestore(restore.id, typed, token));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!restore || !token) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelRestore(restore.id, token);
      setBusy(false);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const startAgain = () => {
    setRestore(null);
    setToken(null);
    setUpload(null);
    setTyped('');
    setError(null);
  };

  const resumes = file !== null && storedUploadFor(file) !== null;
  const canCheck = file !== null && (mode === 'deployment' || key.trim() !== '');
  const ended = phase === 'succeeded' || (phase === 'failed' && restore?.report);

  let body;
  let actions;
  if (restore === null && !uploading) {
    body = (
      <form id={`${titleId}-form`} className="form-rows" onSubmit={check}>
        {error && <p role="alert">{error}</p>}
        {interrupted && !file && (
          <p className="muted">
            {interrupted} was partly uploaded: choose it again to continue the upload.
          </p>
        )}
        <div className="maintenance-field">
          <label htmlFor={fileId}>Backup file</label>
          <input
            id={fileId}
            type="file"
            accept=".ctbak"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {resumes && (
            <small className="muted">
              This file was partly uploaded: the upload continues where it stopped.
            </small>
          )}
        </div>
        <fieldset className="restore-modes">
          <legend>Restore as</legend>
          <label className="restore-mode">
            <input
              type="radio"
              name={`${titleId}-mode`}
              checked={mode === 'deployment'}
              onChange={() => setMode('deployment')}
            />
            <span className="choice-text">
              <strong>Restore as this deployment</strong>
              <small>
                Disaster recovery, a server move: everything comes back as it was, with the
                backup&apos;s instance name and base IRI.
              </small>
            </span>
          </label>
          <label className="restore-mode">
            <input
              type="radio"
              name={`${titleId}-mode`}
              checked={mode === 'copy'}
              onChange={() => setMode('copy')}
            />
            <span className="choice-text">
              <strong>Restore as a copy</strong>
              <small>
                Production into staging: this server keeps its models, external targets, GitHub
                settings, data-lake keys and base IRI.
              </small>
            </span>
          </label>
        </fieldset>
        {mode === 'copy' && (
          <div className="maintenance-field">
            <label htmlFor={keyId}>Key</label>
            <input
              id={keyId}
              type="password"
              autoComplete="off"
              aria-describedby={keyHintId}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <small id={keyHintId} className="muted">
              The LLM_SECRETS_KEY of the deployment the backup came from. Used for this restore
              only, never stored.
            </small>
          </div>
        )}
        <p className="muted">Nothing changes on this server until you confirm, after the check.</p>
      </form>
    );
    actions = (
      <button
        type="submit"
        form={`${titleId}-form`}
        className="primary"
        disabled={!canCheck || busy}
      >
        Upload and check
      </button>
    );
  } else if (restore === null && upload) {
    body = (
      <div className="maintenance-field">
        <p>
          Uploading {file?.name}: {formatSize(upload.sent)} of {formatSize(upload.total)}
        </p>
        <Meter label="Upload progress" value={upload.total ? upload.sent / upload.total : 0} />
        <small className="muted">
          If the connection is lost, choose the same file again to continue.
        </small>
      </div>
    );
  } else if (restore && phase === 'checking') {
    body = (
      <div className="maintenance-field">
        <p>
          Checking the backup: {formatSize(restore.done)} of {formatSize(restore.of)} read. Nothing
          has changed yet.
        </p>
        <Meter label="Check progress" value={restore.of ? restore.done / restore.of : 0} />
      </div>
    );
  } else if (restore && phase === 'checked' && restore.manifest) {
    const instance = restore.manifest.instanceName;
    body = (
      <>
        {error && <p role="alert">{error}</p>}
        <ManifestSummary manifest={restore.manifest} />
        {restore.mode === 'copy' && restore.plan && (
          <div className="restore-plan">
            <div>
              <h3>Dropped from the backup</h3>
              <ul>
                {restore.plan.dropped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Kept from this server</h3>
              <ul>
                {restore.plan.kept.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div role="note" className="callout tone-warn">
          <Icon name="warning" size={22} />
          <span>
            Restoring replaces everything on this server. Everyone is signed out and the job queue
            stays paused until you resume it. This check expires after 30 minutes.
          </span>
        </div>
        <div className="maintenance-field">
          <label htmlFor={confirmId}>Type {instance} to confirm</label>
          <input
            id={confirmId}
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      </>
    );
    actions = (
      <>
        <button type="button" onClick={() => void cancel()} disabled={busy}>
          Cancel restore
        </button>
        <button
          type="button"
          className="primary danger"
          disabled={typed !== instance || busy}
          onClick={() => void confirm()}
        >
          Restore
        </button>
      </>
    );
  } else if (restore && phase === 'restoring') {
    body = (
      <div className="maintenance-field">
        <p>
          {STEPS[restore.step ?? ''] ?? 'Restoring'} (step {restore.done} of {restore.of}). Keep
          this window open: everyone, you included, is signed out at the end.
        </p>
        <Meter label="Restore progress" value={restore.of ? restore.done / restore.of : 0} />
      </div>
    );
  } else if (restore && (phase === 'succeeded' || phase === 'failed')) {
    const keyRefused = restore.error?.startsWith(KEY_ERROR) ?? false;
    body = (
      <>
        {phase === 'failed' && (
          <p role="alert">
            {keyRefused ? KEY_ERROR_TEXT : `The restore failed: ${restore.error ?? 'no reason'}`}
          </p>
        )}
        {restore.report && <Report report={restore.report} succeeded={phase === 'succeeded'} />}
      </>
    );
    actions = (
      <>
        {phase === 'failed' && !restore.report && (
          <button type="button" className="primary" onClick={startAgain}>
            Try again
          </button>
        )}
        {ended && onSignOut && (
          <button type="button" className="primary" onClick={onSignOut}>
            Sign in again
          </button>
        )}
      </>
    );
  }

  return (
    <div className="dialog-backdrop">
      <div
        ref={box}
        className="dialog dialog-rich restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-header">
          <span className="dialog-icon" aria-hidden="true">
            <Icon name="archive" />
          </span>
          <div>
            <h2 id={titleId}>Restore a backup</h2>
          </div>
        </div>
        <div className="dialog-body">{body}</div>
        <div className="dialog-actions">
          {closable && phase !== 'checked' && (
            <button type="button" onClick={close}>
              {restore ? 'Close' : 'Cancel'}
            </button>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}

function ManifestSummary({ manifest }: { manifest: BackupManifest }) {
  const bytes = manifest.parts.reduce((sum, p) => sum + p.bytes, 0);
  const files = manifest.buckets.reduce((sum, b) => sum + b.objects, 0);
  return (
    <dl className="restore-manifest">
      <dt>Instance</dt>
      <dd>{manifest.instanceName}</dd>
      <dt>Version</dt>
      <dd>{manifest.appVersion}</dd>
      <dt>Made</dt>
      <dd>
        {when(manifest.finishedAt)} by {manifest.createdBy}
      </dd>
      <dt>Size</dt>
      <dd>{formatSize(bytes)}</dd>
      <dt>Files</dt>
      <dd>
        {plural(files, 'file')} in {plural(manifest.buckets.length, 'bucket')}
      </dd>
      <dt>Triple store</dt>
      <dd>{manifest.fuseki ? 'Included' : 'Not included'}</dd>
      <dt>Data-lake identities</dt>
      <dd>{manifest.lakeIdentities}</dd>
    </dl>
  );
}

function Report({ report, succeeded }: { report: RestoreReport; succeeded: boolean }) {
  const rows = report.restored.reduce((sum, t) => sum + t.rows, 0);
  const copy = report.copy;
  return (
    <section className="restore-report" aria-label="Restore report">
      <h3>{succeeded ? 'Restored' : 'What was restored'}</h3>
      <ul>
        <li>
          {plural(rows, 'row')} in {plural(report.restored.length, 'table')} and{' '}
          {plural(report.objects, 'file')}.
        </li>
        <li>{TRIPLES[report.triples]}</li>
        <li>The previous database is kept as {report.previousDatabase}.</li>
        {report.adminTokenRotated ? (
          <li>The admin-from-the-log token was rotated: see the API log.</li>
        ) : (
          <li>
            The admin-from-the-log token was NOT rotated: the restore stopped before it. The token
            in the API log still signs in.
          </li>
        )}
        {report.lakeKeysToReissue.length > 0 && (
          <li>Data-lake keys to re-issue: {report.lakeKeysToReissue.join(', ')}</li>
        )}
        <li>
          Maintenance mode is on and the job queue is paused: switch them back once you have looked
          around.
        </li>
      </ul>
      {copy && (
        <>
          <h3>As a copy</h3>
          <ul>
            <li>{plural(copy.cancelledJobs, 'queued or running job')} cancelled.</li>
            <li>{plural(copy.withdrawnOutputs, 'delivered output')} marked withdrawn.</li>
            {copy.droppedTargets.length > 0 && (
              <li>External publishing targets dropped: {copy.droppedTargets.join(', ')}</li>
            )}
            {copy.recipesNeedingModel.length > 0 && (
              <li>
                Recipes naming a model choice this server lacks:{' '}
                {copy.recipesNeedingModel.join(', ')}
              </li>
            )}
            {copy.recipesNeedingTarget.length > 0 && (
              <li>
                Recipes naming a publishing target this server lacks:{' '}
                {copy.recipesNeedingTarget.join(', ')}
              </li>
            )}
          </ul>
        </>
      )}
      {report.missingObjects.length > 0 && (
        <>
          <h3>Files the database names but the backup lacks</h3>
          <ul className="restore-missing">
            {report.missingObjects.map((o) => (
              <li key={`${o.bucket}/${o.key}`}>
                <code>
                  {o.bucket}/{o.key}
                </code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
