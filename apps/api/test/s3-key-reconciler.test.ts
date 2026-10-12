import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startReconciler } from '../src/s3keys/reconciler.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe('startReconciler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconciles on start and then every interval until stopped', async () => {
    const reconcile = vi.fn(async () => ({ deletedKeys: 0, deletedUsers: 0 }));
    const stop = startReconciler({ reconcile }, log(), 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconcile).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('logs what it deleted, stays quiet when nothing changed', async () => {
    const logger = log();
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce({ deletedKeys: 2, deletedUsers: 1 })
      .mockResolvedValue({ deletedKeys: 0, deletedUsers: 0 });
    const stop = startReconciler({ reconcile }, logger, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { deletedKeys: 2, deletedUsers: 1 },
      'S3 key reconcile deleted expired, revoked or unknown keys',
    );
    stop();
  });

  it('keeps going when SeaweedFS is unreachable', async () => {
    const logger = log();
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValue({ deletedKeys: 1, deletedUsers: 0 });
    const stop = startReconciler({ reconcile }, logger, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
    stop();
  });
});
