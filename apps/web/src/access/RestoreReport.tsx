import type { RestoreReport, RestoreStatus } from '@ih/shared';

/** The check's answer to a key that does not open the file (`BackupKeyError`). */
const KEY_ERROR = 'this key does not open the backup';
const KEY_ERROR_TEXT = 'This key does not open the backup, or the file is damaged.';

const TRIPLES: Record<RestoreReport['triples'], string> = {
  restored: 'The triple store was restored.',
  'none-in-backup': 'The backup has no triple store: rebuild it with rdf_rebuild.',
  'no-triple-store': 'This server has no triple store: graphs were not loaded.',
  reminting: "Graphs are being re-minted under this server's base IRI.",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * How a finished restore ended (succeeded or failed): its error, if any, then its report, if it
 * has one. Shared by the restore dialog and the Backup tab, which shows it after signing in again.
 */
export function RestoreOutcome({ restore }: { restore: RestoreStatus }) {
  const keyRefused = restore.error?.startsWith(KEY_ERROR) ?? false;
  return (
    <>
      {restore.phase === 'failed' && (
        <p role="alert">
          {keyRefused ? KEY_ERROR_TEXT : `The restore failed: ${restore.error ?? 'no reason'}`}
        </p>
      )}
      {restore.report && (
        <RestoreReportView report={restore.report} succeeded={restore.phase === 'succeeded'} />
      )}
    </>
  );
}

/** A restore report: what came back, what to do next, and what the copy rules did. */
export function RestoreReportView({
  report,
  succeeded,
}: {
  report: RestoreReport;
  succeeded: boolean;
}) {
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
