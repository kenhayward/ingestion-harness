import type { BackupManifest, BackupView, RestoreReport, RestoreStatus } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupStatus } from '../src/api/client.js';
import { AdminDialog } from '../src/access/AdminDialog.js';
import { BackupPage } from '../src/access/BackupPage.js';
import { RestoreDialog } from '../src/access/RestoreDialog.js';
import { RestoreOutcome } from '../src/access/RestoreReport.js';
import { RESTORE_KEY, UPLOAD_KEY } from '../src/access/backup-upload.js';
import { fakeApi } from './fake-api.js';

const admin = {
  role: 'admin' as const,
  label: 'Ken',
  email: null,
  mustChangePassword: false,
  userId: 'u-test',
};
const designer = { ...admin, role: 'designer' as const, label: 'Dee', userId: 'u-dee' };

function backup(over: Partial<BackupView> = {}): BackupView {
  return {
    id: 'b-1',
    status: 'succeeded',
    startedAt: '2026-10-17T09:00:00.000Z',
    finishedAt: '2026-10-17T09:05:00.000Z',
    createdBy: 'Ken',
    bytes: 3 * 1024 * 1024 * 1024,
    error: null,
    progress: null,
    ...over,
  };
}

const QUEUE = { paused: false, pausedAt: null, pausedBy: null, reason: null };

function status(over: Partial<BackupStatus> = {}): BackupStatus {
  return { backup: null, lastSucceeded: null, restore: null, queue: QUEUE, ...over };
}

const MANIFEST: BackupManifest = {
  format: 'ct-backup',
  formatVersion: 1,
  appVersion: '2026.10.16.3',
  commit: 'abc1234',
  lastMigration: '202610170019_publish_targets.sql',
  migrations: [],
  instanceName: 'production',
  baseIri: 'https://id.example.com/',
  startedAt: '2026-10-16T22:00:00.000Z',
  finishedAt: '2026-10-16T22:10:00.000Z',
  createdBy: 'Ken',
  buckets: [{ role: 'inbox', name: 'ingest-inbox', objects: 120, bytes: 5_000_000 }],
  parts: [{ name: 'database.dump', bytes: 2_000_000, sha256: 'x' }],
  fuseki: true,
  lakeIdentities: 2,
};

function restore(over: Partial<RestoreStatus> = {}): RestoreStatus {
  return {
    id: 'r-1',
    mode: 'deployment',
    phase: 'checking',
    step: null,
    done: 0,
    of: 10,
    manifest: null,
    plan: null,
    error: null,
    report: null,
    startedBy: 'Ken',
    updatedAt: '2026-10-17T10:00:00.000Z',
    ...over,
  };
}

const REPORT: RestoreReport = {
  restored: [
    { table: 'users', rows: 4 },
    { table: 'jobs', rows: 210 },
  ],
  objects: 340,
  missingObjects: [{ bucket: 'ingest-outputs', key: 'job-9/output.csv' }],
  copy: null,
  triples: 'restored',
  previousDatabase: 'ingestion_before_restore_20261017',
  adminTokenRotated: true,
  lakeKeysToReissue: [],
};

describe('BackupPage', () => {
  it('the ? opens Backing up and restoring CT Studio', async () => {
    render(<BackupPage api={fakeApi()} me={admin} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Help: Backing up and restoring CT Studio' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Backing up and restoring CT Studio',
    });
    expect(
      within(dialog).getByRole('heading', { name: 'What a backup holds' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: 'Moving to a new server' }),
    ).toBeInTheDocument();
  });

  it('shows the .env warning', async () => {
    render(<BackupPage api={fakeApi()} me={admin} />);
    expect(
      await screen.findByText(
        'Keep a copy of deploy/.env somewhere other than this server. Without its LLM_SECRETS_KEY this backup cannot be opened.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the latest backup with its Download', async () => {
    const done = backup();
    const api = fakeApi({
      getBackupStatus: vi.fn(async () => status({ backup: done, lastSucceeded: done })),
    });
    render(<BackupPage api={api} me={admin} />);
    const link = await screen.findByRole('link', { name: /Download/ });
    expect(link).toHaveAttribute('href', '/api/backup/backups/b-1/file');
    expect(screen.getByText(/3\.0 GB/)).toBeInTheDocument();
    expect(screen.getByText(/by Ken/)).toBeInTheDocument();
  });

  it('Create backup calls startBackup and shows progress', async () => {
    const running = backup({
      id: 'b-2',
      status: 'running',
      finishedAt: null,
      bytes: null,
      progress: { phase: 'objects', done: 12, of: 40, bytes: 5 * 1024 * 1024 },
    });
    const api = fakeApi({
      startBackup: vi.fn(async () => running),
      getBackupStatus: vi
        .fn()
        .mockResolvedValueOnce(status())
        .mockResolvedValue(status({ backup: running })),
    });
    render(<BackupPage api={api} me={admin} pollMs={5} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(api.startBackup).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Copying files: 12 of 40/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Backup progress: 30%/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create backup' })).toBeDisabled();
  });

  it('shows a refusal to start a backup', async () => {
    const api = fakeApi({
      startBackup: vi.fn(async () => {
        throw new Error('a backup or restore is already running');
      }),
    });
    render(<BackupPage api={api} me={admin} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a backup or restore is already running',
    );
  });

  it('after a failed backup shows its error and keeps the Download of the last good one', async () => {
    const api = fakeApi({
      getBackupStatus: vi.fn(async () =>
        status({
          backup: backup({ id: 'b-3', status: 'failed', error: 'the bucket is unreachable' }),
          lastSucceeded: backup(),
        }),
      ),
    });
    render(<BackupPage api={api} me={admin} />);
    expect(await screen.findByText(/the bucket is unreachable/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      '/api/backup/backups/b-1/file',
    );
  });

  it('shows a paused queue and resumes it', async () => {
    const paused = {
      paused: true,
      pausedAt: '2026-10-17T10:00:00.000Z',
      pausedBy: 'Ken',
      reason: 'restored from backup',
    };
    const api = fakeApi({
      getBackupStatus: vi.fn(async () => status({ queue: paused })),
      setQueuePaused: vi.fn(async () => QUEUE),
    });
    render(<BackupPage api={api} me={admin} />);
    expect(await screen.findByText(/Paused by Ken/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    expect(api.setQueuePaused).toHaveBeenCalledWith(false);
    expect(await screen.findByText(/Running/)).toBeInTheDocument();
  });

  it('points to the Maintenance tab while maintenance is on', async () => {
    const api = fakeApi({
      getMaintenance: vi.fn(async () => ({
        enabled: true,
        message: '',
        since: '2026-10-17T10:00:00.000Z',
        updatedBy: 'Ken',
        updatedAt: '2026-10-17T10:00:00.000Z',
      })),
    });
    const openMaintenance = vi.fn();
    render(<BackupPage api={api} me={admin} onOpenMaintenance={openMaintenance} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Maintenance tab' }));
    expect(openMaintenance).toHaveBeenCalledOnce();
  });

  it('opens the restore dialog', async () => {
    render(<BackupPage api={fakeApi()} me={admin} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restore…' }));
    expect(screen.getByRole('dialog', { name: 'Restore a backup' })).toBeInTheDocument();
  });
});

describe('AdminDialog Backup tab', () => {
  afterEach(() => localStorage.removeItem('ih.adminTab'));

  it('is the last tab, with Create backup in the header', async () => {
    render(<AdminDialog api={fakeApi()} me={admin} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Administration' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Backup' }));
    expect(within(dialog).getByRole('tabpanel')).toHaveAccessibleName('Backup');
    expect(
      await within(dialog.querySelector('header')!).findByRole('button', {
        name: 'Create backup',
      }),
    ).toBeInTheDocument();
  });

  it('designers never see the tab', () => {
    localStorage.setItem('ih.adminTab', 'backup');
    render(<AdminDialog api={fakeApi()} me={designer} onClose={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'Backup' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  });
});

/** A restore dialog whose upload and check go through, then answers `phases` in turn. */
function restoreApi(phases: RestoreStatus[], over: Parameters<typeof fakeApi>[0] = {}) {
  const getRestore = vi.fn();
  for (const p of phases.slice(0, -1)) getRestore.mockResolvedValueOnce(p);
  getRestore.mockResolvedValue(phases.at(-1));
  return fakeApi({
    startUpload: vi.fn(async () => ({
      id: 'up-1',
      size: 10,
      partBytes: 64,
      parts: 1,
      received: [],
    })),
    uploadPart: vi.fn(async () => ({
      id: 'up-1',
      size: 10,
      partBytes: 64,
      parts: 1,
      received: [0],
    })),
    completeUpload: vi.fn(async () => ({ key: 'uploads/up-1.ctbak' })),
    startRestore: vi.fn(async () => ({ status: restore(), token: 'tok-1' })),
    getRestore,
    ...over,
  });
}

const backupFile = () => new File(['0123456789'], 'ct-backup.ctbak', { lastModified: 1000 });

async function chooseAndCheck(mode: 'deployment' | 'copy' = 'deployment', key = '') {
  await userEvent.upload(screen.getByLabelText('Backup file'), backupFile());
  if (mode === 'copy') {
    await userEvent.click(screen.getByRole('radio', { name: /Restore as a copy/ }));
    await userEvent.type(screen.getByLabelText('Key'), key);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Upload and check' }));
}

describe('RestoreDialog', () => {
  afterEach(() => {
    localStorage.removeItem(UPLOAD_KEY);
    sessionStorage.removeItem(RESTORE_KEY);
  });

  it('copy mode needs a key', async () => {
    render(<RestoreDialog api={fakeApi()} onClose={vi.fn()} pollMs={5} />);
    await userEvent.upload(screen.getByLabelText('Backup file'), backupFile());
    const check = screen.getByRole('button', { name: 'Upload and check' });
    expect(check).toBeEnabled();
    expect(screen.queryByLabelText('Key')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: /Restore as a copy/ }));
    const key = screen.getByLabelText('Key');
    expect(key).toHaveAttribute('type', 'password');
    // The key is never stored: no password manager is invited to keep it.
    expect(key).toHaveAttribute('autocomplete', 'new-password');
    expect(key).toHaveAttribute('data-1p-ignore');
    expect(key).toHaveAttribute('data-lpignore', 'true');
    expect(key).toHaveAccessibleDescription(
      /the LLM_SECRETS_KEY of the deployment the backup came from/i,
    );
    expect(check).toBeDisabled();
    await userEvent.type(key, 'c2VjcmV0');
    expect(check).toBeEnabled();
  });

  it('sends the key with a copy restore and follows it with the token', async () => {
    const api = restoreApi([restore({ mode: 'copy', phase: 'checking', done: 3, of: 10 })]);
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck('copy', 'c2VjcmV0');
    await waitFor(() =>
      expect(api.startRestore).toHaveBeenCalledWith({
        uploadId: 'up-1',
        mode: 'copy',
        key: 'c2VjcmV0',
      }),
    );
    expect(await screen.findByText(/Checking the backup/)).toBeInTheDocument();
    expect(api.getRestore).toHaveBeenCalledWith('r-1', 'tok-1');
  });

  it('says a key that does not open the backup', async () => {
    const api = restoreApi([
      restore({ mode: 'copy', phase: 'failed', error: 'this key does not open the backup' }),
    ]);
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck('copy', 'd3Jvbmc=');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This key does not open the backup, or the file is damaged.',
    );
  });

  it('confirm stays disabled until the instance name is typed', async () => {
    const checked = restore({
      mode: 'copy',
      phase: 'checked',
      manifest: MANIFEST,
      plan: { dropped: ['External publishing targets'], kept: ["This server's base IRI"] },
    });
    const api = restoreApi([checked], {
      confirmRestore: vi.fn(async () => restore({ phase: 'restoring', step: 'database' })),
    });
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck('copy', 'c2VjcmV0');
    const name = await screen.findByLabelText('Type production to confirm');
    expect(screen.getByText('2026.10.16.3')).toBeInTheDocument();
    expect(screen.getByText('External publishing targets')).toBeInTheDocument();
    expect(screen.getByText("This server's base IRI")).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Restore' });
    expect(confirm).toBeDisabled();
    await userEvent.type(name, 'producti');
    expect(confirm).toBeDisabled();
    await userEvent.type(name, 'on');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(api.confirmRestore).toHaveBeenCalledWith('r-1', 'production', 'tok-1');
  });

  it('a checked restore can be cancelled', async () => {
    const onClose = vi.fn();
    const api = restoreApi([restore({ phase: 'checked', manifest: MANIFEST })], {
      cancelRestore: vi.fn(async () => undefined),
    });
    render(<RestoreDialog api={api} onClose={onClose} pollMs={5} />);
    await chooseAndCheck();
    await screen.findByLabelText('Type production to confirm');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel restore' }));
    expect(api.cancelRestore).toHaveBeenCalledWith('r-1', 'tok-1');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('cannot be closed while restoring', async () => {
    const onClose = vi.fn();
    const api = restoreApi([restore({ phase: 'restoring', step: 'objects', done: 4, of: 9 })]);
    render(<RestoreDialog api={api} onClose={onClose} pollMs={5} />);
    await chooseAndCheck();
    expect(await screen.findByText(/Restoring files/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close|Cancel/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the report after success', async () => {
    const onSignOut = vi.fn();
    const api = restoreApi([
      restore({ phase: 'restoring', step: 'database', done: 2, of: 9 }),
      restore({ phase: 'succeeded', manifest: MANIFEST, report: REPORT }),
    ]);
    render(<RestoreDialog api={api} onClose={vi.fn()} onSignOut={onSignOut} pollMs={5} />);
    await chooseAndCheck();
    expect(await screen.findByRole('heading', { name: 'Restored' })).toBeInTheDocument();
    expect(screen.getByText(/214 rows in 2 tables/)).toBeInTheDocument();
    expect(screen.getByText(/340 files/)).toBeInTheDocument();
    expect(screen.getByText('ingest-outputs/job-9/output.csv')).toBeInTheDocument();
    expect(screen.getByText(/ingestion_before_restore_20261017/)).toBeInTheDocument();
    expect(
      screen.getByText(/the admin-from-the-log token was rotated: see the API log/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Data-lake keys to re-issue/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('reports a copy, lake keys to re-issue and a token that was not rotated', async () => {
    const report: RestoreReport = {
      ...REPORT,
      missingObjects: [],
      copy: {
        cancelledJobs: 7,
        droppedTargets: ['lake-prod'],
        withdrawnOutputs: 12,
        recipesNeedingModel: ['invoice'],
        recipesNeedingTarget: ['po'],
      },
      adminTokenRotated: false,
      lakeKeysToReissue: ['Finance lake', 'BI'],
    };
    const api = restoreApi([
      restore({ mode: 'copy', phase: 'failed', error: 'rotating failed', report }),
    ]);
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck('copy', 'c2VjcmV0');
    expect(await screen.findByText(/rotating failed/)).toBeInTheDocument();
    expect(screen.getByText('Data-lake keys to re-issue: Finance lake, BI')).toBeInTheDocument();
    expect(screen.getByText(/token was NOT rotated/)).toBeInTheDocument();
    expect(screen.getByText(/7 queued or running jobs cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/lake-prod/)).toBeInTheDocument();
    expect(screen.getByText(/invoice/)).toBeInTheDocument();
  });

  it('notes an interrupted upload of the same file', async () => {
    const f = backupFile();
    localStorage.setItem(
      UPLOAD_KEY,
      JSON.stringify({ id: 'up-1', name: f.name, size: f.size, lastModified: f.lastModified }),
    );
    const api = fakeApi({
      getUpload: vi.fn(async () => ({
        id: 'up-1',
        size: 10,
        partBytes: 4,
        parts: 3,
        received: [0],
      })),
    });
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    expect(await screen.findByText(/ct-backup\.ctbak was partly uploaded/)).toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText('Backup file'), f);
    expect(screen.getByText(/continues where it stopped/)).toBeInTheDocument();
  });

  it('does not call a complete upload partly uploaded', async () => {
    const f = backupFile();
    localStorage.setItem(
      UPLOAD_KEY,
      JSON.stringify({ id: 'up-1', name: f.name, size: f.size, lastModified: f.lastModified }),
    );
    const api = fakeApi({
      getUpload: vi.fn(async () => ({
        id: 'up-1',
        size: 10,
        partBytes: 4,
        parts: 3,
        received: [0, 1, 2],
      })),
    });
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await waitFor(() => expect(api.getUpload).toHaveBeenCalledWith('up-1'));
    await userEvent.upload(screen.getByLabelText('Backup file'), f);
    expect(screen.getByText(/already uploaded/)).toBeInTheDocument();
    expect(screen.queryByText(/partly uploaded/)).toBeNull();
  });

  it('forgets the upload once a restore from it succeeded', async () => {
    const api = restoreApi([restore({ phase: 'succeeded', manifest: MANIFEST, report: REPORT })]);
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck();
    await screen.findByRole('heading', { name: 'Restored' });
    expect(localStorage.getItem(UPLOAD_KEY)).toBeNull();
    expect(sessionStorage.getItem(RESTORE_KEY)).toBeNull();
  });

  it('keeps the upload after a failed check, to check it again', async () => {
    const api = restoreApi([
      restore({ phase: 'failed', error: 'this key does not open the backup' }),
    ]);
    render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck();
    await screen.findByRole('alert');
    expect(JSON.parse(localStorage.getItem(UPLOAD_KEY)!)).toMatchObject({ id: 'up-1' });
  });
});

describe('a restore that ended the session', () => {
  afterEach(() => {
    localStorage.removeItem(UPLOAD_KEY);
    sessionStorage.removeItem(RESTORE_KEY);
    localStorage.removeItem('ih.adminTab');
  });

  it('is followed again after the Backup tab is mounted again', async () => {
    const api = restoreApi([restore({ phase: 'restoring', step: 'swap', done: 7, of: 9 })]);
    const first = render(<RestoreDialog api={api} onClose={vi.fn()} pollMs={5} />);
    await chooseAndCheck();
    await screen.findByText(/Switching to the restored database/);
    expect(JSON.parse(sessionStorage.getItem(RESTORE_KEY)!)).toEqual({
      restoreId: 'r-1',
      token: 'tok-1',
      uploadId: 'up-1',
    });
    // The swap ended the session: the app unmounted everything; the admin signs in again.
    first.unmount();
    vi.mocked(api.getRestore).mockReset();
    vi.mocked(api.getRestore)
      .mockResolvedValueOnce(restore({ phase: 'restoring', step: 'finishing', done: 8, of: 9 }))
      .mockResolvedValue(restore({ phase: 'succeeded', manifest: MANIFEST, report: REPORT }));
    render(<BackupPage api={api} me={admin} pollMs={5} />);
    const dialog = await screen.findByRole('dialog', { name: 'Restore a backup' });
    expect(await within(dialog).findByText(/Finishing/)).toBeInTheDocument();
    expect(api.getRestore).toHaveBeenCalledWith('r-1', 'tok-1');
    expect(await within(dialog).findByRole('heading', { name: 'Restored' })).toBeInTheDocument();
    expect(sessionStorage.getItem(RESTORE_KEY)).toBeNull();
    expect(localStorage.getItem(UPLOAD_KEY)).toBeNull();
  });

  it('shows its report on the Backup tab once it succeeded', async () => {
    sessionStorage.setItem(
      RESTORE_KEY,
      JSON.stringify({ restoreId: 'r-1', token: 'tok-1', uploadId: 'up-1' }),
    );
    localStorage.setItem(
      UPLOAD_KEY,
      JSON.stringify({ id: 'up-1', name: 'b.ctbak', size: 10, lastModified: 1 }),
    );
    const done = restore({ phase: 'succeeded', manifest: MANIFEST, report: REPORT });
    const api = fakeApi({
      getBackupStatus: vi.fn(async () => status({ restore: done })),
      getRestore: vi.fn(async () => done),
    });
    localStorage.setItem('ih.adminTab', 'backup');
    render(<AdminDialog api={api} me={admin} onClose={vi.fn()} />);
    const last = await screen.findByRole('group', { name: 'Last restore' });
    expect(within(last).getByRole('heading', { name: 'Restored' })).toBeInTheDocument();
    expect(within(last).getByText(/ingestion_before_restore_20261017/)).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(RESTORE_KEY)).toBeNull());
    expect(localStorage.getItem(UPLOAD_KEY)).toBeNull();
  });

  it('shows the error of a restore that failed', async () => {
    const api = fakeApi({
      getBackupStatus: vi.fn(async () =>
        status({
          restore: restore({
            phase: 'failed',
            error: 'the check expired: start the restore again',
          }),
        }),
      ),
    });
    render(<BackupPage api={api} me={admin} />);
    const last = await screen.findByRole('group', { name: 'Last restore' });
    expect(within(last).getByRole('alert')).toHaveTextContent(
      'the check expired: start the restore again',
    );
  });
});

describe('RestoreOutcome', () => {
  const MAINTENANCE = /Maintenance mode is on and the job queue is paused/;

  it('says a rebuild job reloads the graphs once the queue is resumed', () => {
    render(
      <RestoreOutcome
        restore={restore({ phase: 'succeeded', report: { ...REPORT, triples: 'none-in-backup' } })}
      />,
    );
    expect(
      screen.getByText(
        'The backup has no triple store: a rebuild job reloads the graphs once the job queue is resumed.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/rdf_rebuild/)).toBeNull();
  });

  it('says graphs are re-minted once the queue is resumed', () => {
    render(
      <RestoreOutcome
        restore={restore({ phase: 'succeeded', report: { ...REPORT, triples: 'reminting' } })}
      />,
    );
    expect(screen.getByText(/re-minted under this server's base IRI/)).toHaveTextContent(
      /once the job queue is resumed/,
    );
  });

  it('a restore that failed before changing anything says nothing of maintenance', () => {
    render(
      <RestoreOutcome
        restore={restore({ phase: 'failed', step: null, error: 'a database named x exists' })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('a database named x exists');
    expect(screen.queryByText(MAINTENANCE)).toBeNull();
  });

  it('a restore that failed after it started says maintenance is on and the queue paused', () => {
    render(
      <RestoreOutcome restore={restore({ phase: 'failed', step: 'objects', error: 'boom' })} />,
    );
    expect(screen.getByText(MAINTENANCE)).toBeInTheDocument();
  });

  it('a report says maintenance is on and the queue paused', () => {
    render(<RestoreOutcome restore={restore({ phase: 'succeeded', report: REPORT })} />);
    expect(screen.getByText(MAINTENANCE)).toBeInTheDocument();
  });
});
