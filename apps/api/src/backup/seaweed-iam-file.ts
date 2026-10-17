import type { LakeIdentities } from './ports.js';

/**
 * The data lake's `lake-*` identities are not carried in a backup.
 *
 * The plan was to read and write them as one filer file (`/etc/iam/identity.json`). The backup
 * task's spike against SeaweedFS 4.48 found otherwise: the embedded IAM keeps one file per
 * identity (`/etc/iam/identities/<name>.json`, secrets in plain text) and the inline policies in
 * `/etc/iam/policies.json`, and reads them from the filer entry's inline content. A file PUT
 * through the filer's HTTP API is stored in volume chunks instead (with the compose file's
 * settings), so the IAM then reads it as empty, fails every reload ("identity file … is empty")
 * and answers IAM calls with a 500 until the file is removed. Writing them back would break the
 * S3 gateway's IAM, so by the ruling for this case a backup records none (`lakeIdentities` 0) and
 * a restore reports that data-lake keys must be re-issued; the consumers' metadata travels in the
 * database as before.
 */
export class NoLakeIdentities implements LakeIdentities {
  async read(): Promise<unknown[]> {
    return [];
  }

  /** Nothing to write; a backup made by this code never carries any. */
  async replace(entries: unknown[]): Promise<void> {
    if (entries.length > 0) {
      throw new Error('this server cannot restore data-lake identities: re-issue the keys');
    }
  }
}
