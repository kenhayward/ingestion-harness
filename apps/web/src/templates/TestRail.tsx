import { useId, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { isSourceFile, SOURCE_ACCEPT } from '../documents.js';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import { recentTestRuns } from './editor-derive.js';

/**
 * "Test this draft" (UI handoff §5): run the version on a sample PDF or Word document and see
 * recent test runs,
 * each a click from its review. Test runs are reviewable but never published.
 */
export function TestRail({
  api,
  templateId,
  version,
  jobs,
}: {
  api: Api;
  templateId: string;
  version: number;
  jobs: readonly JobSummary[];
}) {
  const inputId = useId();
  const [sample, setSample] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recent = recentTestRuns(jobs, templateId);
  const now = Date.now();

  const choose = (file: File | undefined) => {
    if (!file) return; // picker cancelled: keep the current sample
    if (!isSourceFile(file)) {
      setSample(null);
      setStatus('Choose a PDF or Word document');
      return;
    }
    setSample(file);
    setStatus(null);
  };

  const run = async () => {
    if (!sample) return;
    setBusy(true);
    try {
      const job = await api.testRun(sample, templateId, version);
      setStatus(`Test run queued: ${job.filename}. Review it when it finishes.`);
    } catch (err) {
      setStatus(`Test run failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="test-rail" aria-label="Test this draft">
      <h2>Test this draft</h2>
      <label
        className="drop-zone rail-drop"
        htmlFor={inputId}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          choose(e.dataTransfer.files[0]);
        }}
      >
        <span className="drop-icon" aria-hidden="true">
          <Icon name="upload" size={18} />
        </span>
        <span>
          <strong>{sample ? sample.name : 'Drop a sample PDF or Word document'}</strong> or{' '}
          <span className="link-text">browse</span>
        </span>
        <small>Test runs are reviewable but never published</small>
      </label>
      <input
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={SOURCE_ACCEPT}
        aria-label="Sample document"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="primary block"
        disabled={!sample || busy}
        onClick={() => void run()}
      >
        {sample ? `Run test on ${sample.name}` : 'Run test'}
      </button>
      {status && (
        <p role="status" className="muted">
          {status}
        </p>
      )}
      <h3 className="eyebrow">Recent test runs</h3>
      {recent.length === 0 ? (
        <p className="muted">No test runs yet.</p>
      ) : (
        <ul className="recent-runs" aria-label="Recent test runs">
          {recent.map((j) => (
            <li key={j.id}>
              <span>
                <a href={`#/review/${j.id}`}>{j.filename}</a>
                <small className="muted">{relativeTime(j.createdAt, now)}</small>
              </span>
              <StatusPill status={j.status} />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
