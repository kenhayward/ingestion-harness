import type { UploadView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';

/** Where the browser remembers the upload in progress, so the same file resumes it. */
export const UPLOAD_KEY = 'ih.backupUpload';
/** Tries per part after the first one fails. */
const RETRIES = 3;

interface StoredUpload {
  id: string;
  name: string;
  size: number;
  lastModified: number;
}

function readStored(): StoredUpload | null {
  try {
    const raw = localStorage.getItem(UPLOAD_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<StoredUpload>) : null;
    return value && typeof value.id === 'string' ? (value as StoredUpload) : null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredUpload): void {
  try {
    localStorage.setItem(UPLOAD_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: an interrupted upload starts again from the first part.
  }
}

/** The remembered upload of this very file (name, size and date), else null. */
export function storedUploadFor(file: File): string | null {
  const stored = readStored();
  return stored &&
    stored.name === file.name &&
    stored.size === file.size &&
    stored.lastModified === file.lastModified
    ? stored.id
    : null;
}

/** A size for backups, which run to gigabytes. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Uploads a backup file in parts and joins them, answering the upload id to restore from. An
 * upload of the same file this browser started before is resumed: the parts the server already
 * has are not sent again. A part that fails is tried again three times.
 */
export async function uploadBackup(
  api: Api,
  file: File,
  opts: {
    resumeId?: string;
    onProgress: (sent: number, total: number) => void;
    /** Stops between parts (the dialog was closed). */
    signal?: AbortSignal;
    /** Pause before trying a part again. */
    retryDelayMs?: number;
  },
): Promise<string> {
  const resumeId = opts.resumeId ?? storedUploadFor(file);
  let upload: UploadView | null = null;
  if (resumeId) {
    try {
      upload = await api.getUpload(resumeId);
    } catch (err) {
      // Gone (replaced by another upload, or cleaned up): start again.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  if (!upload || upload.size !== file.size) {
    upload = await api.startUpload({ size: file.size, fileName: file.name });
  }
  const { id, partBytes, parts } = upload;
  writeStored({ id, name: file.name, size: file.size, lastModified: file.lastModified });

  const have = new Set(upload.received);
  const partSize = (n: number) => Math.min(partBytes, file.size - n * partBytes);
  let sent = [...have].reduce((sum, n) => sum + partSize(n), 0);
  opts.onProgress(sent, file.size);

  for (let n = 0; n < parts; n++) {
    if (have.has(n)) continue;
    opts.signal?.throwIfAborted();
    const blob = file.slice(n * partBytes, n * partBytes + partSize(n));
    for (let attempt = 0; ; attempt++) {
      try {
        await api.uploadPart(id, n, blob, (part) => opts.onProgress(sent + part, file.size));
        break;
      } catch (err) {
        if (attempt >= RETRIES || opts.signal?.aborted) throw err;
        await wait(opts.retryDelayMs ?? 2000);
      }
    }
    sent += blob.size;
    opts.onProgress(sent, file.size);
  }
  await api.completeUpload(id);
  return id;
}
