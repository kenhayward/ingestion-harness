import type { JobSummary, ModelChoice } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { JobActions } from './JobActions.js';
import { JobStatusIcon } from './JobStatusIcon.js';
import { jobDuration, jobNote, relativeTime } from './derive.js';

/**
 * Job list (Jobs page): one line a job, the status as an icon, the file name (it selects the row
 * into the detail panel) with a note only when the job needs attention, the document type, when
 * it was created and how long it took. Every action is in the row's ⋯ menu and the panel.
 */
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
    <table className="job-list">
      <colgroup>
        <col className="status-col" />
        <col />
        <col className="type-col" />
        <col className="created-col" />
        <col className="took-col" />
        <col className="actions-col" />
      </colgroup>
      <thead className="visually-hidden">
        <tr>
          <th>Status</th>
          <th>Document</th>
          <th>Document type</th>
          <th>Created</th>
          <th>Took</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => {
          const selected = job.id === selectedId;
          const note = jobNote(job);
          const took = jobDuration(job, now);
          return (
            <tr key={job.id} data-job-id={job.id} className={selected ? 'selected' : undefined}>
              <td className="status-cell">
                <JobStatusIcon status={job.status} />
              </td>
              <td
                className="doc-cell"
                title={note.tone === 'muted' ? job.filename : `${job.filename} · ${note.text}`}
              >
                <span className="doc-line">
                  <button
                    type="button"
                    className="doc-button"
                    aria-label={`Show details for ${job.filename}`}
                    aria-pressed={selected}
                    onClick={() => onSelect(job.id)}
                  >
                    {job.filename}
                  </button>
                  {note.tone !== 'muted' && (
                    <span className={`note note-${note.tone}`}>
                      <span aria-hidden="true"> · </span>
                      {note.text}
                    </span>
                  )}
                </span>
              </td>
              <td
                className="type-cell"
                title={`${specTitles.get(job.specId) ?? job.specId} v${job.specVersion}`}
              >
                {specTitles.get(job.specId) ?? job.specId} v{job.specVersion}
              </td>
              <td className="created-cell">
                <span title={new Date(job.createdAt).toLocaleString()}>
                  {relativeTime(job.createdAt, now)}
                </span>
              </td>
              <td className="took-cell">
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
  );
}
