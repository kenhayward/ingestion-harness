import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../api/client.js';

type Def = Record<string, unknown>;

/**
 * The open draft's definition and, when given, the live (published) one; reload after applying.
 * The two load independently (a failed live fetch keeps the draft), a superseded or
 * post-unmount load never overwrites a newer one, and a change of versions clears both.
 */
export function useDefinitions(
  api: Api,
  projectId: string,
  draft: number | null,
  published: number | null,
  enabled: boolean,
) {
  const [draftDef, setDraftDef] = useState<Def | null>(null);
  const [liveDef, setLiveDef] = useState<Def | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const latest = useRef(0);

  /** Invalidates any load in flight (version change or unmount). */
  const supersede = useCallback(() => {
    latest.current++;
  }, []);

  const reload = useCallback(async (): Promise<Def | null> => {
    if (!enabled || draft === null) return null;
    const id = ++latest.current;
    const [d, l] = await Promise.allSettled([
      api.getTemplate(projectId, draft),
      published === null ? Promise.resolve(null) : api.getTemplate(projectId, published),
    ]);
    if (id !== latest.current) return null;
    if (d.status === 'fulfilled') {
      setDraftDef(d.value.record.definition);
      setError(null);
    } else {
      setDraftDef(null);
      setError((d.reason as Error).message);
    }
    if (l.status === 'fulfilled') {
      setLiveDef(l.value?.record.definition ?? null);
      setLiveError(null);
    } else {
      setLiveDef(null);
      setLiveError((l.reason as Error).message);
    }
    return d.status === 'fulfilled' ? d.value.record.definition : null;
  }, [api, projectId, draft, published, enabled]);

  useEffect(() => {
    setDraftDef(null);
    setLiveDef(null);
    setError(null);
    setLiveError(null);
    void reload();
    return supersede;
  }, [reload, supersede]);

  return { draftDef, liveDef, error, liveError, reload };
}
