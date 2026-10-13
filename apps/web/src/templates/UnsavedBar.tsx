/** The Template tab's sticky unsaved bar (handoff §10, 10b): what changed, Discard, Save. */
export function UnsavedBar({
  text,
  version,
  onDiscard,
  onSave,
}: {
  text: string;
  version: number;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="unsaved-bar" role="region" aria-label="Unsaved changes">
      <span className="unsaved-dot" aria-hidden="true" />
      <strong>{text}</strong>
      <span className="muted">Saving marks the latest evaluation out of date.</span>
      <span className="unsaved-actions">
        <button type="button" onClick={onDiscard}>
          Discard
        </button>
        <button type="button" className="primary" onClick={onSave}>
          Save draft v{version}
        </button>
      </span>
    </div>
  );
}
