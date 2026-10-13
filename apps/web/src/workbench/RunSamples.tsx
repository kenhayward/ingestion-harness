import type { SampleChoice } from './runs.js';

/** The Samples card (handoff §11): dev samples with tick boxes and the queue line. */
export function RunSamples({
  choices,
  selected,
  onToggle,
  queue,
}: {
  choices: readonly SampleChoice[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  queue: string | null;
}) {
  return (
    <section className="card runs-samples-card" aria-labelledby="runs-samples-title">
      <h3 id="runs-samples-title">Samples</h3>
      {choices.length === 0 ? (
        <p className="muted">No dev samples yet: add some on the Samples tab.</p>
      ) : (
        <ul className="runs-chips">
          {choices.map(({ sample, selectable, reason }) => {
            const on = selectable && selected.has(sample.id);
            return (
              <li key={sample.id}>
                <label
                  className={`run-chip${on ? ' is-on' : ''}${selectable ? '' : ' is-off'}`}
                  title={reason ?? undefined}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!selectable}
                    title={reason ?? undefined}
                    onChange={() => onToggle(sample.id)}
                  />
                  <code>{sample.filename}</code>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {queue && <p className="muted runs-queue">{queue}</p>}
    </section>
  );
}
