import { useCallback, useEffect, useState } from 'react';
import type { PublishTargetView } from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { InSlot } from '../ui/InSlot.js';
import { AddTargetDialog } from './AddTargetDialog.js';
import { TargetRow } from './TargetRow.js';

/**
 * Published outputs: the publishing targets recipes deliver to (an internal bucket on this
 * deployment's S3, or an external one). `.env` seeds `default` once; what is changed here wins.
 * Admins only.
 */
export function PublishedOutputsPage({
  api,
  me,
  actions,
}: {
  api: Api;
  me: Me;
  /** Where Add target goes (the Administration dialog's header); in place without one. */
  actions?: HTMLElement | null;
}) {
  const [targets, setTargets] = useState<PublishTargetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const isAdmin = me.role === 'admin';

  const load = useCallback(async () => {
    try {
      setTargets(await api.listPublishTargets());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <p>Admins only.</p>;

  return (
    <div className="models-page">
      <p className="muted admin-lead">
        Where published outputs are delivered. A recipe names its publishing target on General, so
        what a recipe delivers to changes only with a new version. .env sets the default target
        once; what you change here wins.
      </p>
      <InSlot slot={actions}>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Add target
        </button>
      </InSlot>
      {error && <p role="alert">{error}</p>}
      {targets === null && !error && <p>Loading…</p>}
      {targets && (
        <section className="admin-section" aria-label="Targets">
          <div className="admin-section-head">
            <div>
              <h3>
                Publishing targets <span className="muted">· {targets.length}</span>
              </h3>
              <p className="muted">Open a target to change its settings or test its connection.</p>
            </div>
          </div>
          <div className="admin-list">
            {targets.map((t) => (
              <TargetRow key={t.id} api={api} target={t} onChanged={load} />
            ))}
          </div>
        </section>
      )}
      {adding && (
        <AddTargetDialog
          api={api}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
