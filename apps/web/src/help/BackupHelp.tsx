/** Help topic `backup`: what a backup holds, the key, and the two ways to restore. */
export function BackupHelp() {
  return (
    <>
      <p>
        A backup is one encrypted file that holds everything CT Studio keeps, so you can rebuild it
        after a disaster or move it to another server. You make and restore backups under
        Administration, on the Backup tab.
      </p>

      <h3>What a backup holds</h3>
      <ul>
        <li>
          <strong>The database:</strong> recipes, jobs, users, settings, ontologies and their
          embeddings.
        </li>
        <li>
          <strong>Every stored file:</strong> uploaded documents, outputs, run records and caches,
          and the files in the buckets of internal publishing targets.
        </li>
        <li>
          <strong>The triple store</strong> with the published graphs, when this deployment runs
          one.
        </li>
      </ul>
      <p>
        <strong>Not included:</strong>
      </p>
      <ul>
        <li>
          <code>deploy/.env</code>, which holds the passwords and the key that opens the backup.
        </li>
        <li>The files on external publishing targets: they live outside CT Studio.</li>
        <li>The software itself: a new server needs CT Studio deployed first.</li>
        <li>
          The secrets of data-lake S3 keys. After restoring onto a new server, consumers need new
          keys (see below).
        </li>
      </ul>

      <h3>Encryption and the key</h3>
      <p>
        The file is encrypted with a key made from <code>LLM_SECRETS_KEY</code> in{' '}
        <code>deploy/.env</code>. Without that key the backup is useless, so keep a copy of{' '}
        <code>deploy/.env</code> somewhere other than the server. If you rotate the key, keep the
        old one as <code>LLM_SECRETS_KEY_PREVIOUS</code>: it still opens backups made before the
        rotation.
      </p>

      <h3>Making and downloading a backup</h3>
      <p>
        <em>Create backup</em> runs in the background and shows its progress. Jobs keep running
        meanwhile, so a file added during the backup may be missing from it; a restore lists any
        file it could not find. The server keeps only the newest successful backup, so download it
        and store it safely. A backup that fails leaves the previous one available to download.
      </p>

      <h3>Which restore to choose</h3>
      <p>
        <strong>As this deployment</strong> is for disaster recovery: the same address on new or
        repaired hardware. Everything comes back as it was: users, recipes, jobs, results,
        publishing targets, model endpoints and keys, GitHub sync, linked data settings and
        published graphs. Copy <code>deploy/.env</code> to the server first, deploy the same or a
        newer version of CT Studio, and sign in as the admin from the log.
      </p>
      <p>
        <strong>As a copy</strong> is for a second server that should look like the first without
        acting as it, for example production restored into staging. Paste the source
        deployment&apos;s <code>LLM_SECRETS_KEY</code> when asked; it is used to read the backup and
        never stored.
      </p>

      <h3>What a copy keeps and drops</h3>
      <p>
        <strong>Kept from this server:</strong> its model endpoints, choices and settings, its
        publishing targets, GitHub settings and instance name, its data-lake keys and its base IRI.
      </p>
      <p>
        <strong>Dropped from the backup:</strong>
      </p>
      <ul>
        <li>The recipes&apos; GitHub links and the users&apos; linked GitHub accounts.</li>
        <li>
          External publishing targets are made unusable, and what was delivered to them is hidden as
          withdrawn.
        </li>
        <li>The backup&apos;s model configuration and data-lake keys.</li>
        <li>Queued and running jobs are cancelled. Jobs awaiting review are kept.</li>
      </ul>
      <p>
        <strong>Adjusted for this server:</strong> published graphs are minted again under this
        server&apos;s base IRI (a rebuild runs when you resume the queue), and embeddings are
        refreshed for this server&apos;s embedding model. Users and their passwords come from the
        backup. The report names any recipe that needs a model choice or a publishing target this
        server does not have.
      </p>

      <h3>During a restore</h3>
      <ol>
        <li>
          Choose the file. It uploads in parts; if the upload is interrupted, choose the same file
          again and it carries on.
        </li>
        <li>Pick the mode and, for a copy, paste the source key.</li>
        <li>
          CT Studio checks the whole file before changing anything. A wrong key, a damaged file or a
          backup from a newer CT Studio is refused. A checked restore you do not confirm within 30
          minutes expires; <em>Cancel restore</em> frees it sooner.
        </li>
        <li>Type the instance name to confirm.</li>
      </ol>
      <p>
        While it runs, everyone but admins is held back by maintenance mode and the job queue is
        paused. Running jobs get up to 2 minutes to finish and are then cancelled. The database is
        restored into a second database and swapped in only at the end, so a failure before then
        leaves this server exactly as it was.
      </p>

      <h3>After a restore</h3>
      <ul>
        <li>Everyone is signed out. Sign in again; the report stays on the Backup tab.</li>
        <li>
          The admin-from-the-log token is replaced. The new one is in the API log (or run{' '}
          <code>deploy/scripts/admin-token.sh</code>).
        </li>
        <li>
          Read the report: missing files, recipes needing attention and, after a restore onto a new
          server, the <em>Data-lake keys to re-issue</em>. On the same server, with its storage
          intact, those keys keep working.
        </li>
        <li>
          Maintenance stays on and the queue stays paused. When you are satisfied, resume the queue
          on the Backup tab and switch maintenance off on the Maintenance tab.
        </li>
        <li>
          The previous database is kept under the name in the report. Once you are sure, drop it to
          free the space:{' '}
          <code>docker exec ingestion-postgres-1 dropdb -U &lt;POSTGRES_USER&gt; &lt;name&gt;</code>
        </li>
      </ul>

      <h3>Moving to a new server</h3>
      <ol>
        <li>On the old server, create a backup and download it.</li>
        <li>
          Copy <code>deploy/.env</code> to the new server.
        </li>
        <li>
          Deploy CT Studio there (<code>deploy/scripts/deploy.sh</code>), the same or a newer
          version.
        </li>
        <li>Sign in as the admin with the token in the API log.</li>
        <li>
          Open Administration &gt; Backup, choose <em>Restore…</em> and pick{' '}
          <em>as this deployment</em>.
        </li>
        <li>Check the report, and issue new data-lake keys to the consumers it lists.</li>
        <li>Resume the queue and switch maintenance off.</li>
        <li>Point your DNS at the new server.</li>
      </ol>

      <h3>Size and space</h3>
      <p>
        A restore needs room for the uploaded file, a second copy of the database while it runs (and
        the kept previous one afterwards), and all the files.
      </p>
    </>
  );
}
