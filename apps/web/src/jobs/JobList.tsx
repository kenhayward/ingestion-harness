import type { JobSummary, ModelChoice } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import { JobActions } from './JobActions.js';
import { jobDuration, jobNote, modelLabel, relativeTime } from './derive.js';

/** Job list (UI handoff §1): the file name selects the row into the detail panel. */
export function JobList({
  api,
  jobs,
  selectedId,
  onSelect,
  onChanged,
  models,
  specTitles,
  typeModels,
  now,
}: {
  api: Api;
  jobs: readonly JobSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  models: readonly ModelChoice[];
  /** Document type titles by id (falls back to the id). */
  specTitles: ReadonlyMap<string, string>;
  /** Each document type's model, by id (unknown types: no name in the dialog). */
  typeModels?: ReadonlyMap<string, { model?: string }>;
  now: number;
}) {
  if (jobs.length === 0) return <p>No jobs yet.</p>;

  return (
    <div className="job-list-box">
      <table className="job-list">
        <thead>
          <tr>
            <th>Document</th>
            <th>Document type · model</th>
            <th>Status</th>
            <th>Created</th>
            <th className="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const selected = job.id === selectedId;
            const note = jobNote(job);
            const took = jobDuration(job, now);
            return (
              <tr key={job.id} className={selected ? 'selected' : undefined}>
                <td className="doc-cell">
                  <button
                    type="button"
                    className="doc-button"
                    aria-label={`Show details for ${job.filename}`}
                    aria-pressed={selected}
                    onClick={() => onSelect(job.id)}
                  >
                    {job.filename}
                  </button>
                  <span className={`note note-${note.tone}`}>{note.text}</span>
                </td>
                <td className="type-cell">
                  <span>
                    {specTitles.get(job.specId) ?? job.specId} v{job.specVersion}
                  </span>
                  <span className="muted">{modelLabel(job, models)}</span>
                </td>
                <td className="status-cell">
                  <StatusPill status={job.status} />
                </td>
                <td className="created-cell">
                  <span title={new Date(job.createdAt).toLocaleString()}>
                    {relativeTime(job.createdAt, now)}
                  </span>
                  {took && (
                    <span
                      className="elapsed"
                      aria-label={`Processing time ${took}`}
                      title="Processing time"
                    >
                      <Icon name="clock" size={12} /> {took}
                    </span>
                  )}
                </td>
                <td className="actions-cell">
                  <JobActions
                    api={api}
                    job={job}
                    onChanged={onChanged}
                    models={models}
                    typeModel={typeModels?.get(job.specId)}
                    variant="row"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
