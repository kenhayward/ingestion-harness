import { useCallback, useEffect, useRef, useState } from 'react';
import type { SegmentDocument, SegmentationView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';

const MAX_POLLS = 60;
const DONE = new Set(['succeeded', 'failed', 'needs_review', 'cancelled']);

/** Latest-wins segmentation preview: start, poll, and ignore anything superseded. */
export function useSegmentPreview(api: Api, projectId: string, pollMs: number) {
  const [view, setView] = useState<SegmentationView | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => () => void (generation.current += 1), []); // stop polling on unmount

  const preview = useCallback(
    (document?: SegmentDocument) => {
      const mine = ++generation.current;
      const current = () => generation.current === mine;
      setRunning(true);
      setError(null);
      void (async () => {
        try {
          let next = await api.startSegmentation(projectId, document);
          for (let poll = 0; current() && !DONE.has(next.status); poll++) {
            if (poll >= MAX_POLLS) throw new Error('Preview timed out — is the worker running?');
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            if (!current()) return;
            next = await api.getSegmentation(projectId, next.jobId);
          }
          if (!current()) return;
          setView(next);
          if (next.status !== 'succeeded' || !next.result) {
            setError(next.error ?? `preview ${next.status}`);
          }
        } catch (err) {
          if (!current()) return;
          if (err instanceof ApiError && err.status === 404) return; // superseded on the server
          setError((err as Error).message);
        } finally {
          if (current()) setRunning(false);
        }
      })();
    },
    [api, projectId, pollMs],
  );

  return { view, running, error, preview };
}
