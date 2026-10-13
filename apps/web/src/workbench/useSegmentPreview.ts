import { useCallback, useEffect, useRef, useState } from 'react';
import type { SegmentDocument, SegmentationView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';

export const PREVIEW_DEADLINE_MS = 30_000;
const DONE = new Set(['succeeded', 'failed', 'needs_review', 'cancelled']);

/** Latest-wins segmentation preview: start, poll, and ignore anything superseded. */
export function useSegmentPreview(api: Api, projectId: string, pollMs: number) {
  const [view, setView] = useState<SegmentationView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => () => void (generation.current += 1), []); // stop polling on unmount

  const start = useCallback(
    (document: SegmentDocument | undefined, retried: boolean) => {
      const mine = ++generation.current;
      const current = () => generation.current === mine;
      setRunning(true);
      setError(null);
      void (async () => {
        try {
          const started = Date.now();
          let next = await api.startSegmentation(projectId, document);
          while (current() && !DONE.has(next.status)) {
            if (Date.now() - started > PREVIEW_DEADLINE_MS)
              throw new Error('Preview timed out — is the worker running?');
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            if (!current()) return;
            next = await api.getSegmentation(projectId, next.jobId);
          }
          if (!current()) return;
          setView(next);
          if (next.status !== 'succeeded' || !next.result) {
            setError(
              next.error ??
                (next.status === 'succeeded'
                  ? 'preview finished without a result'
                  : `preview ${next.status}`),
            );
          }
        } catch (err) {
          if (!current()) return;
          if (err instanceof ApiError && err.status === 404) {
            // Still wanted here, yet gone on the server: another request replaced this job.
            if (!retried) {
              start(document, true);
              return;
            }
            setError('Preview was replaced; edit an anchor to try again');
            return;
          }
          setError((err as Error).message);
        } finally {
          if (current()) setRunning(false);
        }
      })();
    },
    [api, projectId, pollMs],
  );
  const preview = useCallback((document?: SegmentDocument) => start(document, false), [start]);

  return { view, running, error, preview };
}
