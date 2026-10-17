import type { UploadView } from '@ih/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_KEY, storedUploadFor, uploadBackup } from '../src/access/backup-upload.js';
import { fakeApi } from './fake-api.js';

/** Ten bytes in parts of four: parts 0, 1 and 2 (the last one two bytes). */
const file = () => new File(['0123456789'], 'ct-backup.ctbak', { lastModified: 1000 });

const view = (received: number[]): UploadView => ({
  id: 'up-1',
  size: 10,
  partBytes: 4,
  parts: 3,
  received,
});

const remember = (f: File, id = 'up-1') =>
  localStorage.setItem(
    UPLOAD_KEY,
    JSON.stringify({ id, name: f.name, size: f.size, lastModified: f.lastModified }),
  );

describe('uploadBackup', () => {
  afterEach(() => localStorage.removeItem(UPLOAD_KEY));

  it('starts an upload, sends every part, completes it and remembers its id', async () => {
    const api = fakeApi({
      startUpload: vi.fn(async () => view([])),
      uploadPart: vi.fn(async (_id: string, n: number) => view([n])),
      completeUpload: vi.fn(async () => ({ key: 'uploads/up-1.ctbak' })),
    });
    const f = file();
    const progress = vi.fn();
    expect(await uploadBackup(api, f, { onProgress: progress, retryDelayMs: 0 })).toBe('up-1');
    expect(api.startUpload).toHaveBeenCalledWith({ size: 10, fileName: 'ct-backup.ctbak' });
    const calls = vi.mocked(api.uploadPart).mock.calls;
    expect(calls.map(([, n, blob]) => [n, blob.size])).toEqual([
      [0, 4],
      [1, 4],
      [2, 2],
    ]);
    expect(api.completeUpload).toHaveBeenCalledWith('up-1');
    expect(progress).toHaveBeenLastCalledWith(10, 10);
    expect(storedUploadFor(f)).toBe('up-1');
  });

  it('skips parts the server has', async () => {
    const f = file();
    remember(f);
    const api = fakeApi({
      getUpload: vi.fn(async () => view([0, 2])),
      uploadPart: vi.fn(async () => view([0, 1, 2])),
      completeUpload: vi.fn(async () => ({ key: 'uploads/up-1.ctbak' })),
    });
    const progress = vi.fn();
    expect(await uploadBackup(api, f, { onProgress: progress, retryDelayMs: 0 })).toBe('up-1');
    expect(api.startUpload).not.toHaveBeenCalled();
    expect(api.getUpload).toHaveBeenCalledWith('up-1');
    const calls = vi.mocked(api.uploadPart).mock.calls;
    expect(calls.map(([id, n]) => [id, n])).toEqual([['up-1', 1]]);
    // The parts already there count as sent from the start.
    expect(progress).toHaveBeenCalledWith(6, 10);
    expect(progress).toHaveBeenLastCalledWith(10, 10);
  });

  it('starts again when the remembered upload is gone or was for another file', async () => {
    const f = file();
    remember(new File(['other'], 'other.ctbak', { lastModified: 5 }), 'up-old');
    const api = fakeApi({
      startUpload: vi.fn(async () => view([])),
      uploadPart: vi.fn(async (_id: string, n: number) => view([n])),
      completeUpload: vi.fn(async () => ({ key: 'k' })),
    });
    await uploadBackup(api, f, { onProgress: vi.fn(), retryDelayMs: 0 });
    expect(api.getUpload).not.toHaveBeenCalled();
    expect(api.startUpload).toHaveBeenCalledOnce();
  });

  it('retries a failing part', async () => {
    let failures = 2;
    const api = fakeApi({
      startUpload: vi.fn(async () => view([])),
      uploadPart: vi.fn(async (_id: string, n: number) => {
        if (n === 1 && failures-- > 0) throw new Error('upload failed: the connection was lost');
        return view([n]);
      }),
      completeUpload: vi.fn(async () => ({ key: 'k' })),
    });
    expect(await uploadBackup(api, file(), { onProgress: vi.fn(), retryDelayMs: 0 })).toBe('up-1');
    const parts = vi.mocked(api.uploadPart).mock.calls.map(([, n]) => n);
    expect(parts).toEqual([0, 1, 1, 1, 2]);
  });

  it('gives up on a part after three retries', async () => {
    const api = fakeApi({
      startUpload: vi.fn(async () => view([])),
      uploadPart: vi.fn(async () => {
        throw new Error('upload failed: the connection was lost');
      }),
    });
    await expect(
      uploadBackup(api, file(), { onProgress: vi.fn(), retryDelayMs: 0 }),
    ).rejects.toThrow('upload failed: the connection was lost');
    expect(api.uploadPart).toHaveBeenCalledTimes(4);
    expect(api.completeUpload).not.toHaveBeenCalled();
  });
});
