import type { S3KeyService } from './service.js';

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Enforce expiry and finish failed deletes (ADR 0008): SeaweedFS keys don't expire on their own.
 * Runs now and then every `intervalMs`; a failure (SeaweedFS down) is logged and retried next
 * time. Returns a stop function.
 */
export function startReconciler(
  service: Pick<S3KeyService, 'reconcile'>,
  log: Log,
  intervalMs = 60_000,
): () => void {
  const run = async () => {
    try {
      const result = await service.reconcile();
      if (result.deletedKeys || result.deletedUsers) {
        log.info(result, 'S3 key reconcile deleted expired, revoked or unknown keys');
      }
    } catch (err) {
      log.warn({ err }, 'S3 key reconcile failed; retrying next interval');
    }
  };
  const first = setTimeout(() => void run(), 0);
  const timer = setInterval(() => void run(), intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
