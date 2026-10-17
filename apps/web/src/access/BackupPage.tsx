import { useCallback, useEffect, useState } from 'react';
import type { BackupView, QueueControlView } from '@ih/shared';
import type { Api, BackupStatus, Me } from '../api/client.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { InSlot } from '../ui/InSlot.js';
import { Meter } from '../ui/Meter.js';
import { formatSize } from './backup-upload.js';
import { RestoreDialog } from './RestoreDialog.js';

export const ENV_WARNING =
  'Keep a copy of deploy/.env somewhere other than this server. Without its LLM_SECRETS_KEY this backup cannot be opened.';

const when = (iso: string) => new Date(iso).toLocaleString();

const PHASES: Record<NonNullable<BackupView['progress']>['phase'], string> = {
  database: 'Dumping the database',
  objects: 'Copying files',
  identities: 'Saving data-lake identities',
  triples: 'Saving the triple store',
  finishing: 'Encrypting and finishing',
};

function progressText(view: BackupView): string {
  const p = view.progress;
  if (!p) return 'Starting…';
  const count = p.of > 0 ? `: ${p.done} of ${p.of}` : '';
  return `${PHASES[p.phase]}${count} · ${formatSize(p.bytes)} written`;
}

/**
 * Administration > Backup: make an encrypted backup of the whole stack and download it, restore
 * one (as this deployment, or as a copy), and see the job queue a restore leaves paused. Admins
 * only.
 */
export function BackupPage({
  api,
  me,
  actions,
  onOpenMaintenance,
  onSignOut,
  pollMs = 2000,
}: {
  api: Api;
  me: Me;
  /** Where Create backup goes (the Administration dialog's header); in place without one. */
  actions?: HTMLElement | null;
  /** Opens the Maintenance tab (the pointer shown while maintenance is on). */
  onOpenMaintenance?: () => void;
  /** A restore ended every session: Sign in again. */
  onSignOut?: () => void;
  /** How often a running backup is read again. */
  pollMs?: number;
}) {
  const isAdmin = me.role === 'admin';
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [maintenanceOn, setMaintenanceOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getBackupStatus());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
    api.getMaintenance().then(
      (m) => setMaintenanceOn(m.enabled),
      () => setMaintenanceOn(false),
    );
  }, [api, isAdmin, load]);

  const running = status?.backup?.status === 'running';
  useEffect(() => {
    if (!running || restoring) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [running, restoring, load, pollMs]);

  if (!isAdmin) return <p>Admins only.</p>;

  const create = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await api.startBackup();
      setStatus((s) => (s ? { ...s, backup: started } : s));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const resume = async () => {
    setError(null);
    try {
      const queue = await api.setQueuePaused(false);
      setStatus((s) => (s ? { ...s, queue } : s));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const latest = status?.backup ?? null;
  const good = status?.lastSucceeded ?? null;

  return (
    <div className="models-page">
      <p className="muted admin-lead">
        A backup holds everything CT Studio keeps: the database, every file of its buckets and of
        internal publishing targets, and the triple store. It is encrypted with this
        deployment&apos;s LLM_SECRETS_KEY. Only the newest backup is kept on this server.
      </p>
      <InSlot slot={actions}>
        <button
          type="button"
          className="primary"
          onClick={() => void create()}
          disabled={!status || running || starting}
        >
          <Icon name="archive" />
          Create backup
        </button>
      </InSlot>
      <div role="note" className="callout tone-warn">
        <Icon name="warning" size={22} />
        <span>{ENV_WARNING}</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {status === null && !error && <p>Loading…</p>}
      {status && (
        <>
          <section className="admin-section" aria-label="Backup">
            <div className="admin-section-head">
              <div>
                <div className="profile-actions">
                  <h3>Backup</h3>
                  <HelpButton topic="backup" />
                </div>
                <p className="muted">Download it and keep it off this server.</p>
              </div>
            </div>
            {latest?.status === 'running' && (
              <div className="maintenance-field">
                <p>
                  Backing up, started {when(latest.startedAt)} by {latest.createdBy}.
                </p>
                <Meter
                  label="Backup progress"
                  value={
                    latest.progress && latest.progress.of > 0
                      ? latest.progress.done / latest.progress.of
                      : 0
                  }
                />
                <p className="muted">{progressText(latest)}</p>
              </div>
            )}
            {latest?.status === 'failed' && (
              <p role="status" className="callout tone-warn">
                The backup started {when(latest.startedAt)} failed: {latest.error ?? 'no reason'}.
                {good ? ' The previous backup is still there.' : ''}
              </p>
            )}
            {good ? (
              <p>
                Latest backup: {when(good.finishedAt ?? good.startedAt)} by {good.createdBy}
                {good.bytes !== null && ` · ${formatSize(good.bytes)}`} ·{' '}
                <a href={api.backupDownloadUrl(good.id)} download>
                  <Icon name="download" />
                  Download
                </a>
              </p>
            ) : (
              !running && <p className="muted">No backup yet.</p>
            )}
          </section>
          <section className="admin-section" aria-label="Restore">
            <div className="admin-section-head">
              <div>
                <h3>Restore</h3>
                <p className="muted">
                  Replaces everything on this server with a backup: as this deployment (disaster
                  recovery, a server move) or as a copy (production into staging).
                </p>
              </div>
            </div>
            {status.restore &&
              ['checking', 'checked', 'restoring'].includes(status.restore.phase) && (
                <p className="muted">
                  A restore started by {status.restore.startedBy} is {status.restore.phase}.
                </p>
              )}
            <div>
              <button type="button" onClick={() => setRestoring(true)}>
                Restore…
              </button>
            </div>
          </section>
          <section className="admin-section" aria-label="Queue">
            <QueueLine queue={status.queue} onResume={() => void resume()} />
            {maintenanceOn && (
              <p className="muted">
                Maintenance mode is on: only admins can use CT Studio. Switch it off on the{' '}
                {onOpenMaintenance ? (
                  <button type="button" className="link" onClick={onOpenMaintenance}>
                    Maintenance tab
                  </button>
                ) : (
                  'Maintenance tab'
                )}
                .
              </p>
            )}
          </section>
        </>
      )}
      {restoring && (
        <RestoreDialog
          api={api}
          onSignOut={onSignOut}
          onClose={() => {
            setRestoring(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function QueueLine({ queue, onResume }: { queue: QueueControlView; onResume: () => void }) {
  if (!queue.paused) {
    return (
      <p>
        <strong>Queue:</strong> Running.
      </p>
    );
  }
  return (
    <p>
      <strong>Queue:</strong> Paused
      {queue.pausedBy ? ` by ${queue.pausedBy}` : ''}
      {queue.pausedAt ? ` since ${when(queue.pausedAt)}` : ''}
      {queue.reason ? ` (${queue.reason})` : ''}: no job starts until it is resumed.{' '}
      <button type="button" onClick={onResume}>
        Resume queue
      </button>
    </p>
  );
}
