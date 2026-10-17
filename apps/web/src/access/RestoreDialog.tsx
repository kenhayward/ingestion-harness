import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { BackupManifest, RestoreMode, RestoreStatus } from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModalFocus } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';
import {
  followRestore,
  forgetFollowedRestore,
  forgetUpload,
  formatSize,
  readStored,
  storedUploadFor,
  uploadBackup,
  type FollowedRestore,
} from './backup-upload.js';
import { RestoreOutcome } from './RestoreReport.js';

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

const when = (iso: string) => new Date(iso).toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ACTIVE: RestoreStatus['phase'][] = ['checking', 'checked', 'restoring'];

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
  resume,
  pollMs = 2000,
}: {
  api: Api;
  onClose: () => void;
  /** Sign in again after the restore ended every session. */
  onSignOut?: () => void;
  /** A restore this tab was following when its session ended: follow it again. */
  resume?: FollowedRestore | null;
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
  const [token, setToken] = useState<string | null>(resume?.token ?? null);
  const [uploadId, setUploadId] = useState<string | null>(resume?.uploadId ?? null);
  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  /** Reading the restore handed in by `resume` (until Try again starts a new one). */
  const [resuming, setResuming] = useState(resume != null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  /** The upload this browser remembers, once the server said whether it is complete. */
  const [stored, setStored] = useState<{ id: string; name: string; complete: boolean } | null>(
    null,
  );

  const phase = restore?.phase ?? null;
  const active = phase !== null && ACTIVE.includes(phase);

  useEffect(() => () => abort.current?.abort(), []);

  // Only an upload the server still has, and has only partly, was "partly uploaded".
  useEffect(() => {
    const remembered = readStored();
    if (!remembered || resume) return;
    let live = true;
    api.getUpload(remembered.id).then(
      (view) => {
        if (live) {
          const complete = view.received.length >= view.parts;
          setStored({ id: remembered.id, name: remembered.name, complete });
        }
      },
      () => {
        // Gone, or unreadable: nothing to resume.
      },
    );
    return () => {
      live = false;
    };
  }, [api, resume]);

  // Follow again the restore this tab followed before its session ended.
  useEffect(() => {
    if (!resume) return;
    api.getRestore(resume.restoreId, resume.token).then(setRestore, (err: unknown) => {
      forgetFollowedRestore(resume.restoreId);
      setError((err as Error).message);
    });
  }, [api, resume]);

  // While it runs, this tab remembers the restore; once it is over, it forgets it (and, after a
  // success, the upload it came from).
  useEffect(() => {
    if (!restore || !token) return;
    if (active) {
      followRestore({ restoreId: restore.id, token, uploadId });
      return;
    }
    forgetFollowedRestore(restore.id);
    if (restore.phase === 'succeeded' && uploadId) forgetUpload(uploadId);
  }, [restore, token, uploadId, active]);

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
      const id = await uploadBackup(api, file, {
        signal: controller.signal,
        onProgress: (sent, total) => setUpload({ sent, total }),
      });
      setUploadId(id);
      setBusy(true);
      const started = await api.startRestore({
        uploadId: id,
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
      forgetFollowedRestore(restore.id);
      setBusy(false);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const startAgain = () => {
    setResuming(false);
    setRestore(null);
    setToken(null);
    setUpload(null);
    setTyped('');
    setError(null);
  };

  const sameFile = file !== null && stored !== null && storedUploadFor(file) === stored.id;
  const canCheck = file !== null && (mode === 'deployment' || key.trim() !== '');
  const ended = phase === 'succeeded' || (phase === 'failed' && restore?.report);

  let body;
  let actions;
  if (resuming && restore === null) {
    body = error ? <p role="alert">{error}</p> : <p>Reading the restore…</p>;
  } else if (restore === null && !uploading) {
    body = (
      <form id={`${titleId}-form`} className="form-rows" onSubmit={check}>
        {error && <p role="alert">{error}</p>}
        {stored && !stored.complete && !file && (
          <p className="muted">
            {stored.name} was partly uploaded: choose it again to continue the upload.
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
          {sameFile && (
            <small className="muted">
              {stored.complete
                ? 'This file is already uploaded: it is checked without uploading it again.'
                : 'This file was partly uploaded: the upload continues where it stopped.'}
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
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
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
    body = <RestoreOutcome restore={restore} />;
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
