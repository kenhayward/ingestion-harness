import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api/client.js';

type Def = Record<string, unknown>;

/** The open draft's definition and, when given, the live (published) one; reload after applying. */
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

  const reload = useCallback(async (): Promise<Def | null> => {
    if (!enabled || draft === null) return null;
    try {
      const [d, l] = await Promise.all([
        api.getTemplate(projectId, draft),
        published === null ? Promise.resolve(null) : api.getTemplate(projectId, published),
      ]);
      setDraftDef(d.record.definition);
      setLiveDef(l?.record.definition ?? null);
      setError(null);
      return d.record.definition;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [api, projectId, draft, published, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { draftDef, liveDef, error, reload };
}
