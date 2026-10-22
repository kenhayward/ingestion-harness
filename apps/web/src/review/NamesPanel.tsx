import type { DeliveryOverrides, JobNaming } from '@ih/shared';

/** The names a reviewer has typed: per target, per field (the text as it stands). */
export type NameEdits = Record<string, Record<string, string>>;

/**
 * The names the reviewer chose that differ from what the pattern gives: what approve sends as
 * `overrides` (a blank field, or one left as resolved, sends nothing).
 */
export function overridesOf(naming: JobNaming, edits: NameEdits): DeliveryOverrides {
  const out: DeliveryOverrides = {};
  for (const t of naming.targets) {
    for (const f of t.fields) {
      const typed = (edits[t.targetId]?.[f.id] ?? f.override ?? '').trim();
      if (!typed || typed === f.value) continue;
      (out[t.targetId] ??= {})[f.id] = typed;
    }
  }
  return out;
}

/**
 * Names (review screen): what each target that names what it creates will call this document,
 * as its pattern resolves, with the reviewer's own name in its place when typed. A name a target
 * refused (a conflict) is marked so another can be chosen.
 */
export function NamesPanel({
  naming,
  edits,
  onEdit,
}: {
  naming: JobNaming;
  edits: NameEdits;
  onEdit: (targetId: string, fieldId: string, value: string) => void;
}) {
  if (naming.targets.length === 0) return null;
  return (
    <section className="names-panel" aria-label="Names">
      <h2>Names</h2>
      <p className="muted">
        What this document is called where it is delivered. Change one to use your own name.
      </p>
      {naming.targets.map((t) =>
        t.fields.map((f) => {
          const shown = edits[t.targetId]?.[f.id] ?? f.override ?? f.value ?? '';
          return (
            <div className="field" key={`${t.targetId}.${f.id}`}>
              <label>
                {`${t.label}: ${f.label}`}
                <input
                  className={f.conflict ? 'danger-border' : undefined}
                  value={shown}
                  aria-invalid={f.conflict ? true : undefined}
                  onChange={(e) => onEdit(t.targetId, f.id, e.target.value)}
                />
              </label>
              {f.conflict && <small className="field-error">{f.conflict}</small>}
              {f.value === null && f.unresolved.length > 0 && (
                <small className="field-error">
                  {`${f.pattern} resolves to nothing without ${f.unresolved.join(', ')}: enter a name`}
                </small>
              )}
              {f.value !== null && <small className="muted">From {f.pattern}</small>}
            </div>
          );
        }),
      )}
    </section>
  );
}
