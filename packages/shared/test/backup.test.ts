import { describe, expect, it } from 'vitest';
import {
  BackupManifestSchema,
  RestoreStartBodySchema,
  UploadStartBodySchema,
  copyPlan,
} from '../src/backup.js';

const manifest = {
  format: 'ct-backup',
  formatVersion: 1,
  appVersion: '2026.10.17.1',
  commit: null,
  lastMigration: '202610170019_publish_targets',
  migrations: ['0001_init', '202610170019_publish_targets'],
  instanceName: 'default',
  baseIri: 'https://id.example.com/',
  startedAt: '2026-10-17T10:00:00.000Z',
  finishedAt: '2026-10-17T10:05:00.000Z',
  createdBy: 'Admin',
  buckets: [{ role: 'inbox', name: 'inbox', objects: 3, bytes: 1024 }],
  parts: [{ name: 'part-0001', bytes: 1024, sha256: 'a'.repeat(64) }],
  fuseki: false,
  lakeIdentities: 0,
};

describe('backup contract', () => {
  it('parses a valid manifest', () => {
    expect(BackupManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('refuses an unknown manifest key', () => {
    expect(BackupManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
  });

  it('requires a key for a copy restore only', () => {
    const id = '3f2b8c1e-6a4d-4e7b-9c1a-2b3c4d5e6f70';
    const copy = RestoreStartBodySchema.safeParse({ uploadId: id, mode: 'copy' });
    expect(copy.success).toBe(false);
    if (!copy.success) {
      expect(copy.error.issues[0]?.message).toBe(
        'paste the key of the deployment this backup came from',
      );
    }
    expect(RestoreStartBodySchema.safeParse({ uploadId: id, mode: 'deployment' }).success).toBe(
      true,
    );
    expect(RestoreStartBodySchema.safeParse({ uploadId: id, mode: 'copy', key: 'k' }).success).toBe(
      true,
    );
  });

  it('refuses an empty upload', () => {
    expect(UploadStartBodySchema.safeParse({ size: 0, fileName: 'b.zip' }).success).toBe(false);
    expect(UploadStartBodySchema.safeParse({ size: 5, fileName: 'b.zip' }).success).toBe(true);
  });

  it('gives the fixed copy plan', () => {
    const plan = copyPlan();
    expect(plan.dropped).toHaveLength(5);
    expect(plan.kept).toHaveLength(5);
  });
});
