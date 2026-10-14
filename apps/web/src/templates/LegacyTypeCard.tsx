import { useId } from 'react';
import { Icon } from '../ui/Icon.js';
import { versionsText, type LegacyType } from './legacy.js';

/**
 * A legacy file-only `spec.yaml` document type (D16): read-only here (its files live in the
 * repository's `specs/` folder), so no editor, test run, Workbench or export. Admins get
 * *Retire…*.
 */
export function LegacyTypeCard({
  item,
  onRetire,
}: {
  item: LegacyType;
  /** Admins only: opens the retire confirm. */
  onRetire?: () => void;
}) {
  const titleId = useId();
  return (
    <article className="type-card" aria-labelledby={titleId}>
      <div className="type-card-head">
        <span className="type-icon" aria-hidden="true">
          <Icon name="types" size={20} />
        </span>
        <div>
          <h2 id={titleId}>{item.title}</h2>
          <span className="mono muted">{item.id}</span>
        </div>
      </div>
      <div className="pills">
        <span className="pill tone-neutral">Legacy spec (file)</span>
        <span className="pill tone-ok">{versionsText(item.versions)}</span>
      </div>
      {item.description && <p className="shape-line">{item.description}</p>}
      <p className="shape-line muted">
        Defined by spec.yaml files in the repository: read-only here.
      </p>
      {onRetire && (
        <div className="card-actions">
          <button type="button" onClick={onRetire}>
            Retire…
          </button>
        </div>
      )}
    </article>
  );
}
